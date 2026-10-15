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
  | "source_changed";

export async function logActivity(actorId: string | null, type: ActivityType, message: string, candidateId?: string | null) {
  await prisma.activity.create({ data: { actor_id: actorId, type, message, candidate_id: candidateId ?? null } });
}
