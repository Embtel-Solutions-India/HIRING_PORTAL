/** The sync worker: runs queued transfers one at a time, then polls Drive for changes. */
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.ts";
import { Prisma, prisma } from "./db.ts";
import { pollDriveChanges } from "./drive-changes.ts";
import * as google from "./google.ts";
import { registerDriveFile, renameInS3, syncCandidateResume, type ResumeFileRow } from "./resume-files.ts";
import * as s3 from "./s3.ts";
import { driveFolderFor } from "./storage.ts";
import { claimNext, complete, enqueue, fail, resetRunning, setPayload, type JobRow } from "./sync-queue.ts";
import { ChecksumMismatch, digest, GOOGLE_DOC, s3KeyFor, s3MimeFor, s3NameFor, safeKeyName } from "./sync-rules.ts";

const frozen = (row: ResumeFileRow, job: JobRow) =>
  (row.state === "conflict" && !job.payload.resolve) || row.state === "pending_deletion" || row.state === "deleted";

/** Puts bytes in S3 and reads them back; throws unless length and SHA-256 match. */
async function putVerified(key: string, data: Buffer, mimeType: string, sha256: string) {
  const { versionId } = await s3.put(key, data, mimeType, sha256);
  const back = await s3.get(key, versionId);
  if (back.length !== data.length || digest(back).sha256 !== sha256) throw new ChecksumMismatch("S3 read-back");
  return versionId;
}

/** Drive (or server disk) → S3. Switches the candidate to S3 only after the copy is verified. */
async function toS3(job: JobRow, row: ResumeFileRow) {
  if (frozen(row, job)) return complete(job.id, prisma, "skipped: needs review");
  let data: Buffer;
  let baseline: { drive_md5: string | null; drive_version: string | null; drive_name: string } | null = null;
  if (row.drive_file_id) {
    // Metadata first: if the file changes during the download, its newer version shows up on the next poll.
    const meta = await google.getFileMeta(row.drive_file_id);
    if (meta.trashed) return complete(job.id, prisma, "skipped: trashed in Drive");
    data = (await google.downloadFile(row.drive_file_id, meta.mimeType)).data;
    if (meta.md5Checksum && digest(data).md5 !== meta.md5Checksum) throw new ChecksumMismatch("Drive download");
    baseline = { drive_md5: meta.md5Checksum ?? null, drive_version: meta.version ?? null, drive_name: meta.name };
  } else if (row.local_path) {
    if (!/^[0-9a-f-]{36}$/.test(row.local_path)) throw new Error("Bad local file id");
    data = await fs.readFile(path.join(config.dataDir, "resumes", row.local_path));
  } else {
    throw new Error("Resume has no source to copy from");
  }
  const { sha256 } = digest(data);
  let key = row.s3_key;
  let versionId = row.s3_version_id;
  if (!key || sha256 !== row.sha256) {
    key ??= s3KeyFor(row.drive_file_id ?? row.id, row.file_name, row.mime_type);
    versionId = await putVerified(key, data, s3MimeFor(row.mime_type), sha256);
  }
  await prisma.$transaction(async (tx) => {
    const updated = await tx.resume_files.update({
      where: { id: row.id },
      data: { s3_key: key, s3_version_id: versionId, sha256, size_bytes: data.length, ...(baseline ?? {}), state: "synced", conflict: Prisma.DbNull, last_synced_at: new Date(), last_error: null, updated_at: new Date() },
    });
    await syncCandidateResume(tx, updated);
    await complete(job.id, tx);
  });
  if (row.local_path && !row.drive_file_id && (await google.isConnected())) await enqueue(row.id, "to_drive");
}

/** Where a resume without a Drive file goes: its candidate's job/source folder. */
async function folderForRow(row: ResumeFileRow): Promise<string> {
  const c = row.candidate_id ? await prisma.candidates.findUnique({ where: { id: row.candidate_id }, select: { job_id: true, sources: { select: { name: true } } } }) : null;
  return (await driveFolderFor(c?.job_id ?? null, c?.sources?.name)) ?? (await google.ensureRootFolder());
}

/** Creates a Drive file with a pre-generated id stored in the job, so a retry after a crash can't make a second file. */
async function createDriveFileOnce(job: JobRow, folderId: string, name: string, mimeType: string, data: Buffer): Promise<string> {
  let fileId = job.payload.newFileId as string | undefined;
  if (!fileId) {
    fileId = await google.generateFileId();
    job.payload = { ...job.payload, newFileId: fileId };
    await setPayload(job.id, job.payload);
    await registerDriveFile(fileId, name, mimeType, folderId, data.length);
  }
  const exists = await google.getFileMeta(fileId).then(() => true, (e) => (e?.status === 404 ? false : Promise.reject(e)));
  if (!exists) await google.uploadFile(folderId, name, mimeType, data, fileId);
  return fileId;
}

/** S3 → Drive. Binary files get a new revision of the same Drive file; a Google Doc gets a PDF beside it and is archived. */
async function toDrive(job: JobRow, row: ResumeFileRow) {
  if (frozen(row, job)) return complete(job.id, prisma, "skipped: needs review");
  if (!row.s3_key) throw new Error("No S3 copy yet");
  if (!(await google.isConnected())) throw new Error("Google Drive isn't connected");
  const data = await s3.get(row.s3_key, row.s3_version_id ?? undefined);
  const { md5 } = digest(data);
  if (job.payload.md5 !== md5) {
    // Lets the change feed recognise this upload as our own echo.
    job.payload = { ...job.payload, md5 };
    await setPayload(job.id, job.payload);
  }
  const mimeType = s3MimeFor(row.mime_type);
  const name = s3NameFor(row.file_name, row.mime_type);
  let fileId = row.drive_file_id;
  const current = fileId ? await google.getFileMeta(fileId) : null;
  if (fileId && current?.mimeType === GOOGLE_DOC) {
    const parent = current.parents?.[0] ?? (await google.ensureRootFolder());
    const newId = await createDriveFileOnce(job, parent, name, mimeType, data);
    await google.moveFile(fileId, await google.findOrCreateFolder("_archive", await google.ensureRootFolder()));
    fileId = newId;
  } else if (fileId) {
    await google.updateFileContent(fileId, mimeType, data);
  } else {
    fileId = await createDriveFileOnce(job, await folderForRow(row), name, mimeType, data);
  }
  const meta = await google.getFileMeta(fileId);
  if (Number(meta.size) !== data.length || meta.md5Checksum !== md5) throw new ChecksumMismatch("Drive upload");
  await prisma.$transaction(async (tx) => {
    const updated = await tx.resume_files.update({
      where: { id: row.id },
      data: {
        drive_file_id: fileId,
        drive_md5: md5,
        drive_version: meta.version ?? null,
        drive_name: meta.name,
        mime_type: meta.mimeType === GOOGLE_DOC ? row.mime_type : meta.mimeType,
        state: "synced",
        ...(job.payload.resolve ? { conflict: Prisma.DbNull } : {}),
        last_synced_at: new Date(),
        last_error: null,
        updated_at: new Date(),
      },
    });
    await syncCandidateResume(tx, updated);
    await complete(job.id, tx);
  });
}

async function renameDrive(job: JobRow, row: ResumeFileRow) {
  if (frozen(row, job)) return complete(job.id, prisma, "skipped: needs review");
  if (!row.drive_file_id) return complete(job.id, prisma, "skipped: no Drive file yet (to_drive will use the name)");
  const name = String(job.payload.name);
  await google.renameFile(row.drive_file_id, name);
  const meta = await google.getFileMeta(row.drive_file_id);
  if (meta.name !== name) throw new Error(`Drive kept the name "${meta.name}"`);
  await prisma.$transaction(async (tx) => {
    await tx.resume_files.update({
      where: { id: row.id },
      data: { drive_name: name, drive_version: meta.version ?? null, state: "synced", ...(job.payload.resolve ? { conflict: Prisma.DbNull } : {}), last_synced_at: new Date(), updated_at: new Date() },
    });
    await complete(job.id, tx);
  });
}

/** Drive renamed the file: move the S3 object to the new name (baseline name = the Drive name). */
async function renameS3(job: JobRow, row: ResumeFileRow) {
  if (frozen(row, job)) return complete(job.id, prisma, "skipped: needs review");
  const name = String(job.payload.name);
  await renameInS3(row, name, { drive_name: name });
  if (job.payload.resolve) {
    await prisma.resume_files.update({ where: { id: row.id }, data: { state: "synced", conflict: Prisma.DbNull, updated_at: new Date() } });
  }
  await complete(job.id);
}

/** Copies the Drive side of a content conflict into S3 under conflicts/, so both versions survive any resolution. */
async function stashConflict(job: JobRow, row: ResumeFileRow) {
  const conflict = row.conflict as { drive?: { stashKey?: string; name?: string } } | null;
  if (row.state !== "conflict" || !row.drive_file_id || conflict?.drive?.stashKey) return complete(job.id, prisma, "skipped");
  const meta = await google.getFileMeta(row.drive_file_id);
  const { data } = await google.downloadFile(row.drive_file_id, meta.mimeType);
  const { sha256 } = digest(data);
  const key = `conflicts/${row.id}/${Date.now()}-${safeKeyName(s3NameFor(meta.name, meta.mimeType))}`;
  await putVerified(key, data, s3MimeFor(meta.mimeType), sha256);
  await prisma.$transaction(async (tx) => {
    const fresh = await tx.resume_files.findUniqueOrThrow({ where: { id: row.id } });
    const c = (fresh.conflict ?? {}) as Record<string, any>;
    await tx.resume_files.update({ where: { id: row.id }, data: { conflict: { ...c, drive: { ...c.drive, stashKey: key } } as Prisma.InputJsonValue } });
    await complete(job.id, tx);
  });
}

export async function runJob(job: JobRow) {
  const row = await prisma.resume_files.findUnique({ where: { id: job.resume_file_id } });
  if (!row) return complete(job.id, prisma, "skipped: resume row gone");
  switch (job.kind) {
    case "to_s3":
      return toS3(job, row);
    case "rename_s3":
      return renameS3(job, row);
    case "stash_conflict":
      return stashConflict(job, row);
    case "purge":
      return purge(job, row);
    case "to_drive":
      return toDrive(job, row);
    case "rename_drive":
      return renameDrive(job, row);
    default:
      throw new Error(`Unknown job kind ${job.kind}`);
  }
}

let running: Promise<void> | null = null;
let lastPoll = 0;
let lastPurgeScan = 0;
let started = false;

/** One pass of the worker. Jobs and Drive polling never overlap, so a change can't race a half-finished transfer. */
export function syncTick(): Promise<void> {
  running ??= doTick().finally(() => (running = null));
  return running;
}

async function doTick() {
  if (!s3.s3Configured()) return;
  if (!started) {
    await resetRunning();
    started = true;
  }
  const deadline = Date.now() + 50_000;
  while (Date.now() < deadline) {
    const job = await claimNext();
    if (!job) break;
    try {
      await runJob(job);
    } catch (e) {
      console.warn(`[sync] ${job.kind} ${job.resume_file_id}:`, e instanceof Error ? e.message : e);
      await fail(job, e);
    }
  }
  if (Date.now() - lastPoll >= config.driveSyncMinutes * 60_000) {
    lastPoll = Date.now();
    await pollDriveChanges();
  }
  if (Date.now() - lastPurgeScan >= 3_600_000) {
    lastPurgeScan = Date.now();
    await enqueueDuePurges();
  }
}

async function enqueueDuePurges() {
  const due = await prisma.resume_files.findMany({ where: { state: "pending_deletion", delete_after: { lte: new Date() } }, select: { id: true } });
  for (const r of due) await enqueue(r.id, "purge");
}

/** End of the grace period: the only automatic deletion. S3 keeps a noncurrent version; Drive keeps the file in trash. */
async function purge(job: JobRow, row: ResumeFileRow) {
  if (row.state !== "pending_deletion" || !row.delete_after || row.delete_after > new Date()) return complete(job.id, prisma, "skipped: restored or not due");
  if (row.s3_key) await s3.remove(row.s3_key);
  if (row.deleted_side === "portal" && row.drive_file_id && (await google.isConnected())) {
    await google.setTrashed(row.drive_file_id, true).catch((e) => {
      if (e?.status !== 404) throw e;
    });
  }
  await prisma.$transaction(async (tx) => {
    await tx.resume_files.update({ where: { id: row.id }, data: { state: "deleted", updated_at: new Date() } });
    await complete(job.id, tx);
  });
}
