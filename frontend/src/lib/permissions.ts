import type { Role } from "../types";

/**
 * Single source of truth for what each role can do.
 * The backend imports this same file and enforces it on every request; the UI uses it to hide/disable controls.
 */
export const PERMISSIONS = {
  "candidates.view": ["interviewer", "user", "admin", "super_admin"],
  /** Without this, a person only sees candidates they're scheduled to interview. */
  "candidates.viewAll": ["user", "admin", "super_admin"],
  "candidates.moveStage": ["user", "admin", "super_admin"],
  "candidates.addNote": ["interviewer", "user", "admin", "super_admin"],
  /** Set which platform (LinkedIn, Indeed, referral…) a candidate came from. */
  "candidates.tagSource": ["user", "admin", "super_admin"],
  "candidates.create": ["admin", "super_admin"],
  "candidates.edit": ["admin", "super_admin"],
  "candidates.delete": ["super_admin"],
  "resumes.download": ["interviewer", "user", "admin", "super_admin"],
  "resumes.upload": ["admin", "super_admin"],
  "interviews.feedback": ["interviewer", "user", "admin", "super_admin"],
  "interviews.schedule": ["user", "admin", "super_admin"],
  "interviews.manageBookingLinks": ["admin", "super_admin"],
  "emails.sendSingle": ["user", "admin", "super_admin"],
  "emails.sendBulk": ["admin", "super_admin"],
  "emails.manageTemplates": ["admin", "super_admin"],
  "jobs.manage": ["admin", "super_admin"],
  /** Add, rename, recolor and hide recruiting sources. */
  "sources.manage": ["admin", "super_admin"],
  "users.view": ["admin", "super_admin"],
  "users.manage": ["admin", "super_admin"], // admins manage recruiter & interviewer accounts only
  "users.manageAdmins": ["super_admin"],
  "users.delete": ["super_admin"],
  "settings.pipeline": ["super_admin"],
  "settings.integrations": ["super_admin"],
  "settings.email": ["super_admin"],
  "audit.view": ["super_admin"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

/** Can `actor` change the account of someone with role `target` (or give someone that role)? */
export function canManageRole(actor: Role, target: Role): boolean {
  if (actor === "super_admin") return true;
  if (actor === "admin") return target === "user" || target === "interviewer";
  return false;
}

export const ROLES: Role[] = ["interviewer", "user", "admin", "super_admin"];

export const ROLE_LABEL: Record<Role, string> = {
  interviewer: "Interviewer",
  user: "Recruiter",
  admin: "Admin",
  super_admin: "Super Admin",
};

export const ROLE_DESCRIPTION: Record<Role, string> = {
  interviewer: "Sees the candidates they're interviewing — resume, AI summary and notes — and submits interview feedback.",
  user: "Reads every resume and summary, moves candidates through stages, schedules interviews, adds notes.",
  admin: "Everything a recruiter can do, plus uploading resumes, bulk email, jobs, templates and managing recruiter & interviewer accounts.",
  super_admin: "Full control: manages admins, pipeline stages, Google & email domain integrations, and the audit log.",
};

export const PERMISSION_GROUPS: { label: string; items: { key: Permission; label: string }[] }[] = [
  {
    label: "Candidates",
    items: [
      { key: "candidates.view", label: "View resumes & AI summaries of their candidates" },
      { key: "candidates.viewAll", label: "View every candidate" },
      { key: "candidates.moveStage", label: "Move candidates between stages" },
      { key: "candidates.addNote", label: "Add notes & ratings" },
      { key: "candidates.tagSource", label: "Tag the source (LinkedIn, referral…)" },
      { key: "resumes.download", label: "Download resumes" },
      { key: "resumes.upload", label: "Upload resumes / import from Drive" },
      { key: "candidates.edit", label: "Edit candidate profiles" },
      { key: "candidates.delete", label: "Delete candidates" },
    ],
  },
  {
    label: "Interviews & email",
    items: [
      { key: "interviews.feedback", label: "Submit interview feedback" },
      { key: "interviews.schedule", label: "Schedule interviews" },
      { key: "interviews.manageBookingLinks", label: "Manage booking links" },
      { key: "emails.sendSingle", label: "Email a single candidate" },
      { key: "emails.sendBulk", label: "Send bulk email" },
      { key: "emails.manageTemplates", label: "Edit email templates" },
    ],
  },
  {
    label: "Administration",
    items: [
      { key: "jobs.manage", label: "Create & edit jobs" },
      { key: "sources.manage", label: "Manage the list of sources" },
      { key: "users.manage", label: "Manage recruiter & interviewer accounts" },
      { key: "users.manageAdmins", label: "Manage admin accounts" },
      { key: "users.delete", label: "Delete team members" },
      { key: "settings.pipeline", label: "Configure pipeline stages" },
      { key: "settings.integrations", label: "Google Drive & Calendar integration" },
      { key: "settings.email", label: "Email domain & sender settings" },
      { key: "audit.view", label: "View audit log" },
    ],
  },
];
