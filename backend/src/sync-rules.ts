/** Pure decision logic for resume sync: no I/O, so scripts/check-sync.ts can test it directly. */
import crypto from "node:crypto";

export type SyncState = "pending" | "synced" | "conflict" | "failed" | "pending_deletion" | "deleted";
export type JobKind = "to_s3" | "to_drive" | "rename_s3" | "rename_drive" | "stash_conflict" | "purge" | "move_drive";

export const GOOGLE_DOC = "application/vnd.google-apps.document";
export const MAX_ATTEMPTS = 8;

export function digest(data: Buffer) {
  return { sha256: crypto.createHash("sha256").update(data).digest("hex"), md5: crypto.createHash("md5").update(data).digest("hex") };
}

/** Only what an S3 key can't safely hold is replaced; the exact name stays in resume_files.file_name. */
export function safeKeyName(name: string): string {
  const s = name.replace(/[\/\\\x00-\x1f\x7f]/g, "_").trim() || "resume";
  if (Buffer.byteLength(s) <= 200) return s;
  const dot = s.lastIndexOf(".");
  const ext = dot > 0 && s.length - dot <= 10 ? s.slice(dot) : "";
  const chars = Array.from(s.slice(0, s.length - ext.length));
  while (Buffer.byteLength(chars.join("") + ext) > 200) chars.pop();
  return chars.join("") + ext;
}

/** Google Docs are stored in S3 as a PDF export. */
export const s3MimeFor = (mimeType: string) => (mimeType === GOOGLE_DOC ? "application/pdf" : mimeType);
export const s3NameFor = (fileName: string, mimeType: string) => (mimeType === GOOGLE_DOC && !/\.pdf$/i.test(fileName) ? `${fileName}.pdf` : fileName);
export const s3KeyFor = (sourceId: string, fileName: string, mimeType: string) => `resumes/${sourceId}/${safeKeyName(s3NameFor(fileName, mimeType))}`;
/** `resumes/{sourceId}`: fixed for the life of a resume; renames and replaces keep it. */
export const keyPrefix = (key: string) => key.split("/").slice(0, 2).join("/");

/**
 * The Drive name a transfer saw. It never silently becomes the baseline: if it differs from the last-synced name,
 * the baseline stays and a rename follows, so the change still reaches the portal (or raises a conflict).
 */
export function nameBaseline(prev: string | null, portalName: string, observed: string): { baseline: string; rename: string | null } {
  const baseline = prev ?? portalName;
  return { baseline, rename: observed && observed !== baseline ? observed : null };
}

const EXT: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/msword": ".doc",
};

export function resolveFileName(name: string | null | undefined, driveFileId: string, mimeType: string) {
  const trimmed = (name ?? "").trim();
  if (trimmed) return { fileName: trimmed, reviewReason: null };
  return { fileName: `resume_${driveFileId}${EXT[mimeType] ?? ""}`, reviewReason: "missing_filename" };
}

export interface Baseline {
  driveMd5: string | null;
  driveVersion: string | null;
  driveName: string | null;
}

export interface DriveObservation {
  removed: boolean;
  trashed: boolean;
  md5: string | null;
  version: string | null;
  name: string;
  mimeType: string;
}

/** What the portal has queued for Drive and not yet confirmed. */
export interface PortalPending {
  contentQueued: boolean;
  /** MD5 of the bytes the queued to_drive job pushes (null until the job has read them). */
  contentMd5: string | null;
  renameTo: string | null;
}

export type Decision =
  | { do: "copy_to_s3" }
  | { do: "rename_s3"; name: string }
  | { do: "conflict"; on: "content" | "name" }
  | { do: "start_deletion" }
  | { do: "cancel_deletion" }
  | { do: "check_removed" };

/** What to do about one Drive change, judged against the last-synced baseline (never timestamps). */
export function decide(row: { state: SyncState; deletedSide: string | null }, base: Baseline, obs: DriveObservation, pending: PortalPending): Decision[] {
  if (row.state === "deleted") return [];
  if (obs.removed) return row.state === "pending_deletion" ? [] : [{ do: "check_removed" }];
  if (obs.trashed) return row.state === "pending_deletion" ? [] : [{ do: "start_deletion" }];
  const out: Decision[] = [];
  if (row.state === "pending_deletion") {
    if (row.deletedSide !== "drive") return [];
    out.push({ do: "cancel_deletion" });
  }
  if (row.state === "conflict") return out;

  const isDoc = obs.mimeType === GOOGLE_DOC;
  const contentChanged = isDoc ? obs.version !== base.driveVersion : obs.md5 !== base.driveMd5;
  if (contentChanged) {
    if (!pending.contentQueued) out.push({ do: "copy_to_s3" });
    // A portal replace of a Google Doc adds a new file and archives the Doc, so both survive: not a conflict.
    else if (!isDoc && obs.md5 !== pending.contentMd5) out.push({ do: "conflict", on: "content" });
  }
  if (obs.name && obs.name !== base.driveName) {
    if (pending.renameTo === null) out.push({ do: "rename_s3", name: obs.name });
    else if (obs.name !== pending.renameTo) out.push({ do: "conflict", on: "name" });
  }
  return out;
}

/** 30s · 2^attempts, capped at 1h, ±20% jitter. `attempts` counts failures so far. */
export function backoffMs(attempts: number, rand: () => number = Math.random): number {
  const base = Math.min(3_600_000, 30_000 * 2 ** attempts);
  return Math.round(base * (0.8 + 0.4 * rand()));
}

export class ChecksumMismatch extends Error {
  constructor(what: string) {
    super(`Checksum mismatch: ${what}`);
    this.name = "ChecksumMismatch";
  }
}

/** Errors a retry can't fix. */
export function isPermanent(err: unknown, previousError: string | null): boolean {
  const e = err as { status?: number; name?: string; message?: string } | null;
  const msg = e?.message ?? "";
  if (/rate ?limit|quota/i.test(msg)) return false;
  if (e?.status === 401 || e?.status === 403 || e?.status === 404) return true;
  if (/Google API error \((401|403|404)\)/.test(msg)) return true;
  if (e?.name === "NoSuchKey" || e?.name === "NoSuchBucket" || e?.name === "AccessDenied") return true;
  if (e?.name === "ChecksumMismatch") return !!previousError?.startsWith("Checksum mismatch");
  return false;
}
