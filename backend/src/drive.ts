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
import { prisma } from "./db.ts";
import * as google from "./google.ts";
import { createCandidate } from "./pipeline.ts";
import { moveDriveFile, trackDriveImport } from "./resume-files.ts";
import { getSetting, patchSetting } from "./settings.ts";
import { ensureJobFolder } from "./storage.ts";

let syncing: Promise<{ found: number; imported: number }> | null = null;

export function syncDrive(): Promise<{ found: number; imported: number }> {
  syncing ??= doSync().finally(() => (syncing = null));
  return syncing;
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Root folder renamed in Settings: moves everything under the old root (job folders, loose resumes, _archive)
 * into the new one and returns the new root's id. Moved folders keep their ids, so jobs stay linked;
 * a folder that already exists by name in the new root is merged into it instead.
 */
export async function moveRootFolder(oldPath: string, oldId: string, newPath: string): Promise<string> {
  const newId = await google.ensureFolderPath(newPath);
  if (newId === oldId) return newId;
  const [from, to] = [pathParts(oldPath), pathParts(newPath)];
  // New root inside the old one (ATS/Resumes → ATS/Resumes/2026): don't move the folder that holds it into itself.
  const holdsNewRoot = to.length > from.length && from.every((s, i) => to[i] === s) ? to[from.length] : undefined;
  await moveContents(oldId, newId, holdsNewRoot);
  for (const j of await prisma.jobs.findMany({ where: { drive_folder_id: { not: null } }, select: { id: true, drive_folder: true } })) {
    const moved = rebasePath(j.drive_folder, oldPath, newPath);
    if (moved) await prisma.jobs.updateMany({ where: { id: j.id }, data: { drive_folder: moved } });
  }
  return newId;
}

const pathParts = (p: string) => p.split("/").map((s) => s.trim()).filter(Boolean);

/** "ATS/Resumes/Eng" under old root "ATS / Resumes" → "<new root>/Eng"; null when the path isn't inside the old root. */
export function rebasePath(stored: string, oldRoot: string, newRoot: string): string | null {
  const [path, from] = [pathParts(stored), pathParts(oldRoot)];
  if (path.length <= from.length || !from.every((s, i) => path[i] === s)) return null;
  return [...pathParts(newRoot), ...path.slice(from.length)].join("/");
}

async function moveContents(fromId: string, toId: string, skipName?: string) {
  const existing = new Map((await google.listSubfolders(toId)).map((f) => [f.name, f.id]));
  for (const f of await google.listFolder(fromId)) {
    if (f.name === skipName) continue;
    const target = f.mimeType === google.FOLDER ? existing.get(f.name) : undefined;
    if (!target) {
      // Folders keep their contents' versions; a loose file's own version changes, so record it.
      if (f.mimeType === google.FOLDER) await google.moveFile(f.id, toId);
      else await moveDriveFile(f.id, toId);
      continue;
    }
    await moveContents(f.id, target);
    await prisma.jobs.updateMany({ where: { drive_folder_id: f.id }, data: { drive_folder_id: target } });
    await prisma.drive_files.updateMany({ where: { folder_id: f.id }, data: { folder_id: target } });
  }
}

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
  const jobs = await prisma.jobs.findMany({ select: { id: true, title: true, drive_folder_id: true } });
  const sources = await prisma.sources.findMany({ select: { id: true, name: true } });
  const sourceFor = (folderName: string) => sources.find((s) => norm(s.name) === norm(folderName) || s.id === norm(folderName))?.id ?? null;

  const folders: ScanFolder[] = [{ id: rootId, name: g.driveRootFolder, jobId: null, sourceId: null }];
  for (const f of await google.listSubfolders(rootId)) {
    // Job folders are matched by id, or by name for folders people created by hand.
    let job = jobs.find((j) => j.drive_folder_id === f.id) ?? jobs.find((j) => !j.drive_folder_id && norm(j.title) === norm(f.name));
    if (job && !job.drive_folder_id) {
      job.drive_folder_id = f.id;
      await prisma.jobs.updateMany({ where: { id: job.id }, data: { drive_folder_id: f.id, drive_folder: `${g.driveRootFolder}/${f.name}` } });
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
      const inserted = await prisma.drive_files.createMany({
        data: {
          drive_file_id: f.id,
          file_name: f.name,
          mime_type: f.mimeType,
          folder_id: folder.id,
          folder_name: folder.name,
          source_id: folder.sourceId,
          size_kb: Math.max(1, Math.round(Number(f.size ?? 0) / 1024)),
          modified_at: f.modifiedTime ?? null,
        },
        skipDuplicates: true,
      });
      if (inserted.count) {
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
  const direct = await prisma.jobs.findFirst({ where: { drive_folder_id: folderId }, select: { id: true } });
  if (direct) return direct.id;
  // Source sub-folder: its parent is the job folder.
  try {
    const meta = await google.getFileMeta(folderId);
    for (const parent of meta.parents ?? []) {
      const job = await prisma.jobs.findFirst({ where: { drive_folder_id: parent }, select: { id: true } });
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
  const rows = await prisma.drive_files.findMany({ where: { drive_file_id: { in: fileIds }, status: "inbox" } });
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
      uploadedAt: (f.modified_at ?? new Date()).toISOString(),
      uploadedById: actorId ?? "",
      driveUrl: `https://drive.google.com/file/d/${f.drive_file_id}/view`,
    };
    const id = await createCandidate({ resume, jobId, sourceId: sourceId || f.source_id, intake: "drive", actorId });
    await prisma.drive_files.updateMany({ where: { drive_file_id: f.drive_file_id }, data: { status: "imported", candidate_id: id } });
    await trackDriveImport(id, f);
    created.push(id);
  }
  return created;
}

/** Creates a sub-folder for every active source inside each open job's Drive folder, so people know where to drop files. */
export async function createSourceFolders(): Promise<{ jobs: number; folders: number }> {
  if (!(await google.isConnected())) return { jobs: 0, folders: 0 };
  const jobs = await prisma.jobs.findMany({ where: { status: { not: "closed" } }, select: { id: true } });
  const sources = await prisma.sources.findMany({ where: { active: true }, orderBy: { position: "asc" }, select: { name: true } });
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
