import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ResumeFile } from "../../../frontend/src/types.ts";
import { logActivity, touchCandidate } from "../activity.ts";
import { addNote } from "../applications.ts";
import { prisma } from "../db.ts";
import { config } from "../config.ts";
import * as google from "../google.ts";
import { assertCandidateAccess, HttpError, isUuid, requirePerm } from "../http.ts";
import { createCandidate, enqueueParse } from "../pipeline.ts";
import { markCandidatesDeleted, renameInS3, syncCandidateResume } from "../resume-files.ts";
import { docxToHtml } from "../resume.ts";
import * as s3 from "../s3.ts";
import { mimeFor, readResume, storeResume } from "../storage.ts";
import { enqueue } from "../sync-queue.ts";
import { digest, keyPrefix, safeKeyName } from "../sync-rules.ts";

const PatchBody = z
  .object({
    tags: z.array(z.string().max(40)).max(20),
    firstName: z.string().max(100),
    lastName: z.string().max(100),
    email: z.string().max(200),
    phone: z.string().max(50),
    location: z.string().max(120),
  })
  .partial();

const fullName = (c: { first_name: string; last_name: string }) => `${c.first_name} ${c.last_name}`.trim();

export default async function candidateRoutes(app: FastifyInstance) {
  app.patch("/api/candidates/:id", async (req) => {
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw new HttpError(404, "Not found");
    const body = PatchBody.parse(req.body);
    const user = requirePerm(req, "candidates.edit");
    await assertCandidateAccess(user, id);
    const data = {
      tags: body.tags,
      first_name: body.firstName,
      last_name: body.lastName,
      email: body.email,
      phone: body.phone,
      location: body.location,
    };
    if (Object.values(data).every((v) => v === undefined)) return { ok: true };
    await prisma.candidates.updateMany({ where: { id }, data });
    // Tags are bookkeeping; name and contact changes count as work on the person's open applications.
    const fields = (["firstName", "lastName", "email", "phone", "location"] as const).filter((k) => body[k] !== undefined);
    if (fields.length) {
      await touchCandidate(id);
      const c = await prisma.candidates.findUnique({ where: { id }, select: { first_name: true, last_name: true } });
      const label = fields.map((f) => (f === "firstName" || f === "lastName" ? "name" : f)).filter((f, i, all) => all.indexOf(f) === i);
      await logActivity(user.id, "candidate_updated", `updated the ${label.join(", ")} on ${fullName(c!)}`, id);
    }
    return { ok: true };
  });

  app.post("/api/candidates/:id/notes", async (req) => {
    const user = requirePerm(req, "candidates.addNote");
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw new HttpError(404, "Not found");
    await assertCandidateAccess(user, id);
    const { body, applicationId } = z.object({ body: z.string().trim().min(1).max(5000), applicationId: z.string().uuid().nullish() }).parse(req.body);
    const c = await prisma.candidates.findUnique({ where: { id }, select: { first_name: true, last_name: true } });
    await addNote({ candidateId: id, applicationId, body, actorId: user.id });
    await logActivity(user.id, "note", `added a note on ${fullName(c!)}`, id);
    return { ok: true };
  });

  app.post("/api/candidates/delete", async (req) => {
    const user = requirePerm(req, "candidates.delete");
    const { ids } = z.object({ ids: z.array(z.string().uuid()).min(1) }).parse(req.body);
    // Their resumes stay in S3 and Drive for the grace period; an Admin can restore them from Settings → Resume sync.
    const count = await markCandidatesDeleted(ids);
    await logActivity(user.id, "settings_changed", `deleted ${count} candidate${count === 1 ? "" : "s"} (resumes kept ${config.resumeDeleteGraceDays} days)`);
    return { deleted: count };
  });

  // ---------- resume files ----------

  async function loadResume(reqUser: Parameters<typeof assertCandidateAccess>[0], id: string) {
    if (!isUuid(id)) throw new HttpError(404, "Not found");
    await assertCandidateAccess(reqUser, id);
    const c = await prisma.candidates.findUnique({ where: { id }, select: { resume: true } });
    const resume = c?.resume as ResumeFile | null | undefined;
    if (!resume?.driveFileId && !resume?.resumeFileId) throw new HttpError(404, "No resume on file");
    return resume;
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
    const name = file.mimeType === "application/pdf" && !/\.pdf$/i.test(resume.fileName) ? `${resume.fileName}.pdf` : resume.fileName;
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
        source = part.value ? ((await prisma.sources.findUnique({ where: { id: String(part.value) }, select: { id: true, name: true } })) ?? undefined) : undefined;
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
      const candidateId = await createCandidate({ resume, jobId, sourceId: source?.id ?? null, intake: "upload", actorId: user.id }).catch(async (e) => {
        // Don't leave an S3 object and a resume row with no candidate behind.
        if (resume.resumeFileId) {
          const orphan = await prisma.resume_files.findUnique({ where: { id: resume.resumeFileId } });
          await prisma.resume_files.delete({ where: { id: resume.resumeFileId } }).catch(() => {});
          if (orphan?.s3_key) await s3.remove(orphan.s3_key).catch(() => {});
        }
        throw e;
      });
      if (resume.resumeFileId) {
        await prisma.resume_files.update({ where: { id: resume.resumeFileId }, data: { candidate_id: candidateId } });
        if (await google.isConnected()) await enqueue(resume.resumeFileId, "to_drive", { md5: digest(data).md5 });
      }
      created.push(candidateId);
    }
    return { created, rejected };
  });

  async function editableResume(user: Parameters<typeof assertCandidateAccess>[0], id: string) {
    if (!isUuid(id)) throw new HttpError(404, "Not found");
    await assertCandidateAccess(user, id);
    const row = await prisma.resume_files.findUnique({ where: { candidate_id: id } });
    if (!row?.s3_key) throw new HttpError(409, "This resume hasn't been copied to S3 yet — try again once the migration has finished");
    if (row.state === "conflict" || row.state === "pending_deletion") throw new HttpError(409, "This resume has a sync issue — resolve it in Settings → Resume sync first");
    return row;
  }

  app.post("/api/candidates/:id/resume", async (req) => {
    const user = requirePerm(req, "candidates.edit");
    const { id } = req.params as { id: string };
    const row = await editableResume(user, id);
    const part = await req.file();
    if (!part || !/\.(pdf|docx)$/i.test(part.filename)) throw new HttpError(400, "Upload a PDF or Word (.docx) file");
    const data = await part.toBuffer();
    const { sha256, md5 } = digest(data);
    const mimeType = mimeFor(part.filename);
    const key = `${keyPrefix(row.s3_key!)}/${safeKeyName(part.filename)}`;
    const versionId = await s3.putVerified(key, data, mimeType, sha256);
    await prisma.$transaction(async (tx) => {
      // Only if the sync worker didn't change the resume while we uploaded; otherwise its change would be lost.
      const { count } = await tx.resume_files.updateMany({
        where: { id: row.id, s3_key: row.s3_key, s3_version_id: row.s3_version_id, state: { notIn: ["conflict", "pending_deletion"] } },
        data: { s3_key: key, s3_version_id: versionId, sha256, size_bytes: data.length, file_name: part.filename, mime_type: mimeType, state: "pending", updated_at: new Date() },
      });
      if (!count) throw new HttpError(409, "The resume was just updated from Google Drive — check it and try again");
      const u = await tx.resume_files.findUniqueOrThrow({ where: { id: row.id } });
      await syncCandidateResume(tx, u);
      await tx.candidates.update({ where: { id }, data: { parse_status: "pending" } });
      await enqueue(row.id, "to_drive", { md5 }, tx);
      if (part.filename !== row.drive_name) await enqueue(row.id, "rename_drive", { name: part.filename }, tx);
    }).catch(async (e) => {
      // Lost the race: drop just our upload, never the worker's version.
      await s3.remove(key, versionId).catch(() => {});
      throw e;
    });
    if (key !== row.s3_key) await s3.remove(row.s3_key!).catch((e) => console.warn("[resume] couldn't remove old key", e));
    enqueueParse(id);
    await touchCandidate(id);
    await logActivity(user.id, "resume_upload", `replaced the resume with ${part.filename}`, id);
    return { ok: true };
  });

  app.patch("/api/candidates/:id/resume", async (req) => {
    const user = requirePerm(req, "candidates.edit");
    const { id } = req.params as { id: string };
    const { fileName } = z
      .object({ fileName: z.string().trim().min(1).max(200).refine((n) => !/[\/\\\x00-\x1f\x7f]/.test(n), "A file name can't contain / \\ or control characters") })
      .parse(req.body);
    const row = await editableResume(user, id);
    if (fileName === row.file_name) return { ok: true };
    await renameInS3(row, fileName);
    await enqueue(row.id, "rename_drive", { name: fileName });
    await touchCandidate(id);
    await logActivity(user.id, "resume_upload", `renamed the resume to ${fileName}`, id);
    return { ok: true };
  });
}
