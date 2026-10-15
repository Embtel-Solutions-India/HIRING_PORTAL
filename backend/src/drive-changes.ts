/** Google Drive Changes API: the persistent checkpoint and incremental sync of tracked resumes. */
import { Prisma, prisma } from "./db.ts";
import * as google from "./google.ts";
import { HttpError } from "./http.ts";
import { startDeletion, type ResumeFileRow } from "./resume-files.ts";
import { enqueue } from "./sync-queue.ts";
import { decide, type DriveObservation, type PortalPending, type SyncState } from "./sync-rules.ts";
import { getSetting, patchSetting, setSetting } from "./settings.ts";

/** Takes the change-feed bookmark before anything is migrated, so no change made during migration is missed. */
export async function ensureChangesCheckpoint() {
  if (!(await google.isConnected())) return;
  const st = await getSetting("driveChanges");
  if (st.pageToken) return;
  const root = await google.getFileMeta(await google.ensureRootFolder());
  const driveId = root.driveId ?? "";
  await setSetting("driveChanges", { pageToken: await google.getStartPageToken(driveId), driveId, lastSuccessAt: new Date().toISOString() });
}

/**
 * Reads ALL pages of changes before applying any, and only then advances the stored checkpoint.
 * A failure anywhere leaves the checkpoint alone, so the next run repeats the same changes (each apply is idempotent).
 */
export async function pollDriveChanges(): Promise<{ applied: number }> {
  if (!(await google.isConnected())) return { applied: 0 };
  const st = await getSetting("driveChanges");
  if (!st.pageToken) {
    await ensureChangesCheckpoint();
    return { applied: 0 };
  }
  const changes: google.DriveChange[] = [];
  let token = st.pageToken;
  let next = "";
  for (;;) {
    const page = await google.listChanges(token, st.driveId);
    changes.push(...page.changes);
    if (page.nextPageToken) token = page.nextPageToken;
    else {
      next = page.newStartPageToken ?? token;
      break;
    }
  }
  let applied = 0;
  for (const ch of changes) {
    const row = await prisma.resume_files.findUnique({ where: { drive_file_id: ch.fileId } });
    if (!row) continue;
    await applyChange(row, ch);
    applied++;
  }
  await patchSetting("driveChanges", { pageToken: next, lastSuccessAt: new Date().toISOString() });
  return { applied };
}

async function portalPending(resumeFileId: string): Promise<PortalPending> {
  const jobs = await prisma.sync_jobs.findMany({
    where: { resume_file_id: resumeFileId, kind: { in: ["to_drive", "rename_drive"] }, status: { in: ["queued", "running", "failed"] } },
    orderBy: { created_at: "desc" },
  });
  const content = jobs.find((j) => j.kind === "to_drive");
  const rename = jobs.find((j) => j.kind === "rename_drive");
  return {
    contentQueued: !!content,
    contentMd5: ((content?.payload as { md5?: string } | undefined)?.md5) ?? null,
    renameTo: ((rename?.payload as { name?: string } | undefined)?.name) ?? null,
  };
}

async function flagConflict(row: ResumeFileRow, obs: DriveObservation, on: "content" | "name") {
  const now = new Date();
  await prisma.$transaction([
    prisma.resume_files.update({
      where: { id: row.id },
      data: {
        state: "conflict",
        conflict: {
          on,
          detectedAt: now.toISOString(),
          drive: { md5: obs.md5, version: obs.version, name: obs.name },
          s3: { sha256: row.sha256, key: row.s3_key, versionId: row.s3_version_id, name: row.file_name },
        } as Prisma.InputJsonValue,
        updated_at: now,
      },
    }),
    // Stop pushing the portal version over Drive until an Admin decides.
    prisma.sync_jobs.updateMany({
      where: { resume_file_id: row.id, kind: { in: ["to_drive", "rename_drive"] }, status: { in: ["queued", "failed"] } },
      data: { status: "done", last_error: "cancelled: conflict", finished_at: now },
    }),
  ]);
  // Keep a permanent copy of the Drive side in S3, so neither version depends on Drive's revision retention.
  if (on === "content") await enqueue(row.id, "stash_conflict");
}

export async function applyChange(row: ResumeFileRow, ch: google.DriveChange) {
  const f = ch.file;
  const obs: DriveObservation = {
    removed: ch.removed || !f,
    trashed: !!f?.trashed,
    md5: f?.md5Checksum ?? null,
    version: f?.version ?? null,
    name: f?.name ?? "",
    mimeType: f?.mimeType ?? row.mime_type,
  };
  const decisions = decide(
    { state: row.state as SyncState, deletedSide: row.deleted_side },
    { driveMd5: row.drive_md5, driveVersion: row.drive_version, driveName: row.drive_name },
    obs,
    await portalPending(row.id),
  );
  for (const d of decisions) {
    if (d.do === "copy_to_s3") await enqueue(row.id, "to_s3");
    else if (d.do === "rename_s3") await enqueue(row.id, "rename_s3", { name: d.name });
    else if (d.do === "conflict") await flagConflict(row, obs, d.on);
    else if (d.do === "start_deletion") await startDeletion(row.id, "drive");
    else if (d.do === "cancel_deletion")
      await prisma.resume_files.update({ where: { id: row.id }, data: { state: "synced", delete_after: null, deleted_side: null, updated_at: new Date() } });
    else if (d.do === "check_removed") {
      try {
        await google.getFileMeta(row.drive_file_id!);
        await prisma.resume_files.update({
          where: { id: row.id },
          data: { state: "failed", last_error: "Lost access to the Drive file (it exists but the connected account can't see it)", updated_at: new Date() },
        });
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) await startDeletion(row.id, "drive");
        else throw e;
      }
    }
  }
}
