/**
 * Drive sync: scans the resume folders for new PDF/Word/Google Doc files.
 *
 *   <root>/                      e.g. ATS/Resumes
 *   ├── <Job title>/             → candidate is assigned to that job
 *   │   ├── <Source>/            → …and tagged with that source (LinkedIn, Indeed, Referral…)
 *   │   └── resume.pdf           → job known, source left for a person to tag
 *   └── <Source>/ or loose files → waits in the Drive inbox for a person to pick the job
 *
 * Google Drive is only how a file arrives — it is never recorded as the candidate's source.
 */
import type { ResumeFile } from "../../frontend/src/types.ts";
import { one, q } from "./db.ts";
import * as google from "./google.ts";
import { createCandidate } from "./pipeline.ts";
import { getSetting, patchSetting } from "./settings.ts";
import { ensureJobFolder } from "./storage.ts";

let syncing: Promise<{ found: number; imported: number }> | null = null;

export function syncDrive(): Promise<{ found: number; imported: number }> {
  syncing ??= doSync().finally(() => (syncing = null));
  return syncing;
}

const norm = (s: string) => s.trim().toLowerCase();

interface ScanFolder {
  id: string;
  name: string;
  jobId: string | null;
  sourceId: string | null;
}

async function doSync() {
  if (!(await google.isConnected())) return { found: 0, imported: 0 };
  const rootId = await google.ensureRootFolder();
  const g = await getSetting("google");
  const jobs = await q<{ id: string; title: string; drive_folder_id: string | null }>("select id, title, drive_folder_id from jobs");
  const sources = await q<{ id: string; name: string }>("select id, name from sources");
  const sourceFor = (folderName: string) => sources.find((s) => norm(s.name) === norm(folderName) || s.id === norm(folderName))?.id ?? null;

  const folders: ScanFolder[] = [{ id: rootId, name: g.driveRootFolder, jobId: null, sourceId: null }];
  for (const f of await google.listSubfolders(rootId)) {
    // Job folders are matched by id, or by name for folders people created by hand.
    let job = jobs.find((j) => j.drive_folder_id === f.id) ?? jobs.find((j) => !j.drive_folder_id && norm(j.title) === norm(f.name));
    if (job && !job.drive_folder_id) {
      job.drive_folder_id = f.id;
      await q("update jobs set drive_folder_id = $1, drive_folder = $2 where id = $3", [f.id, `${g.driveRootFolder}/${f.name}`, job.id]);
    }
    const path = `${g.driveRootFolder}/${f.name}`;
    folders.push({ id: f.id, name: path, jobId: job?.id ?? null, sourceId: job ? null : sourceFor(f.name) });
    if (job) {
      for (const sub of await google.listSubfolders(f.id)) {
        folders.push({ id: sub.id, name: `${path}/${sub.name}`, jobId: job.id, sourceId: sourceFor(sub.name) });
      }
    }
  }

  let found = 0;
  const fresh: { id: string; jobId: string | null }[] = [];
  for (const folder of folders) {
    const files = (await google.listFolder(folder.id)).filter((f) => google.RESUME_MIME.includes(f.mimeType));
    for (const f of files) {
      const inserted = await one<{ drive_file_id: string }>(
        `insert into drive_files (drive_file_id, file_name, mime_type, folder_id, folder_name, source_id, size_kb, modified_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (drive_file_id) do nothing returning drive_file_id`,
        [f.id, f.name, f.mimeType, folder.id, folder.name, folder.sourceId, Math.max(1, Math.round(Number(f.size ?? 0) / 1024)), f.modifiedTime ?? null],
      );
      if (inserted) {
        found++;
        fresh.push({ id: f.id, jobId: folder.jobId });
      }
    }
  }

  let imported = 0;
  if (g.driveSyncEnabled) {
    // Auto-import only files that sit in a job folder; everything else waits in the inbox for a person.
    imported = (await importDriveFiles(fresh.filter((f) => f.jobId).map((f) => f.id), null, null)).length;
  }
  await patchSetting("google", { lastSyncAt: new Date().toISOString() });
  return { found, imported };
}

/** Folder id → job id, for job folders and their source sub-folders. */
async function jobForFolder(folderId: string | null): Promise<string | null> {
  if (!folderId) return null;
  const direct = await one<{ id: string }>("select id from jobs where drive_folder_id = $1", [folderId]);
  if (direct) return direct.id;
  // Source sub-folder: its parent is the job folder.
  try {
    const meta = await google.getFileMeta(folderId);
    for (const parent of meta.parents ?? []) {
      const job = await one<{ id: string }>("select id from jobs where drive_folder_id = $1", [parent]);
      if (job) return job.id;
    }
  } catch {
    /* folder gone */
  }
  return null;
}

/**
 * Turns inbox files into candidates.
 * `fallbackJobId` is used for files outside a job folder; `sourceId` (if given) overrides the folder-detected source.
 */
export async function importDriveFiles(fileIds: string[], fallbackJobId: string | null, actorId: string | null, sourceId?: string | null): Promise<string[]> {
  if (!fileIds.length) return [];
  const rows = await q<{ drive_file_id: string; file_name: string; mime_type: string; folder_id: string | null; source_id: string | null; size_kb: number; modified_at: string | null }>(
    "select * from drive_files where drive_file_id = any($1::text[]) and status = 'inbox'",
    [fileIds],
  );
  const created: string[] = [];
  const folderJob = new Map<string, string | null>();
  for (const f of rows) {
    const key = f.folder_id ?? "";
    if (!folderJob.has(key)) folderJob.set(key, await jobForFolder(f.folder_id));
    const jobId = folderJob.get(key) ?? fallbackJobId;
    const resume: ResumeFile = {
      storage: "drive",
      driveFileId: f.drive_file_id,
      fileName: f.file_name,
      mimeType: f.mime_type,
      sizeKb: f.size_kb,
      uploadedAt: f.modified_at ?? new Date().toISOString(),
      uploadedById: actorId ?? "",
      driveUrl: `https://drive.google.com/file/d/${f.drive_file_id}/view`,
    };
    const id = await createCandidate({ resume, jobId, sourceId: sourceId || f.source_id, intake: "drive", actorId });
    await q("update drive_files set status = 'imported', candidate_id = $2 where drive_file_id = $1", [f.drive_file_id, id]);
    created.push(id);
  }
  return created;
}

/** Creates a sub-folder for every active source inside each open job's Drive folder, so people know where to drop files. */
export async function createSourceFolders(): Promise<{ jobs: number; folders: number }> {
  if (!(await google.isConnected())) return { jobs: 0, folders: 0 };
  const jobs = await q<{ id: string }>("select id from jobs where status <> 'closed'");
  const sources = await q<{ name: string }>("select name from sources where active order by position");
  let folders = 0;
  for (const job of jobs) {
    const jobFolder = await ensureJobFolder(job.id);
    if (!jobFolder) continue;
    for (const s of sources) {
      await google.findOrCreateFolder(s.name, jobFolder);
      folders++;
    }
  }
  return { jobs: jobs.length, folders };
}
