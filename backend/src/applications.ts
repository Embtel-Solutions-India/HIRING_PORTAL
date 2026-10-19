/**
 * Applications: one person's attempt at one job, with its own stage and an insert-only stage history.
 * An application is "open" while its stage is an active one (hired and closed are finished).
 */
import { fullName, logActivity, touch, touchCandidate } from "./activity.ts";
import { Prisma, prisma } from "./db.ts";
import * as google from "./google.ts";
import { HttpError } from "./http.ts";
import { enqueueParse } from "./pipeline.ts";
import { markCandidatesDeleted, replaceResumeFile } from "./resume-files.ts";
import { readResume } from "./storage.ts";
import { enqueue, type Db } from "./sync-queue.ts";
import type { ResumeFile } from "../../frontend/src/types.ts";


/**
 * Holds a per-(person, job) lock until the transaction ends, then refuses if the person already has an open
 * application for that job. Serialises double-clicks and concurrent recruiters; the rule spans a join to stages,
 * so a plain unique index can't express it.
 */
async function assertNoOtherOpen(tx: Prisma.TransactionClient, candidateId: string, jobId: string, exceptId?: string) {
  await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${`${candidateId}:${jobId}`}))`;
  const open = await tx.applications.findFirst({
    where: { candidate_id: candidateId, job_id: jobId, stages: { kind: "active" }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { candidates: { select: { first_name: true, last_name: true } } },
  });
  if (open) throw new HttpError(409, `${fullName(open.candidates) || "This candidate"} already has an open application for this job`);
}

/** Runs `fn` in the caller's transaction, or in a new one when given the plain client. */
const inTx = <T,>(db: Db, fn: (tx: Prisma.TransactionClient) => Promise<T>) => (db === prisma ? prisma.$transaction(fn) : fn(db as Prisma.TransactionClient));

/** Starts an application in the first active stage. A person can't have two open applications for the same job. */
export async function createApplication(input: { candidateId: string; jobId: string | null; actorId: string | null; ownerId?: string | null }, db: Db = prisma): Promise<string> {
  return inTx(db, async (tx) => {
    if (input.jobId) await assertNoOtherOpen(tx, input.candidateId, input.jobId);
    const stage = await tx.stages.findFirst({ where: { kind: "active" }, orderBy: { position: "asc" }, select: { id: true } });
    if (!stage) throw new HttpError(400, "Add an in-progress stage first");
    const app = await tx.applications.create({
      data: { candidate_id: input.candidateId, job_id: input.jobId, stage_id: stage.id, owner_id: input.ownerId === undefined ? input.actorId : input.ownerId },
      select: { id: true },
    });
    await tx.stage_transitions.create({ data: { application_id: app.id, from_stage_id: null, to_stage_id: stage.id, actor_id: input.actorId } });
    return app.id;
  });
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

/** The person's most recently created open application. */
export async function newestOpenApplication(candidateId: string): Promise<{ id: string; jobId: string | null } | null> {
  const a = await prisma.applications.findFirst({ where: { candidate_id: candidateId, stages: { kind: "active" } }, orderBy: { created_at: "desc" }, select: { id: true, job_id: true } });
  return a ? { id: a.id, jobId: a.job_id } : null;
}

/** The application a self-booked interview belongs to: the open one worked on most recently, else the latest at all. */
export async function bookingApplication(candidateId: string): Promise<string | null> {
  const open = await prisma.applications.findFirst({ where: { candidate_id: candidateId, stages: { kind: "active" } }, orderBy: { last_activity_at: "desc" }, select: { id: true } });
  if (open) return open.id;
  return (await prisma.applications.findFirst({ where: { candidate_id: candidateId }, orderBy: { last_activity_at: "desc" }, select: { id: true } }))?.id ?? null;
}

/** The job whose Drive folder holds the person's resume: their newest open application, else their newest one of any stage. */
export async function driveFolderJob(candidateId: string): Promise<string | null> {
  const open = await newestOpenApplication(candidateId);
  if (open) return open.jobId;
  const any = await prisma.applications.findFirst({ where: { candidate_id: candidateId }, orderBy: { created_at: "desc" }, select: { job_id: true } });
  return any?.job_id ?? null;
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
  const current = await prisma.applications.findUnique({ where: { id }, select: { candidate_id: true, job_id: true, stages: { select: { kind: true } } } });
  if (!current) throw new HttpError(404, "Application not found");
  const jobChanged = patch.jobId !== undefined && patch.jobId !== current.job_id;
  if (jobChanged && patch.jobId && !(await prisma.jobs.findUnique({ where: { id: patch.jobId }, select: { id: true } }))) throw new HttpError(400, "Unknown job");
  await prisma.$transaction(async (tx) => {
    // Same rule as creating one: at most one open application per person per job.
    if (jobChanged && patch.jobId && current.stages.kind === "active") await assertNoOtherOpen(tx, current.candidate_id, patch.jobId, id);
    // The AI match was scored against the old job; it's re-scored below.
    const update = { ...data, ...(meaningful ? { last_activity_at: new Date() } : {}), ...(jobChanged ? { summary: Prisma.DbNull } : {}) };
    await tx.applications.updateMany({ where: { id }, data: update });
    if (jobChanged) {
      await tx.interviews.updateMany({ where: { application_id: id }, data: { job_id: patch.jobId ?? null } });
      await tx.candidates.updateMany({ where: { id: current.candidate_id }, data: { parse_status: "pending" } });
    }
  });
  if (jobChanged) {
    enqueueParse(current.candidate_id);
    const rf = await prisma.resume_files.findUnique({ where: { candidate_id: current.candidate_id }, select: { id: true } });
    if (rf && (await google.isConnected())) await enqueue(rf.id, "move_drive");
  }
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

/** Merge takes the duplicate's resume only if it's the newer one and both are in S3 (swapped in place, same row). */
export function takesDuplicateFile(dupFile: { s3_key: string | null; updated_at: Date } | null, targetFile: { s3_key: string | null; updated_at: Date } | null) {
  return !!(dupFile?.s3_key && targetFile?.s3_key && dupFile.updated_at > targetFile.updated_at);
}

/**
 * Folds a duplicate record into the person it duplicates. Their applications move over; one for a job the target
 * already has open is folded into the target's (its interviews and notes follow, the target's stage and history win).
 * The newer of the two resumes becomes the target's current version. That file swap runs first and on its own: if
 * the database step then fails, the target keeps the new file version (its S3/Drive history has the old one) and
 * both people still exist. Everything else, including deleting the duplicate, is one transaction.
 */
export async function mergeCandidate(dupId: string, targetId: string, actorId: string | null) {
  if (dupId === targetId) throw new HttpError(400, "A candidate can't be merged into itself");
  const [dup, target] = await Promise.all([
    prisma.candidates.findUnique({ where: { id: dupId }, select: { first_name: true, last_name: true, resume: true } }),
    prisma.candidates.findUnique({ where: { id: targetId }, select: { first_name: true, last_name: true } }),
  ]);
  if (!dup || !target) throw new HttpError(404, "Candidate not found");

  // ponytail: only an S3-backed resume can be swapped in place. If the target has no S3 copy at all, it takes over the
  // duplicate's whole file record instead (below). Otherwise the target keeps its file and the duplicate's goes into the
  // normal deletion grace period (restorable from Settings → Resume sync); the same when the target's file is newer.
  const [dupFile, targetFile] = await Promise.all([
    prisma.resume_files.findUnique({ where: { candidate_id: dupId } }),
    prisma.resume_files.findUnique({ where: { candidate_id: targetId } }),
  ]);
  if (dupFile && takesDuplicateFile(dupFile, targetFile)) {
    const { data } = await readResume(dup.resume as unknown as ResumeFile);
    await replaceResumeFile(targetId, { fileName: dupFile.file_name, data });
  }

  // The target has nothing usable in S3 but the duplicate does: hand the duplicate's file over rather than delete it.
  const handOver = !!dupFile?.s3_key && !targetFile?.s3_key;

  const moved = await prisma.$transaction(async (tx) => {
    if (handOver) {
      // resume_files.candidate_id is unique: park the duplicate's row, give the target's old row (if any) to the
      // duplicate so it's deleted with it, then attach the duplicate's row to the target.
      await tx.resume_files.update({ where: { id: dupFile!.id }, data: { candidate_id: null } });
      if (targetFile) await tx.resume_files.update({ where: { id: targetFile.id }, data: { candidate_id: dupId } });
      await tx.resume_files.update({ where: { id: dupFile!.id }, data: { candidate_id: targetId, updated_at: new Date() } });
      await tx.candidates.update({ where: { id: targetId }, data: { resume: dup.resume ?? Prisma.DbNull } });
    }
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
    // Re-score after the duplicate's applications have arrived, so every open one is scored against the current resume.
    await tx.candidates.update({ where: { id: targetId }, data: { possible_duplicate_of: null, parse_status: "pending" } });
    await touch((await tx.applications.findMany({ where: { candidate_id: targetId }, select: { id: true } })).map((a) => a.id), tx);
    await markCandidatesDeleted([dupId], tx);
    return moved;
  });

  enqueueParse(targetId);
  // A newer application may be for another job (or the file came from the duplicate): the Drive file follows.
  const fileId = handOver ? dupFile!.id : targetFile?.id;
  if ((moved || handOver) && fileId && (await google.isConnected())) await enqueue(fileId, "move_drive");
  await logActivity(actorId, "candidate_updated", `merged ${fullName(dup)} into ${fullName(target)}`, targetId);
}
