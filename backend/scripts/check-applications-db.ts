// Run against a local database: DATABASE_URL=postgres://postgres:postgres@localhost:5433/hirely npm run check:applications-db
// Database-level checks of applications, stage history, rejection reasons, reapply and merge.
import assert from "node:assert/strict";
import { addNote, createApplication, findDuplicate, keepSeparate, mergeCandidate, moveApplications, saveRejectionReasons, updateApplication } from "../src/applications.ts";
import { prisma } from "../src/db.ts";
import { createCandidate } from "../src/pipeline.ts";
import { runJob } from "../src/sync-jobs.ts";
import { claimNext, enqueue } from "../src/sync-queue.ts";

if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? "")) throw new Error("check-applications-db only runs against a local DATABASE_URL");

// Leftovers from a run that failed halfway.
await prisma.candidates.deleteMany({ where: { first_name: "CHK" } });

// B1: backfill invariants
{
  const [orphans] = await prisma.$queryRaw<{ n: number }[]>`select count(*)::int n from candidates c where not exists (select 1 from applications a where a.candidate_id = c.id)`;
  assert.equal(orphans!.n, 0, "B1: every candidate has an application");
  const [noHistory] = await prisma.$queryRaw<{ n: number }[]>`select count(*)::int n from applications a where not exists (select 1 from stage_transitions t where t.application_id = a.id)`;
  assert.equal(noHistory!.n, 0, "B1: every application has at least one transition");
  const [unlinked] = await prisma.$queryRaw<{ n: number }[]>`select count(*)::int n from interviews where application_id is null`;
  assert.equal(unlinked!.n, 0, "B1: interviews linked");
  assert.ok((await prisma.rejection_reasons.count()) >= 7, "B1: reasons seeded");
  console.log("B1 ok");
}

const stages = await prisma.stages.findMany({ orderBy: { position: "asc" } });
const [active1, active2] = stages.filter((s) => s.kind === "active").map((s) => s.id) as [string, string];
const closed = stages.find((s) => s.kind === "closed")!.id;
const person = await prisma.candidates.create({ data: { first_name: "CHK", last_name: "App" } });
const personId = person.id;
const appId = await createApplication({ candidateId: personId, jobId: null, actorId: null });
assert.equal((await prisma.applications.findUniqueOrThrow({ where: { id: appId } })).stage_id, active1, "A0: starts in the first active stage");

// A1: move writes history + touches
{
  const before = (await prisma.applications.findUniqueOrThrow({ where: { id: appId } })).last_activity_at;
  await new Promise((r) => setTimeout(r, 5));
  await moveApplications({ ids: [appId], stageId: active2, actorId: null });
  const t = await prisma.stage_transitions.findMany({ where: { application_id: appId }, orderBy: { created_at: "asc" } });
  assert.equal(t.length, 2, "A1: entry + move");
  assert.equal(t[1]!.to_stage_id, active2);
  assert.equal(t[1]!.from_stage_id, active1);
  assert.ok((await prisma.applications.findUniqueOrThrow({ where: { id: appId } })).last_activity_at > before, "A1: touched");
  console.log("A1 ok");
}

// A2: closed needs a reason, and the reason is recorded
{
  await assert.rejects(moveApplications({ ids: [appId], stageId: closed, actorId: null }), /Pick a reason/, "A2");
  await assert.rejects(moveApplications({ ids: [appId], stageId: closed, actorId: null, reasonId: "nope" }), /Pick a reason/, "A2: unknown reason");
  await moveApplications({ ids: [appId], stageId: closed, actorId: null, reasonId: "skills", note: "no React" });
  const last = (await prisma.stage_transitions.findFirst({ where: { application_id: appId }, orderBy: { created_at: "desc" } }))!;
  assert.deepEqual([last.from_stage_id, last.reason_label, last.note], [active2, "Skills mismatch", "no React"], "A2: recorded");
  console.log("A2 ok");
}

// A3 (Review Focus 1): undo out of closed needs no reason, history keeps both
{
  await moveApplications({ ids: [appId], stageId: active2, actorId: null });
  assert.equal(await prisma.stage_transitions.count({ where: { application_id: appId } }), 4, "A3");
  console.log("A3 ok");
}

// A4 (Review Focus 2): already-in-stage is skipped silently
{
  const moved = await moveApplications({ ids: [appId], stageId: active2, actorId: null });
  assert.equal(moved.length, 0, "A4: nothing moved");
  assert.equal(await prisma.stage_transitions.count({ where: { application_id: appId } }), 4, "A4: no new row");
  await assert.rejects(moveApplications({ ids: [appId], stageId: "no-such-stage", actorId: null }), /Unknown stage/, "A4: unknown stage");
  console.log("A4 ok");
}

// R1 (Review Focus 4): a used reason is retired, not deleted; history keeps its label; it can't be picked again
{
  const seed = await prisma.rejection_reasons.findMany({ orderBy: { position: "asc" } });
  await moveApplications({ ids: [appId], stageId: closed, actorId: null, reasonId: "salary" });
  await saveRejectionReasons(seed.filter((r) => r.id !== "salary").map((r) => ({ id: r.id, label: r.label, active: r.active })));
  const salary = await prisma.rejection_reasons.findUnique({ where: { id: "salary" } });
  assert.equal(salary?.active, false, "R1: used reason retired, not deleted");
  assert.ok(await prisma.stage_transitions.findFirst({ where: { application_id: appId, reason_label: "Salary expectations" } }), "R1: label snapshot kept");
  await moveApplications({ ids: [appId], stageId: active2, actorId: null });
  await assert.rejects(moveApplications({ ids: [appId], stageId: closed, actorId: null, reasonId: "salary" }), /Pick a reason/, "R1: retired reason can't be picked");
  // A new label gets a slug id; an unused reason left out of the list is deleted.
  await saveRejectionReasons([...seed.filter((r) => r.id !== "salary").map((r) => ({ id: r.id, label: r.label, active: r.active })), { label: "Failed take-home test", active: true }]);
  const added = await prisma.rejection_reasons.findFirst({ where: { label: "Failed take-home test" } });
  assert.equal(added?.id, "failed_take_home_test", "R1: slug id");
  await saveRejectionReasons(seed.map((r) => ({ id: r.id, label: r.label, active: true })));
  assert.equal(await prisma.rejection_reasons.count({ where: { id: "failed_take_home_test" } }), 0, "R1: unused reason removed");
  assert.equal((await prisma.rejection_reasons.findUnique({ where: { id: "salary" } }))?.active, true, "R1: restored");
  console.log("R1 ok");
}

// T1: notes and owner changes bring a card to the top; starring and rating don't
{
  const lastActivity = async () => (await prisma.applications.findUniqueOrThrow({ where: { id: appId } })).last_activity_at.getTime();
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const t0 = await lastActivity();
  await tick();
  await addNote({ candidateId: personId, applicationId: appId, body: "x", actorId: null });
  const t1 = await lastActivity();
  assert.ok(t1 > t0, "T1: note touches");
  await tick();
  await updateApplication(appId, { starred: true, rating: 4 }, null);
  assert.equal(await lastActivity(), t1, "T1: star/rating don't touch");
  await updateApplication(appId, { ownerId: null }, null);
  assert.ok((await lastActivity()) > t1, "T1: owner change touches");
  await assert.rejects(addNote({ candidateId: personId, applicationId: "00000000-0000-0000-0000-000000000000", body: "x", actorId: null }), /someone else/, "T1: foreign application");
  console.log("T1 ok");
}

// RA1 (Review Focus 5): a closed application for job J doesn't block reapplying; an open one does
{
  const j = await prisma.jobs.create({ data: { title: "CHK Job" } });
  const first = await createApplication({ candidateId: personId, jobId: j.id, actorId: null });
  await moveApplications({ ids: [first], stageId: closed, actorId: null, reasonId: "skills" });
  const second = await createApplication({ candidateId: personId, jobId: j.id, actorId: null });
  assert.notEqual(first, second, "RA1: reapply after rejection allowed");
  assert.equal((await prisma.applications.findUniqueOrThrow({ where: { id: first } })).stage_id, closed, "RA1: old outcome untouched");
  await assert.rejects(createApplication({ candidateId: personId, jobId: j.id, actorId: null }), /already has an open application/, "RA1: open one blocks");
  await prisma.applications.deleteMany({ where: { job_id: j.id } });
  await prisma.jobs.delete({ where: { id: j.id } });
  console.log("RA1 ok");
}

// RA2: a move_drive job for a resume with no Drive file yet is a no-op
{
  await prisma.sync_jobs.deleteMany({ where: { status: { in: ["queued", "running"] } } });
  const rf = await prisma.resume_files.create({ data: { candidate_id: personId, file_name: "cv.pdf", mime_type: "application/pdf", state: "synced" } });
  await enqueue(rf.id, "move_drive");
  const job = (await claimNext())!;
  assert.equal(job.kind, "move_drive");
  await runJob(job);
  assert.equal((await prisma.sync_jobs.findFirstOrThrow({ where: { resume_file_id: rf.id, kind: "move_drive" } })).status, "done", "RA2");
  await prisma.resume_files.delete({ where: { id: rf.id } });
  console.log("RA2 ok");
}

// D1 (Review Focus 3): duplicates match on normalised email or the last 10 phone digits, never on blanks
{
  const mk = (last_name: string, email: string, phone: string) => prisma.candidates.create({ data: { first_name: "CHK", last_name, email, phone } });
  const a = await mk("A", "aman.dup@x.com", "9876543210");
  await new Promise((r) => setTimeout(r, 5));
  const b = await mk("B", " Aman.Dup@X.com ", "");
  const c = await mk("C", "", "+91 98765-43210");
  const d = await mk("D", "", "");
  await mk("E", "", "");
  const short = await mk("F", "", "12345");
  await mk("G", "", "12345");
  assert.equal(await findDuplicate(b.id), a.id, "D1: email case/space");
  assert.equal(await findDuplicate(c.id), a.id, "D1: phone formatting");
  assert.equal(await findDuplicate(d.id), null, "D1: empty never matches empty");
  assert.equal(await findDuplicate(short.id), null, "D1: short phone numbers don't match");
  assert.equal(await findDuplicate(a.id), null, "D1: the oldest record has no older duplicate");
  await keepSeparate(b.id, a.id);
  assert.equal(await findDuplicate(b.id), null, "D1: kept separate stays separate");
  console.log("D1 ok");
}

// M1: merging moves a different job's application over, folds a same-job open application into the target's,
// re-points notes, interviews and activity, and leaves one person
{
  const [j1, j2] = await Promise.all([prisma.jobs.create({ data: { title: "CHK J1" } }), prisma.jobs.create({ data: { title: "CHK J2" } })]);
  const target = await prisma.candidates.create({ data: { first_name: "CHK", last_name: "Target" } });
  await new Promise((r) => setTimeout(r, 5));
  const dup = await prisma.candidates.create({ data: { first_name: "CHK", last_name: "Dup", possible_duplicate_of: target.id } });
  await prisma.candidates.update({ where: { id: target.id }, data: { possible_duplicate_of: dup.id } });
  const targetJ1 = await createApplication({ candidateId: target.id, jobId: j1.id, actorId: null });
  const dupJ1 = await createApplication({ candidateId: dup.id, jobId: j1.id, actorId: null });
  const dupJ2 = await createApplication({ candidateId: dup.id, jobId: j2.id, actorId: null });
  await addNote({ candidateId: dup.id, applicationId: dupJ1, body: "dup note", actorId: null });
  await prisma.interviews.create({ data: { candidate_id: dup.id, application_id: dupJ1, job_id: j1.id, title: "CHK call", type: "phone", start_at: new Date(), duration_min: 30 } });
  await prisma.activity.create({ data: { type: "note", message: "CHK activity", candidate_id: dup.id } });

  await mergeCandidate(dup.id, target.id, null);

  assert.equal(await prisma.candidates.count({ where: { id: dup.id } }), 0, "M1: duplicate gone");
  const apps = await prisma.applications.findMany({ where: { candidate_id: target.id } });
  assert.deepEqual(apps.map((a) => a.id).sort(), [targetJ1, dupJ2].sort(), "M1: J1 folded into target's, J2 moved over");
  assert.equal(await prisma.applications.count({ where: { id: dupJ1 } }), 0, "M1: folded application dropped");
  assert.equal(await prisma.interviews.count({ where: { application_id: targetJ1, candidate_id: target.id } }), 1, "M1: interview re-pointed");
  const note = await prisma.notes.findFirstOrThrow({ where: { body: "dup note" } });
  assert.deepEqual([note.candidate_id, note.application_id], [target.id, targetJ1], "M1: note re-pointed");
  assert.equal((await prisma.activity.findFirstOrThrow({ where: { message: "CHK activity" } })).candidate_id, target.id, "M1: activity kept on the person");
  assert.equal((await prisma.candidates.findUniqueOrThrow({ where: { id: target.id } })).possible_duplicate_of, null, "M1: flag cleared");
  await assert.rejects(mergeCandidate(target.id, target.id, null), /itself/, "M1: can't merge into itself");

  await prisma.activity.deleteMany({ where: { message: "CHK activity" } });
  await prisma.candidates.deleteMany({ where: { id: target.id } });
  await prisma.jobs.deleteMany({ where: { id: { in: [j1.id, j2.id] } } });
  console.log("M1 ok");
}

// S1: createCandidate makes the person plus one open application with an entry transition
{
  const cid = await createCandidate({ resume: { storage: "local", driveFileId: "", fileName: "CHK Person.pdf", mimeType: "application/pdf", sizeKb: 1, uploadedAt: new Date().toISOString(), uploadedById: "", driveUrl: "" }, jobId: null, sourceId: null, intake: "upload", actorId: null });
  const apps = await prisma.applications.findMany({ where: { candidate_id: cid } });
  assert.equal(apps.length, 1, "S1: one application");
  assert.equal(apps[0]!.stage_id, active1, "S1: first active stage");
  assert.equal(await prisma.stage_transitions.count({ where: { application_id: apps[0]!.id } }), 1, "S1: entry row");
  await prisma.candidates.update({ where: { id: cid }, data: { first_name: "CHK" } });
  console.log("S1 ok");
}

await new Promise((r) => setTimeout(r, 300)); // let the background parse of S1's (missing) file settle
await prisma.candidates.deleteMany({ where: { first_name: "CHK" } });
console.log("check-applications-db: all assertions passed");
await prisma.$disconnect();
