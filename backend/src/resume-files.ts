/** resume_files rows: the bridge between a candidate, its S3 object and its Drive file. */
import type { ResumeFile } from "../../frontend/src/types.ts";
import { config } from "./config.ts";
import { Prisma, prisma } from "./db.ts";
import * as s3 from "./s3.ts";
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
    update: { candidate_id: candidateId, state: "pending", delete_after: null, deleted_side: null, updated_at: new Date() },
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
    ({ versionId } = await s3.copy(row.s3_key, newKey));
    const h = await s3.head(newKey, versionId);
    if (h.size !== row.size_bytes || h.sha256 !== row.sha256) throw new ChecksumMismatch("S3 copy");
  }
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.resume_files.update({ where: { id: row.id }, data: { s3_key: newKey, s3_version_id: versionId, file_name: name, ...extra, updated_at: new Date() } });
    await syncCandidateResume(tx, u);
    return u;
  });
  if (newKey !== row.s3_key) await s3.remove(row.s3_key).catch((e) => console.warn("[sync] couldn't remove old key", row.s3_key, e));
  return updated;
}
