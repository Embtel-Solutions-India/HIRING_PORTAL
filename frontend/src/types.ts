// Domain model shared by every screen. The backend API should return these shapes.

export type Role = "interviewer" | "user" | "admin" | "super_admin";

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: Role;
  title: string;
  status: "active" | "invited" | "deactivated";
  avatarColor: string;
  lastActiveAt?: string;
  calendarConnected: boolean;
  /** The SUPER_ADMIN_EMAIL account: can't be demoted, deactivated or deleted. */
  protected?: boolean;
}

export interface Stage {
  id: string;
  name: string;
  color: string; // hex
  kind: "active" | "hired" | "closed";
  /** Email template sent automatically when a candidate enters this stage (optional). */
  autoEmailTemplateId?: string;
}

export interface Job {
  id: string;
  title: string;
  department: string;
  location: string;
  type: "Full-time" | "Part-time" | "Contract" | "Internship";
  status: "open" | "paused" | "closed";
  hiringManagerId: string;
  openings: number;
  createdAt: string;
  driveFolder: string;
  /** Used by the AI to score how well each resume matches. */
  description?: string;
}

export type SyncStateName = "pending" | "synced" | "conflict" | "failed" | "pending_deletion" | "deleted";

export interface ResumeFile {
  /** "s3" = primary copy in S3 (Drive kept in sync); "drive" = Google Drive only; "local" = server disk (pre-S3). */
  storage?: "drive" | "local" | "s3";
  /** resume_files.id once the resume is tracked for S3 sync. */
  resumeFileId?: string;
  /** Current S3 version: changes on every replace, used to bust the preview cache. */
  version?: string;
  /** Sync state, filled in by the API (not stored). */
  syncState?: SyncStateName;
  driveFileId: string;
  fileName: string;
  mimeType: string;
  sizeKb: number;
  uploadedAt: string;
  uploadedById: string;
  driveUrl: string;
}

export interface Experience {
  company: string;
  title: string;
  start: string;
  end: string | "Present";
  highlights: string[];
}

export interface Education {
  school: string;
  degree: string;
  year: string;
}

export interface AiSummary {
  headline: string;
  overview: string;
  strengths: string[];
  concerns: string[];
  matchScore: number; // 0-100 against the job
  yearsExperience: number;
  generatedAt: string;
  /** "pending" while the backend is still parsing the resume + generating the summary; "failed" if that didn't work. */
  status?: "pending" | "failed";
}

export interface Note {
  id: string;
  authorId: string;
  body: string;
  createdAt: string;
  /** The application (job) it was written under, "" for none. */
  applicationId: string;
}

export interface Candidate {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  location: string;
  currentTitle: string;
  currentCompany: string;
  /** Recruiting source id (see Source), "" when nobody has tagged it yet. */
  sourceId: string;
  tags: string[];
  skills: string[];
  resume: ResumeFile;
  /** "pending" while the resume is being parsed. */
  parseStatus: "pending" | "ready" | "failed";
  experience: Experience[];
  education: Education[];
  notes: Note[];
  /** Older candidate this one looks like (same email/phone), "" when none. */
  possibleDuplicateOf: string;
  createdAt: string;
}

/** Why and by whom an application was closed: its latest move into a closed stage. */
export interface Outcome {
  reasonId: string;
  reasonLabel: string;
  fromStageId: string;
  actorId: string;
  note: string;
  at: string;
}

/** One person's attempt at one job: its own stage, history, owner and AI match. */
export interface Application {
  id: string;
  candidateId: string;
  jobId: string;
  stageId: string;
  appliedAt: string;
  stageEnteredAt: string;
  /** Last meaningful update; boards sort by it, newest first. */
  lastActivityAt: string;
  ownerId: string;
  rating: number; // 0-5
  starred: boolean;
  summary: AiSummary;
  outcome: Outcome | null;
  createdAt: string;
}

export interface StageTransition {
  id: string;
  applicationId: string;
  /** "" when the application was created (entered the pipeline). */
  fromStageId: string;
  toStageId: string;
  actorId: string;
  reasonLabel: string;
  note: string;
  createdAt: string;
}

export interface CandidateHistory {
  transitions: StageTransition[];
  activity: ActivityEvent[];
}

export interface RejectionReason {
  id: string;
  label: string;
  position: number;
  active: boolean;
}

export type InterviewType = "phone" | "video" | "onsite";

export interface Interview {
  id: string;
  candidateId: string;
  applicationId: string;
  jobId: string;
  title: string;
  type: InterviewType;
  start: string;
  durationMin: number;
  interviewerIds: string[];
  meetLink?: string;
  location?: string;
  status: "scheduled" | "completed" | "cancelled" | "no_show";
  calendarEventId?: string;
  feedback?: { authorId: string; recommendation: "strong_yes" | "yes" | "no" | "strong_no"; comment: string }[];
  bookedVia?: string; // booking link id
}

export interface BookingLink {
  id: string;
  slug: string;
  title: string;
  durationMin: number;
  type: InterviewType;
  hostIds: string[];
  /** Weekly availability window, 24h clock. */
  days: number[]; // 0 = Sunday
  startHour: number;
  endHour: number;
  bufferMin: number;
  active: boolean;
  bookings: number;
}

export interface EmailTemplate {
  id: string;
  name: string;
  subject: string;
  body: string;
  category: "stage_update" | "interview" | "rejection" | "offer" | "general";
  updatedAt: string;
}

export interface EmailCampaign {
  id: string;
  subject: string;
  templateId?: string;
  fromAddress: string;
  recipientIds: string[];
  sentById: string;
  sentAt: string;
  status: "sent" | "scheduled" | "sending" | "failed";
  stats: { delivered: number; opened: number; clicked: number; bounced: number };
}

export interface ActivityEvent {
  id: string;
  actorId: string;
  type:
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
  candidateId?: string;
  message: string;
  createdAt: string;
}

export interface OrgSettings {
  orgName: string;
  emailDomain: string;
  senderName: string;
  senderAddress: string;
  replyTo: string;
  emailSignature: string;
  dnsRecords: { type: "SPF" | "DKIM" | "DMARC"; host: string; value: string; verified: boolean }[];
  google: {
    connected: boolean;
    account: string;
    driveRootFolder: string;
    driveSyncEnabled: boolean;
    lastSyncAt?: string;
    calendarId: string;
    autoMeetLinks: boolean;
  };
  aiSummariesEnabled: boolean;
  /** What the server is configured with (read-only, from environment variables). */
  system?: {
    appUrl: string;
    aiConfigured: boolean;
    emailTransport: "smtp" | "log";
    smtpHost: string;
    googleOAuthConfigured: boolean;
    googleOwnerEmail?: string;
    timezone: string;
    s3Configured?: boolean;
    resumeGraceDays?: number;
  };
}

/** Where a candidate came from (LinkedIn, Indeed, referral…). The list is editable in Settings → Sources. */
export interface Source {
  id: string;
  name: string;
  color: string;
  active: boolean;
}

export interface DriveInboxFile {
  driveFileId: string;
  fileName: string;
  folder: string;
  /** Detected from a source-named sub-folder, e.g. "Case Manager/LinkedIn/". */
  sourceId?: string;
  sizeKb: number;
  modifiedAt: string;
}
