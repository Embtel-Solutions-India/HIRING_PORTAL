/**
 * Applications: one person's attempt at one job, with its own stage and an insert-only stage history.
 * An application is "open" while its stage is an active one (hired and closed are finished).
 */
import { logActivity } from "./activity.ts";
import { prisma } from "./db.ts";
import { HttpError } from "./http.ts";
import type { Db } from "./sync-queue.ts";

const fullName = (c: { first_name: string; last_name: string }) => `${c.first_name} ${c.last_name}`.trim();

/** Starts an application in the first active stage. A person can't have two open applications for the same job. */
export async function createApplication(input: { candidateId: string; jobId: string | null; actorId: string | null; ownerId?: string | null }, db: Db = prisma): Promise<string> {
  if (input.jobId) {
    const open = await db.applications.findFirst({ where: { candidate_id: input.candidateId, job_id: input.jobId, stages: { kind: "active" } }, select: { candidates: { select: { first_name: true, last_name: true } } } });
    if (open) throw new HttpError(409, `${fullName(open.candidates) || "This candidate"} already has an open application for this job`);
  }
  const stage = await db.stages.findFirst({ where: { kind: "active" }, orderBy: { position: "asc" }, select: { id: true } });
  if (!stage) throw new HttpError(400, "Add an in-progress stage first");
  const app = await db.applications.create({
    data: { candidate_id: input.candidateId, job_id: input.jobId, stage_id: stage.id, owner_id: input.ownerId === undefined ? input.actorId : input.ownerId },
    select: { id: true },
  });
  await db.stage_transitions.create({ data: { application_id: app.id, from_stage_id: null, to_stage_id: stage.id, actor_id: input.actorId } });
  return app.id;
}

/**
 * Moves applications to a stage and records each move. A move into a closed stage needs an active rejection reason;
 * applications already in the stage are skipped (no history row, no touch).
 */
export async function moveApplications(input: { ids: string[]; stageId: string; actorId: string | null; reasonId?: string | null; note?: string | null }): Promise<{ id: string; candidateId: string }[]> {
  const stage = await prisma.stages.findUnique({ where: { id: input.stageId } });
  if (!stage) throw new HttpError(400, "Unknown stage");
  const reason = stage.kind === "closed" && input.reasonId ? await prisma.rejection_reasons.findFirst({ where: { id: input.reasonId, active: true } }) : null;
  if (stage.kind === "closed" && !reason) throw new HttpError(400, "Pick a reason for not moving forward");
  const note = input.note?.trim() || null;
  const now = new Date();
  const moved = await prisma.$transaction(async (tx) => {
    const rows = await tx.applications.findMany({
      where: { id: { in: input.ids }, stage_id: { not: stage.id } },
      select: { id: true, stage_id: true, candidate_id: true, candidates: { select: { first_name: true, last_name: true } } },
    });
    if (!rows.length) return rows;
    await tx.applications.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { stage_id: stage.id, stage_entered_at: now, last_activity_at: now } });
    await tx.stage_transitions.createMany({
      data: rows.map((r) => ({ application_id: r.id, from_stage_id: r.stage_id, to_stage_id: stage.id, actor_id: input.actorId, reason_id: reason?.id ?? null, reason_label: reason?.label ?? null, note, created_at: now })),
    });
    return rows;
  });
  for (const r of moved) await logActivity(input.actorId, "stage_change", `moved ${fullName(r.candidates)} to ${stage.name}${reason ? ` · ${reason.label}` : ""}`, r.candidate_id);
  return moved.map((r) => ({ id: r.id, candidateId: r.candidate_id }));
}

/** candidate id → that person's most recently touched application. */
export async function latestApplicationIds(candidateIds: string[]): Promise<Map<string, string>> {
  if (!candidateIds.length) return new Map();
  const rows = await prisma.$queryRaw<{ candidate_id: string; id: string }[]>`
    select distinct on (candidate_id) candidate_id, id from applications
    where candidate_id = any(${candidateIds}::uuid[]) order by candidate_id, last_activity_at desc`;
  return new Map(rows.map((r) => [r.candidate_id, r.id]));
}

/** The person's most recently created open application (decides which job folder their Drive file lives in). */
export async function newestOpenApplication(candidateId: string): Promise<{ id: string; jobId: string | null } | null> {
  const a = await prisma.applications.findFirst({ where: { candidate_id: candidateId, stages: { kind: "active" } }, orderBy: { created_at: "desc" }, select: { id: true, job_id: true } });
  return a ? { id: a.id, jobId: a.job_id } : null;
}
