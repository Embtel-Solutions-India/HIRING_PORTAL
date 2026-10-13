import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { logActivity } from "../activity.ts";
import { prisma } from "../db.ts";
import { createSourceFolders, importDriveFiles, syncDrive } from "../drive.ts";
import { requirePerm } from "../http.ts";

export default async function driveRoutes(app: FastifyInstance) {
  app.post("/api/drive/sync", async (req) => {
    requirePerm(req, "resumes.upload");
    return syncDrive();
  });

  app.post("/api/drive/import", async (req) => {
    const user = requirePerm(req, "resumes.upload");
    const body = z
      .object({
        fileIds: z.array(z.string().min(1)).min(1).max(200),
        jobId: z.string().uuid().nullable().optional(),
        /** Applies one source to every file; omit to use the source detected from each file's folder. */
        sourceId: z.string().max(64).nullable().optional(),
      })
      .parse(req.body);
    const created = await importDriveFiles(body.fileIds, body.jobId ?? null, user.id, body.sourceId);
    return { created };
  });

  app.post("/api/drive/ignore", async (req) => {
    requirePerm(req, "resumes.upload");
    const { fileIds } = z.object({ fileIds: z.array(z.string().min(1)).min(1) }).parse(req.body);
    await prisma.drive_files.updateMany({ where: { drive_file_id: { in: fileIds } }, data: { status: "ignored" } });
    return { ok: true };
  });

  app.post("/api/drive/source-folders", async (req) => {
    const user = requirePerm(req, "sources.manage");
    const result = await createSourceFolders();
    await logActivity(user.id, "settings_changed", `created source folders in Google Drive for ${result.jobs} job${result.jobs === 1 ? "" : "s"}`);
    return result;
  });
}
