import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { logActivity } from "../activity.ts";
import { one, q } from "../db.ts";
import { assertCandidateAccess, HttpError, isUuid, requirePerm } from "../http.ts";
import { busyFor, cancelInterview, createInterview } from "../scheduling.ts";

const NewInterview = z.object({
  candidateId: z.string().uuid(),
  title: z.string().trim().min(1).max(120),
  type: z.enum(["phone", "video", "onsite"]),
  start: z.string().datetime({ offset: true }),
  durationMin: z.number().int().min(5).max(480),
  interviewerIds: z.array(z.string().uuid()).min(1).max(10),
  location: z.string().max(200).optional(),
  notify: z.boolean().optional(),
});

export default async function interviewRoutes(app: FastifyInstance) {
  app.post("/api/interviews", async (req) => {
    const user = requirePerm(req, "interviews.schedule");
    const body = NewInterview.parse(req.body);
    const id = await createInterview({
      candidateId: body.candidateId,
      title: body.title,
      type: body.type,
      start: new Date(body.start),
      durationMin: body.durationMin,
      interviewerIds: body.interviewerIds,
      location: body.location,
      notifyCandidate: !!body.notify,
      actorId: user.id,
    });
    return { id };
  });

  app.patch("/api/interviews/:id", async (req) => {
    const user = requirePerm(req, "interviews.feedback");
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw new HttpError(404, "Not found");
    const { status } = z.object({ status: z.enum(["scheduled", "completed", "cancelled", "no_show"]) }).parse(req.body);
    const iv = await one<{ interviewer_ids: string[]; candidate_id: string; title: string }>("select interviewer_ids, candidate_id, title from interviews where id = $1", [id]);
    if (!iv) throw new HttpError(404, "Not found");
    // Interviewers can mark their own interviews completed / no-show; cancelling needs scheduling rights.
    if (status === "cancelled" || !iv.interviewer_ids.includes(user.id)) requirePerm(req, "interviews.schedule");
    if (status === "cancelled") await cancelInterview(id);
    await q("update interviews set status = $2 where id = $1", [id, status]);
    if (status === "cancelled") await logActivity(user.id, "interview_scheduled", `cancelled ${iv.title.toLowerCase()}`, iv.candidate_id);
    return { ok: true };
  });

  app.post("/api/interviews/:id/feedback", async (req) => {
    const user = requirePerm(req, "interviews.feedback");
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw new HttpError(404, "Not found");
    const body = z.object({ recommendation: z.enum(["strong_yes", "yes", "no", "strong_no"]), comment: z.string().trim().min(1).max(5000) }).parse(req.body);
    const iv = await one<{ candidate_id: string; title: string; status: string }>("select candidate_id, title, status from interviews where id = $1", [id]);
    if (!iv) throw new HttpError(404, "Not found");
    await assertCandidateAccess(user, iv.candidate_id);
    await q("insert into interview_feedback (interview_id, author_id, recommendation, comment) values ($1, $2, $3, $4)", [id, user.id, body.recommendation, body.comment]);
    if (iv.status === "scheduled") await q("update interviews set status = 'completed' where id = $1 and start_at < now()", [id]);
    await logActivity(user.id, "note", `submitted feedback (${body.recommendation.replace("_", " ")}) for ${iv.title.toLowerCase()}`, iv.candidate_id);
    return { ok: true };
  });

  /** Free/busy for the interview picker. */
  app.get("/api/calendar/busy", async (req) => {
    requirePerm(req, "interviews.schedule");
    const { users, from, to } = req.query as { users?: string; from?: string; to?: string };
    const ids = (users ?? "").split(",").filter(isUuid).slice(0, 10);
    const start = new Date(from ?? Date.now());
    const end = new Date(to ?? start.getTime() + 86400_000);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end.getTime() - start.getTime() > 31 * 86400_000) throw new HttpError(400, "Bad range");
    return busyFor(ids, start, end);
  });
}
