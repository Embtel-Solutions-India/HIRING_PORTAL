import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { can } from "../../../frontend/src/lib/permissions.ts";
import type { ResumeFile } from "../../../frontend/src/types.ts";
import { logActivity } from "../activity.ts";
import { one, q } from "../db.ts";
import { createCampaign } from "../email.ts";
import { assertCandidateAccess, HttpError, isUuid, requirePerm } from "../http.ts";
import { createCandidate, enqueueParse } from "../pipeline.ts";
import { docxToHtml } from "../resume.ts";
import { readResume, storeResume } from "../storage.ts";

const MoveBody = z.object({ ids: z.array(z.string().uuid()).min(1).max(500), stageId: z.string(), notify: z.boolean().optional() });
const PatchBody = z
  .object({
    rating: z.number().int().min(0).max(5),
    starred: z.boolean(),
    tags: z.array(z.string().max(40)).max(20),
    ownerId: z.string().uuid().nullable(),
    jobId: z.string().uuid(),
    firstName: z.string().max(100),
    lastName: z.string().max(100),
    email: z.string().max(200),
    phone: z.string().max(50),
    location: z.string().max(120),
  })
  .partial();

const fullName = (c: { first_name: string; last_name: string }) => `${c.first_name} ${c.last_name}`.trim();

export default async function candidateRoutes(app: FastifyInstance) {
  app.post("/api/candidates/move", async (req) => {
    const user = requirePerm(req, "candidates.moveStage");
    const body = MoveBody.parse(req.body);
    const stage = await one<{ id: string; name: string; auto_email_template_id: string | null }>("select * from stages where id = $1", [body.stageId]);
    if (!stage) throw new HttpError(400, "Unknown stage");
    const moved = await q<{ id: string; first_name: string; last_name: string }>(
      "update candidates set stage_id = $1, stage_entered_at = now() where id = any($2::uuid[]) and stage_id <> $1 returning id, first_name, last_name",
      [stage.id, body.ids],
    );
    for (const c of moved) await logActivity(user.id, "stage_change", `moved ${fullName(c)} to ${stage.name}`, c.id);
    let emailed = 0;
    if (body.notify && stage.auto_email_template_id && moved.length && can(user.role, moved.length > 1 ? "emails.sendBulk" : "emails.sendSingle")) {
      const t = await one<{ id: string; subject: string; body: string }>("select * from email_templates where id = $1", [stage.auto_email_template_id]);
      if (t) {
        await createCampaign({ recipientIds: moved.map((m) => m.id), subject: t.subject, body: t.body, templateId: t.id, actorId: user.id });
        emailed = moved.length;
      }
    }
    return { moved: moved.length, emailed };
  });

  app.patch("/api/candidates/:id", async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw new HttpError(404, "Not found");
    const body = PatchBody.parse(req.body);
    const profileKeys = ["ownerId", "jobId", "firstName", "lastName", "email", "phone", "location", "tags"] as const;
    const user = profileKeys.some((k) => k in body) ? requirePerm(req, "candidates.edit") : requirePerm(req, "candidates.addNote");
    await assertCandidateAccess(user, id);
    const cols: Record<string, string> = { rating: "rating", starred: "starred", tags: "tags", ownerId: "owner_id", jobId: "job_id", firstName: "first_name", lastName: "last_name", email: "email", phone: "phone", location: "location" };
    const entries = Object.entries(body).filter(([k]) => k in cols);
    if (!entries.length) return { ok: true };
    const sets = entries.map(([k], i) => `${cols[k]} = $${i + 2}`).join(", ");
    await q(`update candidates set ${sets} where id = $1`, [id, ...entries.map(([, v]) => v)]);
    return { ok: true };
  });

  app.post("/api/candidates/:id/notes", async (req) => {
    const user = requirePerm(req, "candidates.addNote");
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw new HttpError(404, "Not found");
    await assertCandidateAccess(user, id);
    const { body } = z.object({ body: z.string().trim().min(1).max(5000) }).parse(req.body);
    const c = await one<{ first_name: string; last_name: string }>("select first_name, last_name from candidates where id = $1", [id]);
    await q("insert into notes (candidate_id, author_id, body) values ($1, $2, $3)", [id, user.id, body]);
    await logActivity(user.id, "note", `added a note on ${fullName(c!)}`, id);
    return { ok: true };
  });

  app.post("/api/candidates/delete", async (req) => {
    const user = requirePerm(req, "candidates.delete");
    const { ids } = z.object({ ids: z.array(z.string().uuid()).min(1) }).parse(req.body);
    const rows = await q<{ id: string }>("delete from candidates where id = any($1::uuid[]) returning id", [ids]);
    await logActivity(user.id, "settings_changed", `deleted ${rows.length} candidate${rows.length === 1 ? "" : "s"} (resumes kept in Drive)`);
    return { deleted: rows.length };
  });

  app.post("/api/candidates/:id/resummarize", async (req) => {
    requirePerm(req, "candidates.edit");
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw new HttpError(404, "Not found");
    await q("update candidates set parse_status = 'pending' where id = $1", [id]);
    enqueueParse(id);
    return { ok: true };
  });

  // ---------- resume files ----------

  async function loadResume(reqUser: Parameters<typeof assertCandidateAccess>[0], id: string) {
    if (!isUuid(id)) throw new HttpError(404, "Not found");
    await assertCandidateAccess(reqUser, id);
    const c = await one<{ resume: ResumeFile | null }>("select resume from candidates where id = $1", [id]);
    if (!c?.resume?.driveFileId) throw new HttpError(404, "No resume on file");
    return c.resume;
  }

  app.get("/api/candidates/:id/resume/preview", async (req, reply) => {
    const user = requirePerm(req, "candidates.view");
    const resume = await loadResume(user, (req.params as { id: string }).id);
    const file = await readResume(resume);
    reply.header("cache-control", "private, max-age=300");
    if (file.mimeType === "application/pdf") return reply.type("application/pdf").send(file.data);
    if (file.mimeType.includes("wordprocessingml")) {
      const html = await docxToHtml(file.data);
      reply.header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
      return reply
        .type("text/html; charset=utf-8")
        .send(
          `<!doctype html><meta charset="utf-8"><style>body{font:14px/1.55 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#222;max-width:720px;margin:24px auto;padding:0 24px}h1,h2,h3{line-height:1.2}img{max-width:100%}</style>${html}`,
        );
    }
    throw new HttpError(415, "Preview isn't available for this file type — download it instead.");
  });

  app.get("/api/candidates/:id/resume/download", async (req, reply) => {
    const user = requirePerm(req, "resumes.download");
    const resume = await loadResume(user, (req.params as { id: string }).id);
    const file = await readResume(resume);
    const name = resume.mimeType === "application/vnd.google-apps.document" ? `${resume.fileName}.pdf` : resume.fileName;
    reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    return reply.type(file.mimeType).send(file.data);
  });

  // ---------- upload (multipart: jobId + files[]) ----------

  app.post("/api/resumes", async (req) => {
    const user = requirePerm(req, "resumes.upload");
    let jobId: string | null = null;
    let source: { id: string; name: string } | undefined;
    const created: string[] = [];
    const rejected: string[] = [];
    for await (const part of req.parts()) {
      if (part.type === "field" && part.fieldname === "jobId") {
        jobId = isUuid(part.value) ? (part.value as string) : null;
        continue;
      }
      if (part.type === "field" && part.fieldname === "sourceId") {
        source = part.value ? await one<{ id: string; name: string }>("select id, name from sources where id = $1", [part.value]) : undefined;
        continue;
      }
      if (part.type !== "file") continue;
      if (!/\.(pdf|docx)$/i.test(part.filename)) {
        rejected.push(part.filename);
        await part.toBuffer().catch(() => {});
        continue;
      }
      const data = await part.toBuffer();
      const resume = await storeResume({ jobId, sourceName: source?.name, fileName: part.filename, data, uploadedById: user.id });
      created.push(await createCandidate({ resume, jobId, sourceId: source?.id ?? null, intake: "upload", actorId: user.id }));
    }
    return { created, rejected };
  });
}
