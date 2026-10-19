/** Database rows → the shapes in frontend/src/types.ts. */
import type {
  Application,
  BookingLink,
  Candidate,
  EmailCampaign,
  EmailTemplate,
  Interview,
  Job,
  OrgSettings,
  Source,
  Stage,
  TeamMember,
} from "../../frontend/src/types.ts";
import { aiConfigured } from "./ai.ts";
import { config } from "./config.ts";
import type { UserRow } from "./http.ts";
import { s3Configured } from "./s3.ts";
import { getSetting } from "./settings.ts";

type Row = Record<string, any>;

export const user = (u: UserRow, orgDomain = ""): TeamMember => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  title: u.title,
  status: u.status,
  avatarColor: u.avatar_color,
  lastActiveAt: u.last_active_at?.toISOString(),
  calendarConnected: !!orgDomain && u.email.endsWith(`@${orgDomain}`),
  protected: u.email === config.superAdminEmail || undefined,
});

export const stage = (s: Row): Stage => ({
  id: s.id,
  name: s.name,
  color: s.color,
  kind: s.kind,
  autoEmailTemplateId: s.auto_email_template_id ?? undefined,
});

export const job = (j: Row): Job & { description: string } => ({
  id: j.id,
  title: j.title,
  department: j.department,
  location: j.location,
  type: j.type,
  status: j.status,
  hiringManagerId: j.hiring_manager_id ?? "",
  openings: j.openings,
  createdAt: j.created_at,
  driveFolder: j.drive_folder,
  description: j.description,
});

/** The AI summary to show for an application; while the person's resume is parsing it's a placeholder. */
function summaryFor(a: Row, parseStatus: string): Application["summary"] {
  if (parseStatus === "pending") return { headline: "Generating summary…", overview: "", strengths: [], concerns: [], matchScore: 0, yearsExperience: 0, generatedAt: a.created_at, status: "pending" };
  if (a.summary) return a.summary;
  return {
    headline: parseStatus === "failed" ? "Couldn't read this resume" : "No AI summary",
    overview:
      parseStatus === "failed"
        ? "The file couldn't be parsed. Open the resume to review it manually."
        : aiConfigured()
          ? "AI summaries are turned off in Settings."
          : "Add an Anthropic API key (ANTHROPIC_API_KEY) on the server to generate summaries automatically.",
    strengths: [],
    concerns: [],
    matchScore: 0,
    yearsExperience: 0,
    generatedAt: a.created_at,
    status: "failed",
  };
}

/** `outcome` is the application's latest move into a closed stage (null when it was never closed). */
export const application = (a: Row, parseStatus: string, outcome: Row | null): Application => ({
  id: a.id,
  candidateId: a.candidate_id,
  jobId: a.job_id ?? "",
  stageId: a.stage_id,
  appliedAt: a.applied_at,
  stageEnteredAt: a.stage_entered_at,
  lastActivityAt: a.last_activity_at,
  ownerId: a.owner_id ?? "",
  rating: a.rating,
  starred: a.starred,
  summary: summaryFor(a, parseStatus),
  outcome: outcome
    ? { reasonId: outcome.reason_id ?? "", reasonLabel: outcome.reason_label ?? "", fromStageId: outcome.from_stage_id ?? "", actorId: outcome.actor_id ?? "", note: outcome.note ?? "", at: outcome.created_at }
    : null,
  createdAt: a.created_at,
});

export function candidate(c: Row, notes: Row[]): Candidate {
  return {
    id: c.id,
    firstName: c.first_name,
    lastName: c.last_name,
    email: c.email,
    phone: c.phone,
    location: c.location,
    currentTitle: c.current_title || (c.parse_status === "pending" ? "Parsing resume…" : ""),
    currentCompany: c.current_company,
    sourceId: c.source_id ?? "",
    tags: c.tags,
    skills: c.skills,
    resume: c.resume ? { ...c.resume, syncState: c.resume_files?.state } : { storage: "local", driveFileId: "", fileName: "No resume", mimeType: "", sizeKb: 0, uploadedAt: c.created_at, uploadedById: "", driveUrl: "" },
    parseStatus: c.parse_status,
    experience: c.experience,
    education: c.education,
    notes: notes.map((n) => ({ id: n.id, authorId: n.author_id ?? "", body: n.body, createdAt: n.created_at, applicationId: n.application_id ?? "" })),
    possibleDuplicateOf: c.possible_duplicate_of ?? "",
    createdAt: c.created_at,
  };
}

export const interview = (i: Row, feedback: Row[]): Interview => ({
  id: i.id,
  candidateId: i.candidate_id,
  applicationId: i.application_id,
  jobId: i.job_id ?? "",
  title: i.title,
  type: i.type,
  start: i.start_at,
  durationMin: i.duration_min,
  interviewerIds: i.interviewer_ids,
  meetLink: i.meet_link ?? undefined,
  location: i.location ?? undefined,
  status: i.status,
  calendarEventId: i.calendar_event_id ?? undefined,
  bookedVia: i.booked_via ?? undefined,
  feedback: feedback.length ? feedback.map((f) => ({ authorId: f.author_id ?? "", recommendation: f.recommendation, comment: f.comment })) : undefined,
});

export const bookingLink = (b: Row): BookingLink => ({
  id: b.id,
  slug: b.slug,
  title: b.title,
  durationMin: b.duration_min,
  type: b.type,
  hostIds: b.host_ids,
  days: b.days,
  startHour: b.start_hour,
  endHour: b.end_hour,
  bufferMin: b.buffer_min,
  active: b.active,
  bookings: b.bookings,
});

export const source = (s: Row): Source => ({ id: s.id, name: s.name, color: s.color, active: s.active });

export const template = (t: Row): EmailTemplate => ({ id: t.id, name: t.name, subject: t.subject, body: t.body, category: t.category, updatedAt: t.updated_at });

export const campaign = (c: Row): EmailCampaign => ({
  id: c.id,
  subject: c.subject,
  templateId: c.template_id ?? undefined,
  fromAddress: c.from_address,
  recipientIds: (c.recipient_ids ?? []).filter(Boolean),
  sentById: c.sent_by_id ?? "",
  sentAt: c.send_at,
  status: c.status,
  stats: { delivered: c.delivered ?? 0, opened: c.opened ?? 0, clicked: c.clicked ?? 0, bounced: c.failed ?? 0 },
});

export async function orgSettings(): Promise<OrgSettings> {
  const [org, g, dns] = await Promise.all([getSetting("org"), getSetting("google"), getSetting("dns")]);
  return {
    orgName: org.orgName,
    emailDomain: org.emailDomain,
    senderName: org.senderName,
    senderAddress: org.senderAddress,
    replyTo: org.replyTo,
    emailSignature: org.emailSignature,
    aiSummariesEnabled: org.aiSummariesEnabled,
    dnsRecords: dns,
    google: {
      connected: g.connected,
      account: g.account,
      driveRootFolder: g.driveRootFolder,
      driveSyncEnabled: g.driveSyncEnabled,
      lastSyncAt: g.lastSyncAt,
      calendarId: g.calendarId,
      autoMeetLinks: g.autoMeetLinks,
    },
    system: {
      appUrl: config.appUrl,
      aiConfigured: aiConfigured(),
      emailTransport: config.email.transport,
      smtpHost: config.email.smtp.host,
      googleOAuthConfigured: !!(config.google.clientId && config.google.clientSecret),
      googleOwnerEmail: config.google.ownerEmail,
      timezone: config.orgTimezone,
      s3Configured: s3Configured(),
      resumeGraceDays: config.resumeDeleteGraceDays,
    },
  };
}
