/** Resume files live in Google Drive when it's connected, otherwise on the server's disk (DATA_DIR). */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ResumeFile } from "../../frontend/src/types.ts";
import { config } from "./config.ts";
import { prisma } from "./db.ts";
import * as google from "./google.ts";
import { HttpError } from "./http.ts";
import { resumeJson } from "./resume-files.ts";
import * as s3 from "./s3.ts";
import { getSetting } from "./settings.ts";
import { digest, s3KeyFor, s3MimeFor } from "./sync-rules.ts";

const localDir = () => path.join(config.dataDir, "resumes");

export function mimeFor(fileName: string, fallback = "application/octet-stream") {
  const ext = fileName.toLowerCase().split(".").pop();
  if (ext === "pdf") return "application/pdf";
  if (ext === "docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === "doc") return "application/msword";
  return fallback;
}

/** Makes sure the job has a Drive folder (under the root folder) and returns its id. */
export async function ensureJobFolder(jobId: string): Promise<string | null> {
  if (!(await google.isConnected())) return null;
  const job = await prisma.jobs.findUnique({ where: { id: jobId }, select: { id: true, title: true, drive_folder_id: true } });
  if (!job) return null;
  if (job.drive_folder_id) return job.drive_folder_id;
  const root = await google.ensureRootFolder();
  const folderId = await google.findOrCreateFolder(job.title, root);
  const g = await getSetting("google");
  await prisma.jobs.updateMany({ where: { id: job.id }, data: { drive_folder_id: folderId, drive_folder: `${g.driveRootFolder}/${job.title}` } });
  return folderId;
}

/** The Drive folder a resume belongs in: <root>/<Job>/<Source>/ (or the root when there's no job). */
export async function driveFolderFor(jobId: string | null, sourceName?: string | null): Promise<string | null> {
  let folderId = jobId ? await ensureJobFolder(jobId) : (await google.isConnected()) ? await google.ensureRootFolder() : null;
  if (folderId && jobId && sourceName) folderId = await google.findOrCreateFolder(sourceName, folderId);
  return folderId;
}

export async function storeResume(input: { jobId: string | null; sourceName?: string | null; fileName: string; data: Buffer; uploadedById: string }): Promise<ResumeFile> {
  const mimeType = mimeFor(input.fileName);
  const base = { fileName: input.fileName, mimeType, sizeKb: Math.max(1, Math.round(input.data.length / 1024)), uploadedAt: new Date().toISOString(), uploadedById: input.uploadedById };
  if (s3.s3Configured()) {
    // S3 is the primary copy: write and verify it now; the Drive copy follows via the sync queue.
    const { sha256 } = digest(input.data);
    const row = await prisma.resume_files.create({ data: { file_name: input.fileName, mime_type: mimeType, size_bytes: input.data.length } });
    try {
      const key = s3KeyFor(row.id, input.fileName, mimeType);
      const versionId = await s3.putVerified(key, input.data, mimeType, sha256).catch((e) => {
        throw e?.name === "ChecksumMismatch" ? new HttpError(502, "The upload to S3 couldn't be verified — try again") : e;
      });
      const saved = await prisma.resume_files.update({ where: { id: row.id }, data: { s3_key: key, s3_version_id: versionId, sha256 } });
      return resumeJson(saved, { uploadedAt: base.uploadedAt, uploadedById: input.uploadedById });
    } catch (e) {
      await prisma.resume_files.delete({ where: { id: row.id } }).catch(() => {});
      throw e;
    }
  }
  const folderId = await driveFolderFor(input.jobId, input.sourceName);
  if (folderId) {
    const file = await google.uploadFile(folderId, input.fileName, mimeType, input.data);
    // Remember it so the Drive sync doesn't import it a second time.
    await prisma.drive_files.createMany({
      data: { drive_file_id: file.id, file_name: input.fileName, mime_type: mimeType, folder_id: folderId, size_kb: base.sizeKb, status: "imported" },
      skipDuplicates: true,
    });
    return { ...base, storage: "drive", driveFileId: file.id, driveUrl: file.webViewLink ?? `https://drive.google.com/file/d/${file.id}/view` };
  }
  const id = crypto.randomUUID();
  await fs.mkdir(localDir(), { recursive: true });
  await fs.writeFile(path.join(localDir(), id), input.data);
  return { ...base, storage: "local", driveFileId: id, driveUrl: "" };
}

export async function readResume(resume: ResumeFile): Promise<{ data: Buffer; mimeType: string }> {
  if (resume.storage === "s3" && resume.resumeFileId) {
    const row = await prisma.resume_files.findUnique({ where: { id: resume.resumeFileId } });
    if (row?.s3_key) return { data: await s3.get(row.s3_key, row.s3_version_id ?? undefined), mimeType: s3MimeFor(row.mime_type) };
  }
  if (resume.storage === "local") {
    if (!/^[0-9a-f-]{36}$/.test(resume.driveFileId)) throw new Error("Bad file id");
    return { data: await fs.readFile(path.join(localDir(), resume.driveFileId)), mimeType: resume.mimeType };
  }
  return google.downloadFile(resume.driveFileId, resume.mimeType);
}
