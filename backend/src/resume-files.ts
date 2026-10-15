/** resume_files rows: the bridge between a candidate, its S3 object and its Drive file. */
import type { ResumeFile } from "../../frontend/src/types.ts";
import { config } from "./config.ts";
import { Prisma, prisma } from "./db.ts";
import { ensureChangesCheckpoint } from "./drive-changes.ts";
import * as google from "./google.ts";
import { HttpError } from "./http.ts";
import { createCandidate } from "./pipeline.ts";
import * as s3 from "./s3.ts";
import { patchSetting } from "./settings.ts";
import { enqueue, type Db } from "./sync-queue.ts";
import { ChecksumMismatch, resolveFileName, s3MimeFor, s3NameFor, safeKeyName } from "./sync-rules.ts";

export type ResumeFileRow = NonNullable<Awaited<ReturnType<typeof prisma.resume_files.findUnique>>>;

/** The candidates.resume JSON for a resume served from S3 (shape the UI already understands). */
export function resumeJson(row: ResumeFileRow, prev: Partial<ResumeFile> = {}): ResumeFile {
  return {
    ...prev,
    storage: "s3",
    resumeFileId: row.id,
    version: row.s3_version_id ?? undefined,
    driveFileId: row.drive_file_id ?? "",
    driveUrl: row.drive_file_id ? `https://drive.google.com/file/d/${row.drive_file_id}/view` : "",
    fileName: row.file_name,
    mimeType: s3MimeFor(row.mime_type),
    sizeKb: Math.max(1, Math.round(row.size_bytes / 1024)),
    uploadedAt: prev.uploadedAt ?? row.created_at.toISOString(),
    uploadedById: prev.uploadedById ?? "",
  };
}

/** Points the candidate at the row's current S3 object. Only call once that object is verified. */
export async function syncCandidateResume(db: Db, row: ResumeFileRow) {
  if (!row.candidate_id || !row.s3_key) return;
  const c = await db.candidates.findUnique({ where: { id: row.candidate_id }, select: { resume: true } });
  const json = resumeJson(row, (c?.resume ?? {}) as Partial<ResumeFile>);
  await db.candidates.update({ where: { id: row.candidate_id }, data: { resume: json as unknown as Prisma.InputJsonValue } });
}

export const graceDate = () => new Date(Date.now() + config.resumeDeleteGraceDays * 86_400_000);

/** The state a resume returns to when its deletion is cancelled: an unresolved conflict comes back. */
export const undeletedState = (row: { conflict: unknown }) => (row.conflict ? "conflict" : "synced");

/** Deletes candidates and starts their resumes' grace period, all or nothing. Conflicts are kept for a later restore. */
export async function markCandidatesDeleted(ids: string[]): Promise<number> {
  return prisma.$transaction(async (tx) => {
    await tx.resume_files.updateMany({
      where: { candidate_id: { in: ids }, state: { not: "deleted" } },
      data: { state: "pending_deletion", deleted_side: "portal", delete_after: graceDate(), updated_at: new Date() },
    });
    return (await tx.candidates.deleteMany({ where: { id: { in: ids } } })).count;
  });
}

/** Admin "Restore" on a resume pending deletion. */
export async function restoreResume(row: ResumeFileRow, actorId: string | null) {
  if (row.state !== "pending_deletion") throw new HttpError(409, "This resume isn't pending deletion");
  const cleared = { delete_after: null, deleted_side: null, updated_at: new Date() };
  if (row.deleted_side === "drive") {
    try {
      await google.setTrashed(row.drive_file_id!, false);
      await prisma.resume_files.update({ where: { id: row.id }, data: { state: undeletedState(row), ...cleared } });
    } catch (e) {
      if (!(e instanceof HttpError && e.status === 404)) throw e;
      // Gone from Drive for good: put the S3 copy back as a new Drive file (nothing left to conflict with).
      await prisma.resume_files.update({
        where: { id: row.id },
        data: { drive_file_id: null, drive_md5: null, drive_version: null, drive_name: null, state: "pending", conflict: Prisma.DbNull, ...cleared },
      });
      await enqueue(row.id, "to_drive");
    }
    return;
  }
  // The candidate was deleted: bring the resume back as a new candidate (works whether or not it ever reached Drive).
  const candidateId = await createCandidate({ resume: resumeJson(row), jobId: null, sourceId: null, intake: row.drive_file_id ? "drive" : "upload", actorId });
  await prisma.resume_files.update({ where: { id: row.id }, data: { candidate_id: candidateId, state: undeletedState(row), ...cleared } });
  if (row.drive_file_id) await prisma.drive_files.updateMany({ where: { drive_file_id: row.drive_file_id }, data: { status: "imported", candidate_id: candidateId } });
}

export async function startDeletion(id: string, side: "drive" | "portal") {
  await prisma.resume_files.update({ where: { id }, data: { state: "pending_deletion", deleted_side: side, delete_after: graceDate(), updated_at: new Date() } });
}

/** A Drive file just became a candidate: track it and copy it to S3. Reuses the row if this file was seen before. */
export async function trackDriveImport(candidateId: string, f: { drive_file_id: string; file_name: string; mime_type: string }) {
  if (!s3.s3Configured()) return;
  const { fileName, reviewReason } = resolveFileName(f.file_name, f.drive_file_id, f.mime_type);
  const row = await prisma.resume_files.upsert({
    where: { drive_file_id: f.drive_file_id },
    create: { candidate_id: candidateId, file_name: fileName, mime_type: f.mime_type, drive_file_id: f.drive_file_id, review_reason: reviewReason },
    update: { candidate_id: candidateId, state: "pending", conflict: Prisma.DbNull, last_error: null, delete_after: null, deleted_side: null, updated_at: new Date() },
  });
  await enqueue(row.id, "to_s3");
}

/** Keeps the folder scan from importing a file we uploaded ourselves. */
export async function registerDriveFile(id: string, name: string, mimeType: string, folderId: string, sizeBytes: number) {
  await prisma.drive_files.createMany({
    data: { drive_file_id: id, file_name: name, mime_type: mimeType, folder_id: folderId, size_kb: Math.max(1, Math.round(sizeBytes / 1024)), status: "imported" },
    skipDuplicates: true,
  });
}

/**
 * Renames the resume. The S3 object moves to a new key under the same `resumes/{sourceId}/` prefix
 * (server-side copy, verified, then the old key is removed). Same row, so candidate links don't change.
 */
export async function renameInS3(row: ResumeFileRow, name: string, extra: { drive_name?: string } = {}): Promise<ResumeFileRow> {
  if (!row.s3_key) {
    // Not copied to S3 yet: to_s3 will use the new name.
    return prisma.resume_files.update({ where: { id: row.id }, data: { file_name: name, ...extra, updated_at: new Date() } });
  }
  const prefix = row.s3_key.split("/").slice(0, 2).join("/");
  const newKey = `${prefix}/${safeKeyName(s3NameFor(name, row.mime_type))}`;
  let versionId = row.s3_version_id;
  if (newKey !== row.s3_key) {
    // Copy the exact version the row points at, not whatever is newest at the key.
    ({ versionId } = await s3.copy(row.s3_key, newKey, row.s3_version_id ?? undefined));
    const h = await s3.head(newKey, versionId);
    if (h.size !== row.size_bytes || h.sha256 !== row.sha256) throw new ChecksumMismatch("S3 copy");
  }
  const updated = await prisma.$transaction(async (tx) => {
    // Only if nothing (e.g. the sync worker) changed the resume while we copied.
    const { count } = await tx.resume_files.updateMany({
      where: { id: row.id, s3_key: row.s3_key, s3_version_id: row.s3_version_id },
      data: { s3_key: newKey, s3_version_id: versionId, file_name: name, ...extra, updated_at: new Date() },
    });
    if (!count) throw new HttpError(409, "The resume changed while it was being renamed — try again");
    const u = await tx.resume_files.findUniqueOrThrow({ where: { id: row.id } });
    await syncCandidateResume(tx, u);
    return u;
  }).catch(async (e) => {
    if (newKey !== row.s3_key) await s3.remove(newKey).catch(() => {});
    throw e;
  });
  if (newKey !== row.s3_key) await s3.remove(row.s3_key).catch((e) => console.warn("[sync] couldn't remove old key", row.s3_key, e));
  return updated;
}

/**
 * Queues every resume that isn't on S3 yet. Safe to run any number of times: rows are keyed by the stable
 * source id (Drive file id / local file id) and duplicate jobs merge. Drive originals are never touched.
 */
export async function startMigration(): Promise<{ queued: number }> {
  if (!s3.s3Configured()) return { queued: 0 };
  await ensureChangesCheckpoint();
  await patchSetting("migration", { startedAt: new Date().toISOString() });
  const todo = await prisma.$queryRaw<{ id: string; resume: ResumeFile }[]>`
    select c.id, c.resume from candidates c left join resume_files r on r.candidate_id = c.id
    where r.id is null and c.resume is not null and coalesce(c.resume->>'driveFileId', '') <> ''`;
  let queued = 0;
  for (const c of todo) {
    const local = c.resume.storage === "local";
    const mime = c.resume.mimeType || "application/octet-stream";
    const { fileName, reviewReason } = resolveFileName(c.resume.fileName, c.resume.driveFileId, mime);
    const source = local ? { local_path: c.resume.driveFileId } : { drive_file_id: c.resume.driveFileId };
    const row = await prisma.resume_files.upsert({
      where: source,
      create: { candidate_id: c.id, file_name: fileName, mime_type: mime, size_bytes: (c.resume.sizeKb || 0) * 1024, review_reason: reviewReason, ...source },
      update: {},
    });
    if (row.candidate_id !== c.id) {
      console.warn(`[migration] ${c.id} shares its resume file with candidate ${row.candidate_id}; left on Drive`);
      continue;
    }
    await enqueue(row.id, "to_s3");
    queued++;
  }
  // Portal uploads made while Drive was disconnected still need their Drive copy.
  if (await google.isConnected()) {
    const noDrive = await prisma.resume_files.findMany({ where: { drive_file_id: null, s3_key: { not: null }, candidate_id: { not: null }, state: { in: ["pending", "synced", "failed"] } }, select: { id: true } });
    for (const r of noDrive) await enqueue(r.id, "to_drive");
    queued += noDrive.length;
  }
  return { queued };
}
