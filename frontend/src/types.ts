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

export interface ResumeFile {
  /** "drive" = stored in Google Drive; "local" = stored on the server disk (Drive not connected yet). */
  storage?: "drive" | "local";
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
  jobId: string;
  stageId: string;
  /** Recruiting source id (see Source), "" when nobody has tagged it yet. */
  sourceId: string;
  appliedAt: string;
  stageEnteredAt: string;
  ownerId: string;
  rating: number; // 0-5
  tags: string[];
  skills: string[];
  resume: ResumeFile;
  experience: Experience[];
  education: Education[];
  summary: AiSummary;
  notes: Note[];
  starred: boolean;
}

export type InterviewType = "phone" | "video" | "onsite";

export interface Interview {
  id: string;
  candidateId: string;
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
    | "settings_changed"
    | "candidate_created"
    | "source_changed";
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
    emailTransport: "ses" | "log";
    googleOAuthConfigured: boolean;
    timezone: string;
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
