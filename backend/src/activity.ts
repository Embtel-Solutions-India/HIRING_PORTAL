import type { Db } from "./sync-queue.ts";
import { prisma } from "./db.ts";

export type ActivityType =
  | "stage_change"
  | "note"
  | "resume_upload"
  | "interview_scheduled"
  | "email_sent"
  | "user_invited"
  | "role_changed"
  | "user_deleted"
  | "settings_changed"
  | "candidate_created"
  | "source_changed"
  | "candidate_updated"
  | "interview_feedback";

export async function logActivity(actorId: string | null, type: ActivityType, message: string, candidateId?: string | null) {
  await prisma.activity.create({ data: { actor_id: actorId, type, message, candidate_id: candidateId ?? null } });
}

/** Marks applications as just worked on, so their cards sort to the top of the board. */
export async function touch(applicationIds: string[], db: Db = prisma) {
  if (applicationIds.length) await db.applications.updateMany({ where: { id: { in: applicationIds } }, data: { last_activity_at: new Date() } });
}

/** Touches every open (active-stage) application of a person. */
export async function touchCandidate(candidateId: string, db: Db = prisma) {
  await db.applications.updateMany({ where: { candidate_id: candidateId, stages: { kind: "active" } }, data: { last_activity_at: new Date() } });
}
