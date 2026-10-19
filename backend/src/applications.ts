/**
 * Applications: one person's attempt at one job, with its own stage and an insert-only stage history.
 * An application is "open" while its stage is an active one (hired and closed are finished).
 */
import { logActivity, touch, touchCandidate } from "./activity.ts";
import { prisma } from "./db.ts";
import * as google from "./google.ts";
import { HttpError } from "./http.ts";
import { markCandidatesDeleted, replaceResumeFile } from "./resume-files.ts";
import { readResume } from "./storage.ts";
import { enqueue, type Db } from "./sync-queue.ts";
import type { ResumeFile } from "../../frontend/src/types.ts";

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

const slug = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 48) || "reason";

/**
 * Replaces the rejection reason list (order = position). New labels get a slug id. A reason left out is deleted,
 * unless some history row used it: then it's only retired (inactive), so old records keep pointing at it.
 */
export async function saveRejectionReasons(list: { id?: string; label: string; active: boolean }[]) {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.rejection_reasons.findMany({ select: { id: true } });
    const taken = new Set(existing.map((r) => r.id));
    const keep = new Set<string>();
    for (const [position, r] of list.entries()) {
      let id = r.id && taken.has(r.id) ? r.id : slug(r.label);
      if (!r.id || !taken.has(r.id)) for (let n = 2; taken.has(id); n++) id = `${slug(r.label)}_${n}`;
      taken.add(id);
      keep.add(id);
      await tx.rejection_reasons.upsert({ where: { id }, create: { id, label: r.label, active: r.active, position }, update: { label: r.label, active: r.active, position } });
    }
    const dropped = existing.map((r) => r.id).filter((id) => !keep.has(id));
    const used = new Set((await tx.stage_transitions.findMany({ where: { reason_id: { in: dropped } }, distinct: ["reason_id"], select: { reason_id: true } })).map((t) => t.reason_id!));
    await tx.rejection_reasons.updateMany({ where: { id: { in: [...used] } }, data: { active: false } });
    await tx.rejection_reasons.deleteMany({ where: { id: { in: dropped.filter((id) => !used.has(id)) } } });
  });
}

/** Adds a note to a person, optionally written under one of their applications (which then moves to the top). */
export async function addNote(input: { candidateId: string; applicationId?: string | null; body: string; actorId: string | null }) {
  if (input.applicationId && !(await prisma.applications.findFirst({ where: { id: input.applicationId, candidate_id: input.candidateId }, select: { id: true } })))
    throw new HttpError(400, "That application belongs to someone else");
  await prisma.notes.create({ data: { candidate_id: input.candidateId, application_id: input.applicationId ?? null, author_id: input.actorId, body: input.body } });
  if (input.applicationId) await touch([input.applicationId]);
  else await touchCandidate(input.candidateId);
}

/** Owner and job changes count as work on the application; rating and starring don't move the card. */
export async function updateApplication(id: string, patch: { rating?: number; starred?: boolean; ownerId?: string | null; jobId?: string | null }, actorId: string | null) {
  const data = { rating: patch.rating, starred: patch.starred, owner_id: patch.ownerId, job_id: patch.jobId };
  if (Object.values(data).every((v) => v === undefined)) return;
  const meaningful = patch.ownerId !== undefined || patch.jobId !== undefined;
  await prisma.applications.updateMany({ where: { id }, data: meaningful ? { ...data, last_activity_at: new Date() } : data });
  if (meaningful) {
    const a = await prisma.applications.findUnique({ where: { id }, select: { candidate_id: true, candidates: { select: { first_name: true, last_name: true } } } });
    if (a) await logActivity(actorId, "candidate_updated", `updated the ${[patch.ownerId !== undefined && "owner", patch.jobId !== undefined && "job"].filter(Boolean).join(" and ")} for ${fullName(a.candidates)}`, a.candidate_id);
  }
}

/**
 * The older candidate this one looks like: same email (ignoring case and spaces) or the same last 10 digits of
 * phone. Blank or short values never match, and pairs a recruiter kept separate are skipped.
 */
export async function findDuplicate(candidateId: string): Promise<string | null> {
  const [row] = await prisma.$queryRaw<{ id: string }[]>`
    select o.id from candidates c join candidates o
      on (o.created_at, o.id) < (c.created_at, c.id)
     and not (o.id = any(c.kept_separate_from)) and not (c.id = any(o.kept_separate_from))
     and ((lower(trim(c.email)) <> '' and lower(trim(o.email)) = lower(trim(c.email)))
       or (length(regexp_replace(c.phone, '[^0-9]', '', 'g')) >= 10
           and right(regexp_replace(o.phone, '[^0-9]', '', 'g'), 10) = right(regexp_replace(c.phone, '[^0-9]', '', 'g'), 10)))
    where c.id = ${candidateId}::uuid
    order by o.created_at asc limit 1`;
  return row?.id ?? null;
}

/** A recruiter confirmed these are two different people. */
export async function keepSeparate(candidateId: string, otherId: string) {
  await prisma.$executeRaw`update candidates set possible_duplicate_of = null,
    kept_separate_from = array_append(array_remove(kept_separate_from, ${otherId}::uuid), ${otherId}::uuid) where id = ${candidateId}::uuid`;
}

/**
 * Folds a duplicate record into the person it duplicates. Their applications move over; one for a job the target
 * already has open is folded into the target's (its interviews and notes follow, the target's stage and history win).
 * The duplicate's newer resume becomes the target's current version. The file step runs first, so if it fails
 * nothing has changed yet.
 */
export async function mergeCandidate(dupId: string, targetId: string, actorId: string | null) {
  if (dupId === targetId) throw new HttpError(400, "A candidate can't be merged into itself");
  const [dup, target] = await Promise.all([
    prisma.candidates.findUnique({ where: { id: dupId }, select: { first_name: true, last_name: true, resume: true } }),
    prisma.candidates.findUnique({ where: { id: targetId }, select: { first_name: true, last_name: true } }),
  ]);
  if (!dup || !target) throw new HttpError(404, "Candidate not found");

  // ponytail: only an S3-backed resume can be swapped in place; otherwise the target keeps its file and the
  // duplicate's goes into the normal deletion grace period (restorable from Settings → Resume sync).
  const [dupFile, targetFile] = await Promise.all([
    prisma.resume_files.findUnique({ where: { candidate_id: dupId } }),
    prisma.resume_files.findUnique({ where: { candidate_id: targetId } }),
  ]);
  if (dupFile?.s3_key && targetFile?.s3_key) {
    const { data } = await readResume(dup.resume as unknown as ResumeFile);
    await replaceResumeFile(targetId, { fileName: dupFile.file_name, data });
  }

  const moved = await prisma.$transaction(async (tx) => {
    const targetOpen = await tx.applications.findMany({ where: { candidate_id: targetId, job_id: { not: null }, stages: { kind: "active" } }, select: { id: true, job_id: true } });
    const openFor = new Map(targetOpen.map((a) => [a.job_id!, a.id]));
    let moved = 0;
    for (const a of await tx.applications.findMany({ where: { candidate_id: dupId }, select: { id: true, job_id: true, stages: { select: { kind: true } } } })) {
      const into = a.job_id && a.stages.kind === "active" ? openFor.get(a.job_id) : undefined;
      if (into) {
        await tx.interviews.updateMany({ where: { application_id: a.id }, data: { application_id: into } });
        await tx.notes.updateMany({ where: { application_id: a.id }, data: { application_id: into } });
        await tx.email_messages.updateMany({ where: { application_id: a.id }, data: { application_id: into } });
        await tx.applications.delete({ where: { id: a.id } });
      } else {
        await tx.applications.update({ where: { id: a.id }, data: { candidate_id: targetId } });
        moved++;
      }
    }
    for (const table of [tx.notes, tx.interviews, tx.activity, tx.email_messages, tx.drive_files] as const)
      await (table as typeof tx.notes).updateMany({ where: { candidate_id: dupId }, data: { candidate_id: targetId } });
    await tx.candidates.update({ where: { id: targetId }, data: { possible_duplicate_of: null } });
    await touch((await tx.applications.findMany({ where: { candidate_id: targetId }, select: { id: true } })).map((a) => a.id), tx);
    return moved;
  });

  // A newer application may be for another job: the person's Drive file follows it.
  if (moved && targetFile && (await google.isConnected())) await enqueue(targetFile.id, "move_drive");
  await markCandidatesDeleted([dupId]);
  await logActivity(actorId, "candidate_updated", `merged ${fullName(dup)} into ${fullName(target)}`, targetId);
}
