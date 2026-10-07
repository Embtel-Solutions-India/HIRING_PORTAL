import { q } from "./db.ts";

export type ActivityType =
  | "stage_change"
  | "note"
  | "resume_upload"
  | "interview_scheduled"
  | "email_sent"
  | "user_invited"
  | "role_changed"
  | "settings_changed"
  | "candidate_created"
  | "source_changed";

export async function logActivity(actorId: string | null, type: ActivityType, message: string, candidateId?: string | null) {
  await q("insert into activity (actor_id, type, message, candidate_id) values ($1, $2, $3, $4)", [actorId, type, message, candidateId ?? null]);
}
