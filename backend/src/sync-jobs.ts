/** The sync worker: runs queued transfers one at a time, then polls Drive for changes. */
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.ts";
import { Prisma, prisma } from "./db.ts";
import { pollDriveChanges } from "./drive-changes.ts";
import * as google from "./google.ts";
import { syncCandidateResume, type ResumeFileRow } from "./resume-files.ts";
import * as s3 from "./s3.ts";
import { claimNext, complete, enqueue, fail, resetRunning, type JobRow } from "./sync-queue.ts";
import { ChecksumMismatch, digest, s3KeyFor, s3MimeFor } from "./sync-rules.ts";

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

export async function runJob(job: JobRow) {
  const row = await prisma.resume_files.findUnique({ where: { id: job.resume_file_id } });
  if (!row) return complete(job.id, prisma, "skipped: resume row gone");
  switch (job.kind) {
    case "to_s3":
      return toS3(job, row);
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

/** Placeholder until Task 8 adds purge handling. */
async function enqueueDuePurges() {}
