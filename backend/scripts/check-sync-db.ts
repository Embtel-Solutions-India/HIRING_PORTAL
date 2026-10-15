// Run against a local database: DATABASE_URL=postgres://postgres:postgres@localhost:5433/hirely npm run check:sync-db
// Database-level checks of the sync queue, worker guards and change handling (no S3 or Drive calls).
import assert from "node:assert/strict";
import { prisma } from "../src/db.ts";
import { applyChanges, flagConflict } from "../src/drive-changes.ts";
import { HttpError } from "../src/http.ts";
import { markCandidatesDeleted, restoreResume } from "../src/resume-files.ts";
import { claimNext, enqueue, fail, resetRunning, retryRow } from "../src/sync-queue.ts";
import { resolveConflict, runJob } from "../src/sync-jobs.ts";

if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? "")) throw new Error("check-sync-db only runs against a local DATABASE_URL");

const PDF = "application/pdf";
const PREFIX = "CHK-";
await prisma.resume_files.deleteMany({ where: { drive_file_id: { startsWith: PREFIX } } });
await prisma.sync_jobs.deleteMany({ where: { status: { in: ["queued", "running"] } } });

const mk = (o: object = {}) => {
  const k = `${PREFIX}${Math.random()}`;
  return prisma.resume_files.create({
    data: { file_name: "cv.pdf", mime_type: PDF, drive_file_id: k, drive_md5: "aaa", drive_version: "1", drive_name: "cv.pdf", state: "synced", s3_key: `resumes/${k}/cv.pdf`, sha256: "s", s3_version_id: "v1", ...o },
  });
};
// Each scenario starts with an empty queue, so claimNext() picks that scenario's job.
const clearQueue = () => prisma.sync_jobs.deleteMany({ where: { status: { in: ["queued", "running"] } } });
const fresh = (id: string) => prisma.resume_files.findUniqueOrThrow({ where: { id } });
const jobsOf = (id: string) => prisma.sync_jobs.findMany({ where: { resume_file_id: id }, orderBy: { created_at: "asc" } });
const runOne = async (id: string, kind: string) => {
  const j = (await claimNext())!;
  assert.equal(j.resume_file_id, id);
  assert.equal(j.kind, kind);
  await runJob(j);
  return j;
};

// C1: a Drive change queued to_s3, then the portal replaced the resume (to_drive queued) → conflict, S3 not overwritten.
{
  await clearQueue();
  const r = await mk();
  await enqueue(r.id, "to_s3");
  await enqueue(r.id, "to_drive", { md5: "portal-md5" });
  await runOne(r.id, "to_s3");
  const after = await fresh(r.id);
  assert.equal(after.state, "conflict", "C1: to_s3 must not overwrite a pending portal change");
  assert.equal(after.s3_version_id, "v1", "C1: S3 version untouched");
  const jobs = await jobsOf(r.id);
  assert.equal(jobs.find((j) => j.kind === "to_drive")!.last_error, "cancelled: conflict", "C1: pending push cancelled");
  console.log("C1 ok");
}

// I1: a superseded to_drive hands its pre-generated Drive id to the queued twin.
{
  await clearQueue();
  const r = await mk({ drive_file_id: null, drive_md5: null, drive_name: null });
  await enqueue(r.id, "to_drive");
  const running = (await claimNext())!;
  running.payload = { ...running.payload, newFileId: "PREGEN-1" };
  await prisma.sync_jobs.update({ where: { id: running.id }, data: { payload: running.payload as object } });
  await enqueue(r.id, "to_drive", { md5: "x" });
  await fail(running, new Error("socket hang up"));
  const queued = (await jobsOf(r.id)).find((j) => j.status === "queued")!;
  assert.equal((queued.payload as { newFileId?: string }).newFileId, "PREGEN-1", "I1: fail() carries newFileId");

  await clearQueue();
  const r2 = await mk({ drive_file_id: null, drive_md5: null, drive_name: null });
  await enqueue(r2.id, "to_drive");
  const run2 = (await claimNext())!;
  await prisma.sync_jobs.update({ where: { id: run2.id }, data: { payload: { newFileId: "PREGEN-2" } } });
  await enqueue(r2.id, "to_drive", { md5: "y" });
  await resetRunning();
  const q2 = (await jobsOf(r2.id)).filter((j) => j.status === "queued");
  assert.equal(q2.length, 1);
  assert.equal((q2[0]!.payload as { newFileId?: string }).newFileId, "PREGEN-2", "I1: resetRunning carries newFileId");
  await prisma.sync_jobs.deleteMany({ where: { resume_file_id: { in: [r.id, r2.id] } } });
  console.log("I1 ok");
}

// I2: a Drive rename (rename_s3) while a portal rename is pending (rename_drive) → name conflict, no swap.
{
  await clearQueue();
  const r = await mk();
  await enqueue(r.id, "rename_s3", { name: "drive-name.pdf" });
  await enqueue(r.id, "rename_drive", { name: "portal-name.pdf" });
  await runOne(r.id, "rename_s3");
  const after = await fresh(r.id);
  assert.equal(after.state, "conflict", "I2: crossing renames conflict");
  assert.equal(after.file_name, "cv.pdf", "I2: name untouched");
  console.log("I2 ok");
}

// I3: content + name conflict on one change → recorded as both; resolving re-queues content AND name.
{
  await clearQueue();
  const r = await mk();
  await enqueue(r.id, "to_drive", { md5: "portal" });
  await enqueue(r.id, "rename_drive", { name: "portal.pdf" });
  await applyChanges([{ fileId: r.drive_file_id!, removed: false, file: { id: r.drive_file_id!, name: "drive.pdf", mimeType: PDF, md5Checksum: "drive", version: "2", trashed: false } }]);
  const c = await fresh(r.id);
  assert.equal((c.conflict as { on: string }).on, "both", "I3: both conflicts recorded");
  await prisma.sync_jobs.deleteMany({ where: { resume_file_id: r.id, kind: "stash_conflict" } });
  await resolveConflict(c, "drive");
  const kinds = (await jobsOf(r.id)).filter((j) => j.status === "queued").map((j) => j.kind).sort();
  assert.deepEqual(kinds, ["rename_s3", "to_s3"], "I3: keep-drive re-queues content and name");
  console.log("I3 ok");
}

// I5: Retry on a failed row with no failed job still queues work.
{
  await clearQueue();
  const r = await mk({ state: "failed", last_error: "Lost access" });
  await retryRow(r.id);
  const jobs = await jobsOf(r.id);
  assert.equal((await fresh(r.id)).state, "pending");
  assert.ok(jobs.some((j) => j.status === "queued"), "I5: something is queued");
  console.log("I5 ok");
}

// I6: one change that throws doesn't stop the others; the bad row is marked failed.
{
  await clearQueue();
  const bad = await mk();
  const good = await mk();
  const n = await applyChanges([
    { fileId: bad.drive_file_id!, removed: true },
    { fileId: good.drive_file_id!, removed: false, file: { id: good.drive_file_id!, name: "cv.pdf", mimeType: PDF, md5Checksum: "new", version: "2", trashed: false } },
  ]);
  assert.equal(n, 2);
  assert.equal((await fresh(bad.id)).state, "failed", "I6: failing change recorded on its row");
  assert.ok((await jobsOf(good.id)).some((j) => j.kind === "to_s3"), "I6: later change still applied");
  console.log("I6 ok");
}

// R1: two failed jobs of one kind → Retry queues one (no unique-index crash).
{
  await clearQueue();
  const r = await mk();
  for (const md5 of ["a", "b"]) {
    await enqueue(r.id, "to_drive", { md5 });
    const j = (await claimNext())!;
    await fail(j, Object.assign(new Error("gone"), { status: 404 }));
  }
  await retryRow(r.id);
  const jobs = await jobsOf(r.id);
  assert.equal(jobs.filter((j) => j.status === "queued").length, 1, "R1: exactly one queued");
  assert.equal(jobs.filter((j) => j.status === "failed").length, 0, "R1: the other is retired");
  console.log("R1 ok");
}

// R2: a name-only conflict leaves the portal's content push alone; keep-Drive only re-pushes the name.
{
  await clearQueue();
  const r = await mk();
  await enqueue(r.id, "to_drive", { md5: "portal" });
  await flagConflict(r, { md5: "aaa", version: "2", name: "drive.pdf" }, "name");
  const queued = (await jobsOf(r.id)).filter((j) => j.status === "queued").map((j) => j.kind);
  assert.deepEqual(queued, ["to_drive"], "R2: content push not cancelled by a name conflict");
  await prisma.sync_jobs.deleteMany({ where: { resume_file_id: r.id } });
  await resolveConflict(await fresh(r.id), "drive");
  assert.deepEqual((await jobsOf(r.id)).map((j) => j.kind), ["rename_s3"], "R2: keep-Drive on a name conflict doesn't touch content");
  console.log("R2 ok");
}

// R4: purge clears the S3 pointers and the candidate's resume.
{
  await clearQueue();
  const stage = (await prisma.stages.findFirst())!;
  const cand = await prisma.candidates.create({ data: { first_name: "R4", stage_id: stage.id, resume: { storage: "s3", fileName: "cv.pdf" } } });
  const r = await mk({ s3_key: null, candidate_id: cand.id, state: "pending_deletion", deleted_side: "drive", delete_after: new Date(Date.now() - 1000) });
  await enqueue(r.id, "purge");
  await runOne(r.id, "purge");
  const after = await fresh(r.id);
  assert.equal(after.state, "deleted");
  assert.equal(after.sha256, null, "R4: sha cleared so a re-import re-uploads");
  assert.equal((await prisma.candidates.findUniqueOrThrow({ where: { id: cand.id } })).resume, null, "R4: candidate no longer points at it");
  await prisma.resume_files.delete({ where: { id: r.id } });
  await prisma.candidates.delete({ where: { id: cand.id } });
  console.log("R4 ok");
}

// R6: deleting a candidate keeps a conflict; restoring brings the conflict back, not "synced".
{
  await clearQueue();
  const stage = (await prisma.stages.findFirst())!;
  const cand = await prisma.candidates.create({ data: { first_name: "R6", stage_id: stage.id } });
  const r = await mk({ candidate_id: cand.id, state: "conflict", conflict: { on: "content" } });
  assert.equal(await markCandidatesDeleted([cand.id]), 1);
  const pend = await fresh(r.id);
  assert.equal(pend.state, "pending_deletion");
  assert.equal((pend.conflict as { on: string }).on, "content", "R6: conflict kept");
  await restoreResume(pend);
  assert.equal((await fresh(r.id)).state, "conflict", "R6: restore returns to conflict");
  console.log("R6 ok");
}

// R7: "Drive isn't connected" waits for reconnection instead of burning retries.
{
  await clearQueue();
  const r = await mk();
  await enqueue(r.id, "to_drive");
  const j = (await claimNext())!;
  await fail(j, new HttpError(409, "Google Workspace isn't connected. A Super Admin can connect it in Settings."));
  const after = (await jobsOf(r.id))[0]!;
  assert.equal(after.status, "queued");
  assert.equal(after.attempts, 0, "R7: no attempt used");
  assert.ok(after.run_after > new Date(Date.now() + 10 * 60_000), "R7: waits a while");
  console.log("R7 ok");
}

await prisma.resume_files.deleteMany({ where: { drive_file_id: { startsWith: PREFIX } } });
await prisma.resume_files.deleteMany({ where: { drive_file_id: null, file_name: "cv.pdf", s3_key: { startsWith: `resumes/${PREFIX}` } } });
console.log("check-sync-db: all assertions passed");
await prisma.$disconnect();
