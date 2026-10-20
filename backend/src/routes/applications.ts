import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { can } from "../../../frontend/src/lib/permissions.ts";
import { moveApplications, updateApplication } from "../applications.ts";
import { Prisma, prisma } from "../db.ts";
import { createCampaign } from "../email.ts";
import { assertCandidateAccess, HttpError, isUuid, requirePerm } from "../http.ts";
import { enqueueParse } from "../pipeline.ts";

const MoveBody = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  stageId: z.string(),
  notify: z.boolean().optional(),
  reasonId: z.string().max(64).nullish(),
  note: z.string().max(1000).nullish(),
});
const PatchBody = z.object({ rating: z.number().int().min(0).max(5), starred: z.boolean(), ownerId: z.string().uuid().nullable(), jobId: z.string().uuid().nullable() }).partial();

async function loadApplication(id: string) {
  if (!isUuid(id)) throw new HttpError(404, "Not found");
  const a = await prisma.applications.findUnique({ where: { id }, select: { id: true, candidate_id: true } });
  if (!a) throw new HttpError(404, "Not found");
  return a;
}

export default async function applicationRoutes(app: FastifyInstance) {
  app.post("/api/applications/move", async (req) => {
    const user = requirePerm(req, "candidates.moveStage");
    const body = MoveBody.parse(req.body);
    if (!can(user.role, "candidates.viewAll")) {
      const owners = await prisma.applications.findMany({ where: { id: { in: body.ids } }, distinct: ["candidate_id"], select: { candidate_id: true } });
      for (const o of owners) await assertCandidateAccess(user, o.candidate_id);
    }
    const moved = await moveApplications({ ids: body.ids, stageId: body.stageId, actorId: user.id, reasonId: body.reasonId, note: body.note });
    let emailed = 0;
    const stage = await prisma.stages.findUnique({ where: { id: body.stageId }, select: { auto_email_template_id: true } });
    if (body.notify && stage?.auto_email_template_id && moved.length && can(user.role, moved.length > 1 ? "emails.sendBulk" : "emails.sendSingle")) {
      const t = await prisma.email_templates.findUnique({ where: { id: stage.auto_email_template_id } });
      if (t) {
        await createCampaign({ recipients: moved.map((m) => ({ candidateId: m.candidateId, applicationId: m.id })), subject: t.subject, body: t.body, templateId: t.id, actorId: user.id });
        emailed = moved.length;
      }
    }
    return { moved: moved.length, emailed };
  });

  app.patch("/api/applications/:id", async (req) => {
    const body = PatchBody.parse(req.body);
    const user = "ownerId" in body || "jobId" in body ? requirePerm(req, "candidates.edit") : requirePerm(req, "candidates.addNote");
    const a = await loadApplication((req.params as { id: string }).id);
    await assertCandidateAccess(user, a.candidate_id);
    await updateApplication(a.id, body, user.id);
    return { ok: true };
  });

  /** Re-reads the person's resume and re-scores their open applications. */
  app.post("/api/applications/:id/resummarize", async (req) => {
    const user = requirePerm(req, "candidates.edit");
    const a = await loadApplication((req.params as { id: string }).id);
    await assertCandidateAccess(user, a.candidate_id);
    // A cleared summary gets re-scored even on a finished application.
    await prisma.applications.updateMany({ where: { id: a.id }, data: { summary: Prisma.DbNull } });
    await prisma.candidates.updateMany({ where: { id: a.candidate_id }, data: { parse_status: "pending" } });
    enqueueParse(a.candidate_id);
    return { ok: true };
  });
}
