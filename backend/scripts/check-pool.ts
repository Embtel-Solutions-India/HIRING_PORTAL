// Run: npm run check:pool — assert-based checks of the candidate pool filter (frontend/src/lib/pool.ts).
import assert from "node:assert/strict";
import type { Application, Candidate, Stage } from "../../frontend/src/types.ts";
import { matchesPool, type PoolFilter } from "../../frontend/src/lib/pool.ts";

const stages: Record<string, Stage> = {
  screening: { id: "screening", name: "Screening", color: "#000", kind: "active" },
  interview: { id: "interview", name: "Interview", color: "#000", kind: "active" },
  hired: { id: "hired", name: "Hired", color: "#000", kind: "hired" },
  rejected: { id: "rejected", name: "Not moving forward", color: "#000", kind: "closed" },
};
const person = (id: string, name: string): Candidate =>
  ({ id, firstName: name, lastName: "Test", email: `${name}@x.com`, phone: "", location: "", currentTitle: "", currentCompany: "", sourceId: "", tags: [], skills: ["React"], notes: [] }) as unknown as Candidate;
const app = (candidateId: string, jobId: string, stageId: string, outcome: Application["outcome"] = null): Application =>
  ({ id: `${candidateId}-${jobId}`, candidateId, jobId, stageId, outcome }) as Application;
const f = (o: Partial<PoolFilter> = {}): PoolFilter => ({ q: "", jobId: "", outcome: "", rejectedFromStageId: "", reasonId: "", includeClosed: true, ...o });
const rejectedA = { reasonId: "skills", reasonLabel: "Skills mismatch", fromStageId: "interview", actorId: "u", note: "", at: "" };

// Aman: rejected for A (from Interview, skills), active for B.
const aman = person("aman", "Aman");
const amanApps = [app("aman", "A", "rejected", rejectedA), app("aman", "B", "screening")];
assert.ok(matchesPool(aman, amanApps, stages, f({ outcome: "rejected" })), "any application rejected");
assert.ok(matchesPool(aman, amanApps, stages, f({ outcome: "active" })), "any application active");
assert.ok(!matchesPool(aman, amanApps, stages, f({ outcome: "hired" })), "none hired");
assert.ok(matchesPool(aman, amanApps, stages, f({ jobId: "B", outcome: "active" })), "job B is active");
assert.ok(!matchesPool(aman, amanApps, stages, f({ jobId: "B", outcome: "rejected" })), "job B isn't rejected");
assert.ok(matchesPool(aman, amanApps, stages, f({ rejectedFromStageId: "interview" })), "rejected from Interview");
assert.ok(!matchesPool(aman, amanApps, stages, f({ rejectedFromStageId: "screening" })), "not rejected from Screening");
assert.ok(matchesPool(aman, amanApps, stages, f({ reasonId: "skills" })), "reason matches");
assert.ok(!matchesPool(aman, amanApps, stages, f({ reasonId: "salary" })), "other reason doesn't");
assert.ok(!matchesPool(aman, amanApps, stages, f({ jobId: "B", reasonId: "skills" })), "reason filter scoped to job B");

// includeClosed=false hides people whose applications are all closed.
const priya = person("priya", "Priya");
const priyaApps = [app("priya", "A", "rejected", rejectedA)];
assert.ok(!matchesPool(priya, priyaApps, stages, f({ includeClosed: false })), "all-closed person hidden");
assert.ok(matchesPool(aman, amanApps, stages, f({ includeClosed: false })), "person with an open application stays");
assert.ok(matchesPool(priya, priyaApps, stages, f()), "shown by default");

// Text search is on the person.
assert.ok(matchesPool(aman, amanApps, stages, f({ q: "react" })), "skill search");
assert.ok(!matchesPool(aman, amanApps, stages, f({ q: "golang" })), "no match");

console.log("pool.check: all assertions passed");
