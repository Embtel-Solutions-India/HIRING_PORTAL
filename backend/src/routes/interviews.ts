import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { logActivity } from "../activity.ts";
import { prisma } from "../db.ts";
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
    const iv = await prisma.interviews.findUnique({ where: { id }, select: { interviewer_ids: true, candidate_id: true, title: true } });
    if (!iv) throw new HttpError(404, "Not found");
    // Interviewers can mark their own interviews completed / no-show; cancelling needs scheduling rights.
    if (status === "cancelled" || !iv.interviewer_ids.includes(user.id)) requirePerm(req, "interviews.schedule");
    if (status === "cancelled") await cancelInterview(id);
    await prisma.interviews.updateMany({ where: { id }, data: { status } });
    if (status === "cancelled") await logActivity(user.id, "interview_scheduled", `cancelled ${iv.title.toLowerCase()}`, iv.candidate_id);
    return { ok: true };
  });

  app.post("/api/interviews/:id/feedback", async (req) => {
    const user = requirePerm(req, "interviews.feedback");
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw new HttpError(404, "Not found");
    const body = z.object({ recommendation: z.enum(["strong_yes", "yes", "no", "strong_no"]), comment: z.string().trim().min(1).max(5000) }).parse(req.body);
    const iv = await prisma.interviews.findUnique({ where: { id }, select: { candidate_id: true, title: true, status: true } });
    if (!iv) throw new HttpError(404, "Not found");
    await assertCandidateAccess(user, iv.candidate_id);
    await prisma.interview_feedback.create({ data: { interview_id: id, author_id: user.id, recommendation: body.recommendation, comment: body.comment } });
    if (iv.status === "scheduled") await prisma.interviews.updateMany({ where: { id, start_at: { lt: new Date() } }, data: { status: "completed" } });
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
