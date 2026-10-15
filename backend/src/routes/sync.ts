import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { logActivity } from "../activity.ts";
import { prisma } from "../db.ts";
import { HttpError, isUuid, requirePerm } from "../http.ts";
import { restoreResume, startMigration } from "../resume-files.ts";
import { s3Configured } from "../s3.ts";
import { getSetting } from "../settings.ts";
import { enqueue, retryRow } from "../sync-queue.ts";
import { resolveConflict } from "../sync-jobs.ts";

const STATES = ["pending", "synced", "conflict", "failed", "pending_deletion", "deleted"] as const;

export default async function syncRoutes(app: FastifyInstance) {
  app.get("/api/sync/status", async (req) => {
    requirePerm(req, "storage.manage");
    const [byState, queuedJobs, review, lastJob, [mig], changes, migration] = await Promise.all([
      prisma.resume_files.groupBy({ by: ["state"], _count: { _all: true } }),
      prisma.sync_jobs.count({ where: { status: { in: ["queued", "running"] } } }),
      prisma.resume_files.count({ where: { review_reason: { not: null } } }),
      prisma.sync_jobs.findFirst({ where: { status: "done" }, orderBy: { finished_at: "desc" }, select: { finished_at: true } }),
      prisma.$queryRaw<{ total: number; verified: number }[]>`
        select count(*)::int as total, count(*) filter (where resume->>'storage' = 's3')::int as verified
        from candidates where coalesce(resume->>'driveFileId', '') <> '' or resume->>'resumeFileId' is not null`,
      getSetting("driveChanges"),
      getSetting("migration"),
    ]);
    const counts = Object.fromEntries(STATES.map((s) => [s, byState.find((b) => b.state === s)?._count._all ?? 0]));
    return {
      s3Configured: s3Configured(),
      total: byState.reduce((n, b) => n + b._count._all, 0),
      counts,
      queuedJobs,
      review,
      migration: { verified: mig?.verified ?? 0, total: mig?.total ?? 0, startedAt: migration.startedAt },
      lastDriveSyncAt: changes.lastSuccessAt,
      lastJobAt: lastJob?.finished_at?.toISOString() ?? null,
    };
  });

  app.get("/api/sync/items", async (req) => {
    requirePerm(req, "storage.manage");
    const { state } = z.object({ state: z.enum(["conflict", "failed", "pending_deletion", "review"]) }).parse(req.query);
    const rows = await prisma.resume_files.findMany({
      where: state === "review" ? { review_reason: { not: null } } : { state },
      orderBy: { updated_at: "desc" },
      take: 200,
      include: { candidates: { select: { first_name: true, last_name: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      candidateId: r.candidate_id,
      candidateName: r.candidates ? `${r.candidates.first_name} ${r.candidates.last_name}`.trim() : "(candidate deleted)",
      fileName: r.file_name,
      state: r.state,
      lastError: r.last_error,
      conflict: r.conflict,
      deleteAfter: r.delete_after?.toISOString() ?? null,
      deletedSide: r.deleted_side,
      reviewReason: r.review_reason,
      updatedAt: r.updated_at.toISOString(),
    }));
  });

  const rowFor = async (id: string) => {
    const row = isUuid(id) ? await prisma.resume_files.findUnique({ where: { id } }) : null;
    if (!row) throw new HttpError(404, "Not found");
    return row;
  };

  app.post("/api/sync/items/:id/:action", async (req) => {
    const user = requirePerm(req, "storage.manage");
    const { id, action } = z.object({ id: z.string(), action: z.enum(["retry", "keep-portal", "keep-drive", "restore", "delete-now", "reviewed"]) }).parse(req.params);
    const row = await rowFor(id);
    switch (action) {
      case "retry":
        await retryRow(row.id);
        break;
      case "keep-portal":
      case "keep-drive": {
        const portal = action === "keep-portal";
        await resolveConflict(row, portal ? "portal" : "drive");
        await logActivity(user.id, "settings_changed", `resolved a resume conflict for ${row.file_name} (kept the ${portal ? "portal" : "Drive"} version)`);
        break;
      }
      case "restore":
        await restoreResume(row, user.id);
        await logActivity(user.id, "settings_changed", `restored the resume ${row.file_name}`);
        break;
      case "delete-now":
        if (row.state !== "pending_deletion") throw new HttpError(409, "Only resumes pending deletion can be deleted now");
        await prisma.resume_files.update({ where: { id: row.id }, data: { delete_after: new Date(), updated_at: new Date() } });
        await enqueue(row.id, "purge");
        await logActivity(user.id, "settings_changed", `deleted the resume ${row.file_name} now`);
        break;
      case "reviewed":
        await prisma.resume_files.update({ where: { id: row.id }, data: { review_reason: null, updated_at: new Date() } });
        break;
    }
    return { ok: true };
  });

  app.post("/api/sync/retry-failed", async (req) => {
    requirePerm(req, "storage.manage");
    const rows = await prisma.resume_files.findMany({ where: { state: "failed" }, select: { id: true } });
    for (const r of rows) await retryRow(r.id);
    return { retried: rows.length };
  });

  app.post("/api/sync/migrate", async (req) => {
    const user = requirePerm(req, "storage.manage");
    if (!s3Configured()) throw new HttpError(409, "S3 isn't configured — set AWS_REGION and S3_BUCKET first");
    const result = await startMigration();
    await logActivity(user.id, "settings_changed", `started the resume migration to S3 (${result.queued} queued)`);
    return result;
  });
}
