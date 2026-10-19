import type { Application, Candidate, Stage } from "../types";

export type Outcome = "active" | "hired" | "rejected";

export interface PoolFilter {
  q: string;
  jobId: string;
  outcome: "" | Outcome;
  rejectedFromStageId: string;
  reasonId: string;
  /** false hides past candidates: people with no application in progress (all rejected or hired). */
  includeClosed: boolean;
}

const outcomeOf = (app: Application, stages: Record<string, Stage>): Outcome => {
  const kind = stages[app.stageId]?.kind;
  return kind === "closed" ? "rejected" : kind === "hired" ? "hired" : "active";
};

/**
 * The candidate pool: a person matches when any one of their applications passes every application filter
 * (with a job picked, only that job's applications count). Text search is on the person.
 */
export function matchesPool(candidate: Candidate, apps: Application[], stages: Record<string, Stage>, f: PoolFilter): boolean {
  if (!f.includeClosed && !apps.some((a) => stages[a.stageId]?.kind === "active")) return false;
  const term = f.q.trim().toLowerCase();
  if (term && ![candidate.firstName, candidate.lastName, candidate.email, candidate.currentTitle, candidate.currentCompany, candidate.location, ...candidate.skills, ...candidate.tags].join(" ").toLowerCase().includes(term)) return false;
  const filtered = !!(f.jobId || f.outcome || f.rejectedFromStageId || f.reasonId);
  if (!filtered) return true;
  return apps.some(
    (a) =>
      (!f.jobId || a.jobId === f.jobId) &&
      (!f.outcome || outcomeOf(a, stages) === f.outcome) &&
      (!f.rejectedFromStageId || a.outcome?.fromStageId === f.rejectedFromStageId) &&
      (!f.reasonId || a.outcome?.reasonId === f.reasonId),
  );
}
