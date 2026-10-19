// Run against a local database: DATABASE_URL=postgres://postgres:postgres@localhost:5433/hirely npm run check:applications-db
// Database-level checks of applications, stage history, rejection reasons, reapply and merge.
import assert from "node:assert/strict";
import { createApplication, moveApplications } from "../src/applications.ts";
import { prisma } from "../src/db.ts";
import { createCandidate } from "../src/pipeline.ts";

if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? "")) throw new Error("check-applications-db only runs against a local DATABASE_URL");

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
