# S3 Primary Resume Storage with Google Drive Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every resume into a versioned S3 bucket, serve the portal from S3, and keep Google Drive in two-way sync through a durable, retrying background queue with conflict, deletion and integrity safeguards, plus an admin dashboard.

**Architecture:** A `resume_files` table holds one row per resume with its S3 location, its last-synced Drive baseline and a sync state. Every transfer is a row in `sync_jobs`, processed one at a time by an in-process worker that also polls the Drive Changes API, so job execution and change detection never interleave. All decisions about a Drive change live in one pure function (`decide`) that is covered by an assert-based check script.

**Tech Stack:** Node 24 (runs `.ts` directly; erasable TypeScript only, no enums or parameter properties), Fastify 5, Prisma 7 + PostgreSQL, `@aws-sdk/client-s3` (new), Google Drive REST v3 via the existing `gfetch`, React + Zustand frontend.

**Spec:** `docs/superpowers/specs/2026-10-15-s3-drive-resume-sync-design.md`

## Global Constraints

- Only the portal writes to S3. S3 is never polled or watched.
- Drive change detection: Drive **Changes API** on the existing `DRIVE_SYNC_MINUTES` timer. No webhooks.
- Conflicts are detected against the **last-synced baseline**, never by comparing timestamps. Both changed → keep both, flag `conflict`, an Admin picks.
- Only an explicit change-feed signal (trashed, or removed and confirmed 404) or a portal candidate delete starts a deletion countdown of `RESUME_DELETE_GRACE_DAYS` (default **30**). A file missing from a folder scan never does.
- SHA-256 is computed by us and persisted for every S3 object. Drive `md5Checksum` is compared only against an MD5 we compute over the same bytes. Never treat an S3 ETag as a checksum.
- S3 keys: `resumes/{sourceId}/{keyName}`. `sourceId` = Drive file id for Drive-origin resumes, the `resume_files.id` for portal-origin ones. It never changes. The exact original filename lives in `file_name`.
- `keyName` replaces only `/`, `\` and control characters with `_` and is trimmed to 200 bytes (extension kept). Empty Drive name → `resume_{driveFileId}` + extension, `review_reason = 'missing_filename'`.
- The bucket must have Versioning on. `put` refuses to continue if S3 returns no `VersionId`.
- Retries: `min(1h, 30s · 2^attempts)` ±20 % jitter, max **8** attempts. 404/401/403 (other than rate limits) fail at once; a checksum mismatch fails at once only the second time in a row.
- Drive originals are never modified or deleted by the migration.
- Without S3 configured (`S3_BUCKET` etc. empty) the app must behave exactly as today.
- New permission `storage.manage` = Admin + Super Admin. Replace/Rename resume uses the existing `candidates.edit`.
- **Develop against the local database** (`npm run dev:db`, then `DATABASE_URL=postgres://postgres:postgres@localhost:5433/hirely` in `backend/.env`). `backend/.env` currently points at the live Supabase database, and the backend runs `prisma migrate deploy` on every start.
- Backend imports use explicit `.ts` extensions, matching the existing code.

## Review Focus

1. **Our own upload echoing back.** A Drive change arrives for a file the worker has just uploaded but whose baseline isn't committed yet (crash between upload and commit). The expected behaviour is an echo, ignored, with no conflict. Test: `decide` with `contentMd5 === obs.md5` (Task 1).
2. **A Drive rate-limit 403** (`userRateLimitExceeded`) should be retried, not permanently failed. Test: `isPermanent` (Task 1).
3. **A crash after a Drive upload but before the database commit**, followed by a retry. The expected behaviour is no second Drive file. Pinned by pre-generated Drive ids stored in the job payload (Task 6), and checked in the manual runbook (Task 10).
4. **A rename arriving for a migrated row whose S3 copy doesn't exist yet.** The expected behaviour is to update the name only, with no crash. Handled by `renameInS3` (Task 4) and checked in the runbook (Task 10).
5. **Preview after Replace.** The browser must show the new file, not a cached copy of the old one for 5 minutes. Pinned by the `?v=` cache-buster (Task 9), and checked in the runbook (Task 10).

---

## File map

| File | Responsibility |
|---|---|
| `backend/src/sync-rules.ts` (new) | Pure logic: hashing, key building, `decide`, backoff, error classification. |
| `backend/scripts/check-sync.ts` (new) | Assert-based checks of `sync-rules.ts`. |
| `backend/src/s3.ts` (new) | S3 wrapper: put/get/head/copy/remove, `s3Configured()`. |
| `backend/prisma/migrations/004_resume_sync/migration.sql` (new) | Tables, constraints, indexes. |
| `backend/src/sync-queue.ts` (new) | `enqueue`, `claimNext`, `complete`, `fail`, `retryRow`, `resetRunning`. |
| `backend/src/resume-files.ts` (new) | Row ↔ `candidates.resume` JSON, Drive-import tracking, migration enqueue, `renameInS3`, deletion helpers. |
| `backend/src/sync-jobs.ts` (new) | Job handlers, `syncTick` worker loop, purge scheduling. |
| `backend/src/drive-changes.ts` (new) | Changes API checkpoint and `applyChange`. |
| `backend/src/routes/sync.ts` (new) | Dashboard API. |
| `backend/src/google.ts` | New Drive calls (`generateFileId`, `updateFileContent`, `renameFile`, `setTrashed`, changes). |
| `backend/src/storage.ts` | Upload to S3; read from S3 first; `driveFolderFor`. |
| `backend/src/drive.ts` | Track imported Drive files in `resume_files`. |
| `backend/src/routes/candidates.ts` | Replace/Rename routes; deletion countdown on candidate delete. |
| `backend/src/config.ts`, `settings.ts`, `index.ts`, `serialize.ts`, `routes/bootstrap.ts` | Config, settings keys, worker start, sync state in bootstrap. |
| `frontend/src/types.ts`, `lib/permissions.ts`, `data/store.ts` | Types, permission, store actions. |
| `frontend/src/components/candidate.tsx` | Replace/Rename buttons, sync badge, cache-busting preview URL. |
| `frontend/src/pages/ResumeSync.tsx` (new), `pages/Settings.tsx` | Dashboard tab. |
| `.env.example`, `DEPLOY.md` | S3 setup. |

---

### Task 1: Pure sync rules and their check script

**Files:**
- Create: `backend/src/sync-rules.ts`
- Create: `backend/scripts/check-sync.ts`
- Modify: `backend/package.json` (add `check:sync` script)

**Interfaces:**
- Produces (exact):
  - `type SyncState = "pending" | "synced" | "conflict" | "failed" | "pending_deletion" | "deleted"`
  - `type JobKind = "to_s3" | "to_drive" | "rename_s3" | "rename_drive" | "stash_conflict" | "purge"`
  - `const GOOGLE_DOC: string`, `const MAX_ATTEMPTS = 8`
  - `digest(data: Buffer): { sha256: string; md5: string }`
  - `safeKeyName(name: string): string`, `s3NameFor(fileName: string, mimeType: string): string`, `s3MimeFor(mimeType: string): string`, `s3KeyFor(sourceId: string, fileName: string, mimeType: string): string`
  - `resolveFileName(name: string | null | undefined, driveFileId: string, mimeType: string): { fileName: string; reviewReason: string | null }`
  - `interface Baseline { driveMd5: string | null; driveVersion: string | null; driveName: string | null }`
  - `interface DriveObservation { removed: boolean; trashed: boolean; md5: string | null; version: string | null; name: string; mimeType: string }`
  - `interface PortalPending { contentQueued: boolean; contentMd5: string | null; renameTo: string | null }`
  - `type Decision = { do: "copy_to_s3" } | { do: "rename_s3"; name: string } | { do: "conflict"; on: "content" | "name" } | { do: "start_deletion" } | { do: "cancel_deletion" } | { do: "check_removed" }`
  - `decide(row: { state: SyncState; deletedSide: string | null }, base: Baseline, obs: DriveObservation, pending: PortalPending): Decision[]`
  - `backoffMs(attempts: number, rand?: () => number): number`
  - `class ChecksumMismatch extends Error` (`name === "ChecksumMismatch"`, message starts with `"Checksum mismatch"`)
  - `isPermanent(err: unknown, previousError: string | null): boolean`

- [ ] **Step 1: Write the failing check script**

`backend/scripts/check-sync.ts`:

```ts
// Run: npm run check:sync — assert-based checks of the pure resume-sync rules.
import assert from "node:assert/strict";
import { backoffMs, ChecksumMismatch, decide, GOOGLE_DOC, isPermanent, resolveFileName, s3KeyFor, safeKeyName, type Baseline, type DriveObservation, type PortalPending } from "../src/sync-rules.ts";

const PDF = "application/pdf";
const base: Baseline = { driveMd5: "aaa", driveVersion: "10", driveName: "cv.pdf" };
const obs = (o: Partial<DriveObservation> = {}): DriveObservation => ({ removed: false, trashed: false, md5: "aaa", version: "10", name: "cv.pdf", mimeType: PDF, ...o });
const none: PortalPending = { contentQueued: false, contentMd5: null, renameTo: null };
const synced = { state: "synced" as const, deletedSide: null };

// --- decide ---
assert.deepEqual(decide(synced, base, obs(), none), [], "no change → nothing");
assert.deepEqual(decide(synced, base, obs({ md5: "bbb", version: "11" }), none), [{ do: "copy_to_s3" }], "content edit → copy to S3");
assert.deepEqual(decide(synced, base, obs({ name: "new.pdf", version: "11" }), none), [{ do: "rename_s3", name: "new.pdf" }], "rename → S3 rename, no copy");
assert.deepEqual(decide(synced, base, obs({ md5: "ccc" }), { contentQueued: true, contentMd5: "ccc", renameTo: null }), [], "our own upload echoing back → ignored");
assert.deepEqual(decide(synced, base, obs({ md5: "ddd" }), { contentQueued: true, contentMd5: "ccc", renameTo: null }), [{ do: "conflict", on: "content" }], "both sides changed → conflict");
assert.deepEqual(decide(synced, base, obs({ md5: "ddd" }), { contentQueued: true, contentMd5: null, renameTo: null }), [{ do: "conflict", on: "content" }], "portal change not pushed yet + Drive edit → conflict");
assert.deepEqual(decide(synced, base, obs({ name: "x.pdf" }), { ...none, renameTo: "x.pdf" }), [], "our own rename echoing back → ignored");
assert.deepEqual(decide(synced, base, obs({ name: "y.pdf" }), { ...none, renameTo: "x.pdf" }), [{ do: "conflict", on: "name" }], "renamed on both sides → name conflict");
assert.deepEqual(decide(synced, base, obs({ trashed: true }), none), [{ do: "start_deletion" }], "trashed → countdown");
assert.deepEqual(decide({ state: "pending_deletion", deletedSide: "drive" }, base, obs({ trashed: true }), none), [], "still trashed → nothing new");
assert.deepEqual(decide({ state: "pending_deletion", deletedSide: "drive" }, base, obs(), none), [{ do: "cancel_deletion" }], "untrashed → cancel countdown");
assert.deepEqual(decide({ state: "pending_deletion", deletedSide: "portal" }, base, obs({ md5: "zzz" }), none), [], "portal-deleted: Drive edits don't revive it");
assert.deepEqual(decide(synced, base, obs({ removed: true }), none), [{ do: "check_removed" }], "removed → confirm with files.get first");
assert.deepEqual(decide({ state: "conflict", deletedSide: null }, base, obs({ md5: "eee" }), none), [], "conflict is frozen until an Admin resolves it");
const doc: Baseline = { driveMd5: null, driveVersion: "5", driveName: "CV" };
assert.deepEqual(decide(synced, doc, obs({ md5: null, version: "6", name: "CV", mimeType: GOOGLE_DOC }), none), [{ do: "copy_to_s3" }], "Google Doc edit detected by version");
assert.deepEqual(decide(synced, doc, obs({ md5: null, version: "6", name: "CV", mimeType: GOOGLE_DOC }), { contentQueued: true, contentMd5: "x", renameTo: null }), [], "portal replaced a Google Doc → Doc gets archived, not a conflict");
assert.deepEqual(decide(synced, base, obs({ name: "" }), none), [], "Drive returned no name → not a rename");

// --- keys and names ---
assert.equal(s3KeyFor("1AbC", "Ritik_Saini_Java_Developer_Resume.pdf", PDF), "resumes/1AbC/Ritik_Saini_Java_Developer_Resume.pdf");
assert.notEqual(s3KeyFor("id1", "cv.pdf", PDF), s3KeyFor("id2", "cv.pdf", PDF), "same name under two ids → different keys");
assert.equal(safeKeyName("a/b\\c\u0001.pdf"), "a_b_c_.pdf");
assert.equal(s3KeyFor("d1", "My CV", GOOGLE_DOC), "resumes/d1/My CV.pdf", "Google Doc stored as PDF");
const long = "é".repeat(300) + ".pdf";
const trimmed = safeKeyName(long);
assert.ok(Buffer.byteLength(trimmed) <= 200 && trimmed.endsWith(".pdf") && !trimmed.includes("�"), "trimmed to 200 bytes, extension kept, no broken characters");
assert.deepEqual(resolveFileName("  ", "XYZ", PDF), { fileName: "resume_XYZ.pdf", reviewReason: "missing_filename" });
assert.deepEqual(resolveFileName("cv.pdf", "XYZ", PDF), { fileName: "cv.pdf", reviewReason: null });

// --- retries ---
assert.equal(backoffMs(1, () => 0.5), 60_000);
assert.equal(backoffMs(20, () => 0.5), 3_600_000, "capped at 1h");
assert.equal(backoffMs(1, () => 0), 48_000, "-20% jitter");
assert.equal(isPermanent(Object.assign(new Error("x"), { status: 404 }), null), true);
assert.equal(isPermanent(new Error("Google API error (403): The user does not have sufficient permissions"), null), true);
assert.equal(isPermanent(new Error("Google API error (403): User Rate Limit Exceeded"), null), false, "rate limit 403 is transient");
assert.equal(isPermanent(new Error("socket hang up"), null), false);
assert.equal(isPermanent(new ChecksumMismatch("S3 read-back"), null), false, "first checksum mismatch → retry");
assert.equal(isPermanent(new ChecksumMismatch("S3 read-back"), "Checksum mismatch: S3 read-back"), true, "second in a row → fail");
assert.equal(isPermanent(Object.assign(new Error("x"), { name: "NoSuchKey" }), null), true);

console.log("check-sync: all assertions passed");
```

Add to `backend/package.json` `"scripts"`:

```json
"check:sync": "node scripts/check-sync.ts",
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npm run check:sync`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/sync-rules.ts`.

- [ ] **Step 3: Implement `backend/src/sync-rules.ts`**

```ts
/** Pure decision logic for resume sync: no I/O, so scripts/check-sync.ts can test it directly. */
import crypto from "node:crypto";

export type SyncState = "pending" | "synced" | "conflict" | "failed" | "pending_deletion" | "deleted";
export type JobKind = "to_s3" | "to_drive" | "rename_s3" | "rename_drive" | "stash_conflict" | "purge";

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
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd backend && npm run check:sync`
Expected: `check-sync: all assertions passed`

- [ ] **Step 5: Commit**

```bash
git add backend/src/sync-rules.ts backend/scripts/check-sync.ts backend/package.json
git commit -m "feat(sync): pure resume-sync rules with assert-based checks"
```

---

### Task 2: Schema, config, S3 wrapper, settings, permission

**Files:**
- Create: `backend/prisma/migrations/004_resume_sync/migration.sql`
- Modify: `backend/prisma/schema.prisma` (add two models plus a relation on `candidates`)
- Create: `backend/src/s3.ts`
- Modify: `backend/src/config.ts`, `backend/src/settings.ts`, `frontend/src/lib/permissions.ts`, `frontend/src/types.ts`, `.env.example`
- Modify: `backend/package.json` (dependency)

**Interfaces:**
- Produces:
  - Prisma models `resume_files`, `sync_jobs` (columns below); `candidates.resume_files` relation.
  - `config.s3 = { region, bucket, accessKeyId, secretAccessKey }`, `config.resumeDeleteGraceDays: number`
  - `s3Configured(): boolean`, `put(key, data: Buffer, mimeType, sha256): Promise<{ versionId: string }>`, `get(key, versionId?): Promise<Buffer>`, `head(key, versionId?): Promise<{ size: number; sha256: string; versionId: string }>`, `copy(fromKey, toKey): Promise<{ versionId: string }>`, `remove(key): Promise<void>` (all in `s3.ts`)
  - Settings keys: `getSetting("driveChanges") → { pageToken: string; driveId: string; lastSuccessAt: string }`, `getSetting("migration") → { startedAt: string }`
  - Permission `"storage.manage"`.
  - Frontend `ResumeFile` gains `storage?: "drive" | "local" | "s3"`, `resumeFileId?: string`, `version?: string`, `syncState?: SyncStateName`, and an exported `type SyncStateName`.

- [ ] **Step 1: Switch to the local database**

Run in a separate terminal: `cd backend && npm run dev:db`
In `backend/.env`, comment out the Supabase `DATABASE_URL` and add `DATABASE_URL=postgres://postgres:postgres@localhost:5433/hirely`. Never apply this migration to Supabase while developing.

- [ ] **Step 2: Write the migration**

`backend/prisma/migrations/004_resume_sync/migration.sql`:

```sql
-- Resumes in S3 (primary) kept in sync with Google Drive (secondary). See docs/superpowers/specs/2026-10-15-s3-drive-resume-sync-design.md
create table resume_files (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid unique references candidates(id) on delete set null,
  file_name text not null,
  mime_type text not null,
  size_bytes int not null default 0,
  s3_key text unique,
  s3_version_id text,
  sha256 text,
  drive_file_id text unique,
  drive_md5 text,
  drive_version text,
  drive_name text,
  local_path text unique,
  state text not null default 'pending' check (state in ('pending', 'synced', 'conflict', 'failed', 'pending_deletion', 'deleted')),
  conflict jsonb,
  review_reason text,
  delete_after timestamptz,
  deleted_side text check (deleted_side in ('drive', 'portal')),
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index resume_files_state_idx on resume_files(state);

create table sync_jobs (
  id uuid primary key default gen_random_uuid(),
  resume_file_id uuid not null references resume_files(id) on delete cascade,
  kind text not null check (kind in ('to_s3', 'to_drive', 'rename_s3', 'rename_drive', 'stash_conflict', 'purge')),
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  payload jsonb not null default '{}',
  attempts int not null default 0,
  run_after timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
-- At most one queued job per (resume, kind): duplicate enqueues merge into it. (Prisma can't express partial indexes; it lives here only.)
create unique index sync_jobs_one_queued_idx on sync_jobs(resume_file_id, kind) where status = 'queued';
create index sync_jobs_due_idx on sync_jobs(status, run_after);
```

- [ ] **Step 3: Add the models to `schema.prisma`**

Append:

```prisma
model resume_files {
  id             String      @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  candidate_id   String?     @unique @db.Uuid
  file_name      String
  mime_type      String
  size_bytes     Int         @default(0)
  s3_key         String?     @unique
  s3_version_id  String?
  sha256         String?
  drive_file_id  String?     @unique
  drive_md5      String?
  drive_version  String?
  drive_name     String?
  local_path     String?     @unique
  state          String      @default("pending")
  conflict       Json?
  review_reason  String?
  delete_after   DateTime?   @db.Timestamptz(6)
  deleted_side   String?
  last_synced_at DateTime?   @db.Timestamptz(6)
  last_error     String?
  created_at     DateTime    @default(now()) @db.Timestamptz(6)
  updated_at     DateTime    @default(now()) @db.Timestamptz(6)
  candidates     candidates? @relation(fields: [candidate_id], references: [id], onDelete: SetNull, onUpdate: NoAction)
  sync_jobs      sync_jobs[]

  @@index([state], map: "resume_files_state_idx")
}

model sync_jobs {
  id             String       @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  resume_file_id String       @db.Uuid
  kind           String
  status         String       @default("queued")
  payload        Json         @default("{}")
  attempts       Int          @default(0)
  run_after      DateTime     @default(now()) @db.Timestamptz(6)
  last_error     String?
  created_at     DateTime     @default(now()) @db.Timestamptz(6)
  finished_at    DateTime?    @db.Timestamptz(6)
  resume_files   resume_files @relation(fields: [resume_file_id], references: [id], onDelete: Cascade, onUpdate: NoAction)

  @@index([status, run_after], map: "sync_jobs_due_idx")
}
```

In `model candidates`, add the line `resume_files     resume_files?` after `drive_files      drive_files[]`.

- [ ] **Step 4: Install the SDK, regenerate the client, apply the migration**

Run: `cd backend && npm install @aws-sdk/client-s3 && npx prisma generate && npx prisma migrate deploy`
Expected: `004_resume_sync` applied with no errors. `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` prints only the partial index `sync_jobs_one_queued_idx` (expected, since it can't be expressed in Prisma) or nothing.

- [ ] **Step 5: Config, settings, S3 wrapper, permission, types**

`backend/src/config.ts`: inside `config`, after `driveSyncMinutes`:

```ts
  /** Primary resume storage. Empty = resumes stay in Drive / on disk as before. */
  s3: {
    region: str("AWS_REGION"),
    bucket: str("S3_BUCKET"),
    accessKeyId: str("AWS_ACCESS_KEY_ID"),
    secretAccessKey: str("AWS_SECRET_ACCESS_KEY"),
  },
  /** Days a deleted resume's other copy is kept before it is removed. */
  resumeDeleteGraceDays: Math.max(1, Number(str("RESUME_DELETE_GRACE_DAYS", "30"))),
```

`backend/src/settings.ts`: add to `DEFAULTS`:

```ts
  driveChanges: () => ({ pageToken: "", driveId: "", lastSuccessAt: "" }),
  migration: () => ({ startedAt: "" }),
```

`backend/src/s3.ts`:

```ts
/** Resume objects in S3 (versioned bucket). Our own SHA-256 is stored as object metadata; ETags are never used as checksums. */
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config } from "./config.ts";

let client: S3Client | null = null;
const s3 = () =>
  (client ??= new S3Client({ region: config.s3.region, credentials: { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey } }));
const Bucket = () => config.s3.bucket;

export const s3Configured = () => !!(config.s3.bucket && config.s3.region && config.s3.accessKeyId && config.s3.secretAccessKey);

export async function put(key: string, data: Buffer, mimeType: string, sha256: string): Promise<{ versionId: string }> {
  const res = await s3().send(new PutObjectCommand({ Bucket: Bucket(), Key: key, Body: data, ContentType: mimeType, Metadata: { sha256 } }));
  if (!res.VersionId) throw new Error("S3 bucket versioning is off — turn it on (see DEPLOY.md)");
  return { versionId: res.VersionId };
}

export async function get(key: string, versionId?: string): Promise<Buffer> {
  const res = await s3().send(new GetObjectCommand({ Bucket: Bucket(), Key: key, VersionId: versionId }));
  return Buffer.from(await res.Body!.transformToByteArray());
}

export async function head(key: string, versionId?: string): Promise<{ size: number; sha256: string; versionId: string }> {
  const res = await s3().send(new HeadObjectCommand({ Bucket: Bucket(), Key: key, VersionId: versionId }));
  return { size: res.ContentLength ?? -1, sha256: res.Metadata?.sha256 ?? "", versionId: res.VersionId ?? "" };
}

/** Server-side copy; metadata (incl. sha256) is copied with the object. */
export async function copy(fromKey: string, toKey: string): Promise<{ versionId: string }> {
  const source = `${Bucket()}/${fromKey.split("/").map(encodeURIComponent).join("/")}`;
  const res = await s3().send(new CopyObjectCommand({ Bucket: Bucket(), Key: toKey, CopySource: source }));
  if (!res.VersionId) throw new Error("S3 bucket versioning is off — turn it on (see DEPLOY.md)");
  return { versionId: res.VersionId };
}

/** On a versioned bucket this adds a delete marker; earlier versions stay until the lifecycle rule expires them. */
export async function remove(key: string): Promise<void> {
  await s3().send(new DeleteObjectCommand({ Bucket: Bucket(), Key: key }));
}
```

`frontend/src/lib/permissions.ts`: add `"storage.manage": ["admin", "super_admin"],` after `"users.delete"`, and `{ key: "storage.manage", label: "Manage resume storage sync" },` after the `users.delete` entry in `PERMISSION_GROUPS`.

`frontend/src/types.ts`: replace the `ResumeFile` interface with:

```ts
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
```

`.env.example`: after the `DRIVE_SYNC_MINUTES=5` line add:

```
# Amazon S3: primary resume storage (Google Drive stays in sync). Leave empty to keep resumes in Drive only.
# The bucket must have Versioning turned on — see DEPLOY.md.
AWS_REGION=
S3_BUCKET=
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
# Days a resume deleted on one side is kept on the other before removal.
RESUME_DELETE_GRACE_DAYS=30
```

- [ ] **Step 6: Type-check**

Run: `cd backend && npm run typecheck && cd ../frontend && npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add backend/prisma backend/src/s3.ts backend/src/config.ts backend/src/settings.ts backend/package.json backend/package-lock.json frontend/src/lib/permissions.ts frontend/src/types.ts .env.example
git commit -m "feat(sync): resume_files/sync_jobs schema, S3 wrapper, config"
```

---

### Task 3: Durable job queue

**Files:**
- Create: `backend/src/sync-queue.ts`

**Interfaces:**
- Consumes: `JobKind`, `MAX_ATTEMPTS`, `backoffMs`, `isPermanent` (Task 1); Prisma models (Task 2).
- Produces:
  - `type Db = Prisma.TransactionClient | typeof prisma`
  - `interface JobRow { id: string; resume_file_id: string; kind: JobKind; payload: Record<string, unknown>; attempts: number; last_error: string | null }`
  - `enqueue(resumeFileId: string, kind: JobKind, payload?: Record<string, unknown>, db?: Db): Promise<void>` (merges into an existing queued job of the same kind; payload keys are merged)
  - `claimNext(): Promise<JobRow | null>`
  - `complete(jobId: string, db?: Db, note?: string): Promise<void>`
  - `fail(job: JobRow, err: unknown): Promise<void>`
  - `setPayload(jobId: string, payload: Record<string, unknown>): Promise<void>`
  - `retryRow(resumeFileId: string): Promise<void>`
  - `resetRunning(): Promise<void>`

- [ ] **Step 1: Implement `backend/src/sync-queue.ts`**

```ts
/** sync_jobs: the durable work queue. One worker (sync-jobs.ts) claims jobs one at a time. */
import { Prisma, prisma } from "./db.ts";
import { backoffMs, isPermanent, MAX_ATTEMPTS, type JobKind } from "./sync-rules.ts";

export type Db = Prisma.TransactionClient | typeof prisma;

export interface JobRow {
  id: string;
  resume_file_id: string;
  kind: JobKind;
  payload: Record<string, unknown>;
  attempts: number;
  last_error: string | null;
}

/** Adds a job, or merges into the one already queued for this resume and kind (never duplicates). */
export async function enqueue(resumeFileId: string, kind: JobKind, payload: Record<string, unknown> = {}, db: Db = prisma) {
  await db.$executeRaw`
    insert into sync_jobs (resume_file_id, kind, payload) values (${resumeFileId}::uuid, ${kind}, ${JSON.stringify(payload)}::jsonb)
    on conflict (resume_file_id, kind) where status = 'queued'
    do update set payload = sync_jobs.payload || excluded.payload, run_after = least(sync_jobs.run_after, now())`;
}

export async function claimNext(): Promise<JobRow | null> {
  const rows = await prisma.$queryRaw<JobRow[]>`
    update sync_jobs set status = 'running'
    where id = (select id from sync_jobs where status = 'queued' and run_after <= now() order by run_after, created_at limit 1 for update skip locked)
    returning id, resume_file_id, kind, payload, attempts, last_error`;
  return rows[0] ?? null;
}

export async function complete(jobId: string, db: Db = prisma, note?: string) {
  await db.sync_jobs.update({ where: { id: jobId }, data: { status: "done", finished_at: new Date(), last_error: note ?? null } });
}

export async function setPayload(jobId: string, payload: Record<string, unknown>) {
  await prisma.sync_jobs.update({ where: { id: jobId }, data: { payload: payload as Prisma.InputJsonValue } });
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

export async function fail(job: JobRow, err: unknown) {
  const message = errText(err);
  const attempts = job.attempts + 1;
  if (isPermanent(err, job.last_error) || attempts >= MAX_ATTEMPTS) {
    await prisma.$transaction([
      prisma.sync_jobs.update({ where: { id: job.id }, data: { status: "failed", attempts, last_error: message, finished_at: new Date() } }),
      // Conflict / deletion states win over "failed": they need a person anyway.
      prisma.$executeRaw`update resume_files set last_error = ${message}, updated_at = now(),
        state = case when state in ('pending', 'synced') then 'failed' else state end where id = ${job.resume_file_id}::uuid`,
    ]);
    return;
  }
  const runAfter = new Date(Date.now() + backoffMs(attempts));
  const requeued = await prisma.$executeRaw`
    update sync_jobs set status = 'queued', attempts = ${attempts}, last_error = ${message}, run_after = ${runAfter}
    where id = ${job.id}::uuid and not exists (
      select 1 from sync_jobs q where q.resume_file_id = ${job.resume_file_id}::uuid and q.kind = ${job.kind} and q.status = 'queued')`;
  // A newer job of the same kind is already queued: it supersedes this one.
  if (!requeued) await complete(job.id, prisma, `superseded after: ${message}`);
}

/** Admin "Retry": failed jobs go back to the queue with a fresh attempt count. */
export async function retryRow(resumeFileId: string) {
  await prisma.$executeRaw`
    update sync_jobs j set status = 'queued', attempts = 0, run_after = now(), finished_at = null
    where j.resume_file_id = ${resumeFileId}::uuid and j.status = 'failed' and not exists (
      select 1 from sync_jobs q where q.resume_file_id = j.resume_file_id and q.kind = j.kind and q.status = 'queued')`;
  await prisma.resume_files.updateMany({ where: { id: resumeFileId, state: "failed" }, data: { state: "pending", last_error: null, updated_at: new Date() } });
}

/** After a crash, jobs left "running" go back to the queue (or are dropped if a twin is already queued). */
export async function resetRunning() {
  await prisma.$executeRaw`
    update sync_jobs j set status = 'done', finished_at = now(), last_error = 'superseded after restart'
    where j.status = 'running' and exists (
      select 1 from sync_jobs q where q.resume_file_id = j.resume_file_id and q.kind = j.kind and q.status = 'queued')`;
  await prisma.$executeRaw`update sync_jobs set status = 'queued' where status = 'running'`;
}
```

- [ ] **Step 2: Type-check**

Run: `cd backend && npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Smoke-test the queue against the local database**

Create `backend/_queue_smoke.ts` (deleted afterwards):

```ts
import assert from "node:assert/strict";
import { prisma } from "./src/db.ts";
import { claimNext, enqueue, fail, retryRow } from "./src/sync-queue.ts";

const row = await prisma.resume_files.create({ data: { file_name: "smoke.pdf", mime_type: "application/pdf" } });
await enqueue(row.id, "to_s3", { a: 1 });
await enqueue(row.id, "to_s3", { b: 2 });
assert.equal(await prisma.sync_jobs.count({ where: { resume_file_id: row.id } }), 1, "duplicate enqueue merged");
const job = (await claimNext())!;
assert.deepEqual(job.payload, { a: 1, b: 2 });
await fail(job, Object.assign(new Error("gone"), { status: 404 }));
assert.equal((await prisma.resume_files.findUniqueOrThrow({ where: { id: row.id } })).state, "failed", "permanent error fails the row");
await retryRow(row.id);
assert.equal((await prisma.sync_jobs.findFirstOrThrow({ where: { resume_file_id: row.id } })).status, "queued");
await prisma.resume_files.delete({ where: { id: row.id } });
console.log("queue smoke: ok");
await prisma.$disconnect();
```

Run: `cd backend && node --env-file-if-exists=.env _queue_smoke.ts && rm _queue_smoke.ts`
Expected: `queue smoke: ok`

- [ ] **Step 4: Commit**

```bash
git add backend/src/sync-queue.ts
git commit -m "feat(sync): durable sync_jobs queue with merge, backoff and retry"
```

---

### Task 4: Resume-file helpers and Google Drive calls

**Files:**
- Create: `backend/src/resume-files.ts`
- Modify: `backend/src/google.ts`
- Modify: `backend/src/storage.ts` (extract `driveFolderFor`)

**Interfaces:**
- Consumes: `s3` functions (Task 2); `enqueue`, `Db` (Task 3); `digest`, `s3KeyFor`, `s3NameFor`, `s3MimeFor`, `safeKeyName`, `resolveFileName`, `ChecksumMismatch` (Task 1).
- Produces (`resume-files.ts`):
  - `type ResumeFileRow` (Prisma `resume_files` row)
  - `resumeJson(row: ResumeFileRow, prev?: Partial<ResumeFile>): ResumeFile`
  - `syncCandidateResume(db: Db, row: ResumeFileRow): Promise<void>`
  - `graceDate(): Date`
  - `startDeletion(id: string, side: "drive" | "portal"): Promise<void>`
  - `trackDriveImport(candidateId: string, f: { drive_file_id: string; file_name: string; mime_type: string }): Promise<void>`
  - `renameInS3(row: ResumeFileRow, name: string, extra?: { drive_name?: string }): Promise<ResumeFileRow>`
  - `registerDriveFile(id: string, name: string, mimeType: string, folderId: string, sizeBytes: number): Promise<void>`
- Produces (`google.ts`):
  - `DriveFile` gains `md5Checksum?: string; version?: string; trashed?: boolean; driveId?: string`
  - `interface DriveChange { fileId: string; removed: boolean; file?: DriveFile }`
  - `generateFileId(): Promise<string>`
  - `uploadFile(folderId, name, mimeType, data, id?: string): Promise<DriveFile>` (new optional `id`)
  - `updateFileContent(fileId: string, mimeType: string, data: Buffer): Promise<void>`
  - `renameFile(fileId: string, name: string): Promise<void>`
  - `setTrashed(fileId: string, trashed: boolean): Promise<void>`
  - `getStartPageToken(driveId: string): Promise<string>`
  - `listChanges(pageToken: string, driveId: string): Promise<{ changes: DriveChange[]; nextPageToken?: string; newStartPageToken?: string }>`
- Produces (`storage.ts`): `driveFolderFor(jobId: string | null, sourceName?: string | null): Promise<string | null>`

- [ ] **Step 1: Extend `google.ts`**

Change the `DriveFile` interface to:

```ts
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  md5Checksum?: string;
  /** Increases on every change to the file (content or metadata). */
  version?: string;
  trashed?: boolean;
  driveId?: string;
  modifiedTime?: string;
  webViewLink?: string;
  parents?: string[];
}
```

Change the `fields=` list in `getFileMeta` to `id,name,mimeType,size,md5Checksum,version,trashed,driveId,modifiedTime,webViewLink,parents`.

Replace `uploadFile` with:

```ts
/** `id` (from generateFileId) makes the upload idempotent: a retry with the same id can't create a second file. */
export async function uploadFile(folderId: string, name: string, mimeType: string, data: Buffer, id?: string): Promise<DriveFile> {
  const boundary = `hirely${Date.now().toString(36)}`;
  const meta = JSON.stringify({ ...(id ? { id } : {}), name, parents: [folderId], mimeType });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\ncontent-type: ${mimeType}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const res = await gfetch(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,size,md5Checksum,version,webViewLink`, {
    method: "POST",
    headers: { "content-type": `multipart/related; boundary=${boundary}` },
    body,
  });
  return (await res.json()) as DriveFile;
}
```

Append after `moveFile`:

```ts
export async function generateFileId(): Promise<string> {
  const res = await gfetch(`${DRIVE}/files/generateIds?count=1&space=drive&type=files`);
  return ((await res.json()) as { ids: string[] }).ids[0]!;
}

/** Uploads new content as a new revision of the same file (same id, same links). */
export async function updateFileContent(fileId: string, mimeType: string, data: Buffer): Promise<void> {
  await gfetch(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media&supportsAllDrives=true`, {
    method: "PATCH",
    headers: { "content-type": mimeType },
    body: data,
  });
}

async function patchMeta(fileId: string, body: object) {
  await gfetch(`${DRIVE}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
export const renameFile = (fileId: string, name: string) => patchMeta(fileId, { name });
export const setTrashed = (fileId: string, trashed: boolean) => patchMeta(fileId, { trashed });

export interface DriveChange {
  fileId: string;
  removed: boolean;
  file?: DriveFile;
}

const driveParam = (driveId: string) => (driveId ? `&driveId=${encodeURIComponent(driveId)}` : "");

export async function getStartPageToken(driveId: string): Promise<string> {
  const res = await gfetch(`${DRIVE}/changes/startPageToken?supportsAllDrives=true${driveParam(driveId)}`);
  return ((await res.json()) as { startPageToken: string }).startPageToken;
}

export async function listChanges(pageToken: string, driveId: string) {
  const fields = "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,size,md5Checksum,version,trashed,parents))";
  const res = await gfetch(
    `${DRIVE}/changes?pageToken=${encodeURIComponent(pageToken)}&pageSize=1000&includeRemoved=true&${common}${driveParam(driveId)}&fields=${encodeURIComponent(fields)}`,
  );
  return (await res.json()) as { changes: DriveChange[]; nextPageToken?: string; newStartPageToken?: string };
}
```

- [ ] **Step 2: Extract `driveFolderFor` in `storage.ts`**

Add:

```ts
/** The Drive folder a resume belongs in: <root>/<Job>/<Source>/ (or the root when there's no job). */
export async function driveFolderFor(jobId: string | null, sourceName?: string | null): Promise<string | null> {
  let folderId = jobId ? await ensureJobFolder(jobId) : (await google.isConnected()) ? await google.ensureRootFolder() : null;
  if (folderId && jobId && sourceName) folderId = await google.findOrCreateFolder(sourceName, folderId);
  return folderId;
}
```

In `storeResume`, replace the two lines that compute `folderId` with `const folderId = await driveFolderFor(input.jobId, input.sourceName);`.

- [ ] **Step 3: Implement `backend/src/resume-files.ts`**

```ts
/** resume_files rows: the bridge between a candidate, its S3 object and its Drive file. */
import type { ResumeFile } from "../../frontend/src/types.ts";
import { config } from "./config.ts";
import { Prisma, prisma } from "./db.ts";
import * as s3 from "./s3.ts";
import { enqueue, type Db } from "./sync-queue.ts";
import { ChecksumMismatch, resolveFileName, s3MimeFor, s3NameFor, safeKeyName } from "./sync-rules.ts";

export type ResumeFileRow = NonNullable<Awaited<ReturnType<typeof prisma.resume_files.findUnique>>>;

/** The candidates.resume JSON for a resume served from S3 (shape the UI already understands). */
export function resumeJson(row: ResumeFileRow, prev: Partial<ResumeFile> = {}): ResumeFile {
  return {
    ...prev,
    storage: "s3",
    resumeFileId: row.id,
    version: row.s3_version_id ?? undefined,
    driveFileId: row.drive_file_id ?? "",
    driveUrl: row.drive_file_id ? `https://drive.google.com/file/d/${row.drive_file_id}/view` : "",
    fileName: row.file_name,
    mimeType: s3MimeFor(row.mime_type),
    sizeKb: Math.max(1, Math.round(row.size_bytes / 1024)),
    uploadedAt: prev.uploadedAt ?? row.created_at.toISOString(),
    uploadedById: prev.uploadedById ?? "",
  };
}

/** Points the candidate at the row's current S3 object. Only call once that object is verified. */
export async function syncCandidateResume(db: Db, row: ResumeFileRow) {
  if (!row.candidate_id || !row.s3_key) return;
  const c = await db.candidates.findUnique({ where: { id: row.candidate_id }, select: { resume: true } });
  const json = resumeJson(row, (c?.resume ?? {}) as Partial<ResumeFile>);
  await db.candidates.update({ where: { id: row.candidate_id }, data: { resume: json as unknown as Prisma.InputJsonValue } });
}

export const graceDate = () => new Date(Date.now() + config.resumeDeleteGraceDays * 86_400_000);

export async function startDeletion(id: string, side: "drive" | "portal") {
  await prisma.resume_files.update({ where: { id }, data: { state: "pending_deletion", deleted_side: side, delete_after: graceDate(), updated_at: new Date() } });
}

/** A Drive file just became a candidate: track it and copy it to S3. Reuses the row if this file was seen before. */
export async function trackDriveImport(candidateId: string, f: { drive_file_id: string; file_name: string; mime_type: string }) {
  if (!s3.s3Configured()) return;
  const { fileName, reviewReason } = resolveFileName(f.file_name, f.drive_file_id, f.mime_type);
  const row = await prisma.resume_files.upsert({
    where: { drive_file_id: f.drive_file_id },
    create: { candidate_id: candidateId, file_name: fileName, mime_type: f.mime_type, drive_file_id: f.drive_file_id, review_reason: reviewReason },
    update: { candidate_id: candidateId, state: "pending", delete_after: null, deleted_side: null, updated_at: new Date() },
  });
  await enqueue(row.id, "to_s3");
}

/** Keeps the folder scan from importing a file we uploaded ourselves. */
export async function registerDriveFile(id: string, name: string, mimeType: string, folderId: string, sizeBytes: number) {
  await prisma.drive_files.createMany({
    data: { drive_file_id: id, file_name: name, mime_type: mimeType, folder_id: folderId, size_kb: Math.max(1, Math.round(sizeBytes / 1024)), status: "imported" },
    skipDuplicates: true,
  });
}

/**
 * Renames the resume. The S3 object moves to a new key under the same `resumes/{sourceId}/` prefix
 * (server-side copy, verified, then the old key is removed). Same row, so candidate links don't change.
 */
export async function renameInS3(row: ResumeFileRow, name: string, extra: { drive_name?: string } = {}): Promise<ResumeFileRow> {
  if (!row.s3_key) {
    // Not copied to S3 yet: to_s3 will use the new name.
    return prisma.resume_files.update({ where: { id: row.id }, data: { file_name: name, ...extra, updated_at: new Date() } });
  }
  const prefix = row.s3_key.split("/").slice(0, 2).join("/");
  const newKey = `${prefix}/${safeKeyName(s3NameFor(name, row.mime_type))}`;
  let versionId = row.s3_version_id;
  if (newKey !== row.s3_key) {
    ({ versionId } = await s3.copy(row.s3_key, newKey));
    const h = await s3.head(newKey, versionId);
    if (h.size !== row.size_bytes || h.sha256 !== row.sha256) throw new ChecksumMismatch("S3 copy");
  }
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.resume_files.update({ where: { id: row.id }, data: { s3_key: newKey, s3_version_id: versionId, file_name: name, ...extra, updated_at: new Date() } });
    await syncCandidateResume(tx, u);
    return u;
  });
  if (newKey !== row.s3_key) await s3.remove(row.s3_key).catch((e) => console.warn("[sync] couldn't remove old key", row.s3_key, e));
  return updated;
}
```

- [ ] **Step 4: Type-check**

Run: `cd backend && npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add backend/src/resume-files.ts backend/src/google.ts backend/src/storage.ts
git commit -m "feat(sync): resume-file helpers and Drive change/revision API calls"
```

---

### Task 5: Copy to S3, the worker loop, and the migration

**Files:**
- Create: `backend/src/sync-jobs.ts`
- Modify: `backend/src/resume-files.ts` (add `startMigration`)
- Modify: `backend/src/index.ts` (start the worker), `backend/src/drive.ts` (track imports)

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  - `syncTick(): Promise<void>` (single-flight; runs due jobs for up to 50 s, polls Drive changes every `DRIVE_SYNC_MINUTES`, schedules purges hourly)
  - `runJob(job: JobRow): Promise<void>` (dispatch; Tasks 6–8 add handlers to the same `switch`)
  - `startMigration(): Promise<{ queued: number }>` (in `resume-files.ts`)
  - `ensureChangesCheckpoint(): Promise<void>` stub here, implemented in Task 7 (`drive-changes.ts`)

- [ ] **Step 1: Create `backend/src/drive-changes.ts` with the checkpoint only (polling comes in Task 7)**

```ts
/** Google Drive Changes API: the persistent checkpoint and incremental sync of tracked resumes. */
import * as google from "./google.ts";
import { getSetting, setSetting } from "./settings.ts";

/** Takes the change-feed bookmark before anything is migrated, so no change made during migration is missed. */
export async function ensureChangesCheckpoint() {
  if (!(await google.isConnected())) return;
  const st = await getSetting("driveChanges");
  if (st.pageToken) return;
  const root = await google.getFileMeta(await google.ensureRootFolder());
  const driveId = root.driveId ?? "";
  await setSetting("driveChanges", { pageToken: await google.getStartPageToken(driveId), driveId, lastSuccessAt: new Date().toISOString() });
}

export async function pollDriveChanges(): Promise<{ applied: number }> {
  await ensureChangesCheckpoint();
  return { applied: 0 };
}
```

- [ ] **Step 2: Add `startMigration` to `resume-files.ts`**

Add these imports at the top: `import * as google from "./google.ts";`, `import { ensureChangesCheckpoint } from "./drive-changes.ts";`, `import { patchSetting } from "./settings.ts";`. Then append:

```ts
/**
 * Queues every resume that isn't on S3 yet. Safe to run any number of times: rows are keyed by the stable
 * source id (Drive file id / local file id) and duplicate jobs merge. Drive originals are never touched.
 */
export async function startMigration(): Promise<{ queued: number }> {
  if (!s3.s3Configured()) return { queued: 0 };
  await ensureChangesCheckpoint();
  await patchSetting("migration", { startedAt: new Date().toISOString() });
  const todo = await prisma.$queryRaw<{ id: string; resume: ResumeFile }[]>`
    select c.id, c.resume from candidates c left join resume_files r on r.candidate_id = c.id
    where r.id is null and c.resume is not null and coalesce(c.resume->>'driveFileId', '') <> ''`;
  let queued = 0;
  for (const c of todo) {
    const local = c.resume.storage === "local";
    const mime = c.resume.mimeType || "application/octet-stream";
    const { fileName, reviewReason } = resolveFileName(c.resume.fileName, c.resume.driveFileId, mime);
    const source = local ? { local_path: c.resume.driveFileId } : { drive_file_id: c.resume.driveFileId };
    const row = await prisma.resume_files.upsert({
      where: source,
      create: { candidate_id: c.id, file_name: fileName, mime_type: mime, size_bytes: (c.resume.sizeKb || 0) * 1024, review_reason: reviewReason, ...source },
      update: {},
    });
    if (row.candidate_id !== c.id) {
      console.warn(`[migration] ${c.id} shares its resume file with candidate ${row.candidate_id}; left on Drive`);
      continue;
    }
    await enqueue(row.id, "to_s3");
    queued++;
  }
  // Portal uploads made while Drive was disconnected still need their Drive copy.
  if (await google.isConnected()) {
    const noDrive = await prisma.resume_files.findMany({ where: { drive_file_id: null, s3_key: { not: null }, state: { in: ["pending", "synced", "failed"] } }, select: { id: true } });
    for (const r of noDrive) await enqueue(r.id, "to_drive");
    queued += noDrive.length;
  }
  return { queued };
}
```

- [ ] **Step 3: Implement `backend/src/sync-jobs.ts` with `to_s3` and the loop**

```ts
/** The sync worker: runs queued transfers one at a time, then polls Drive for changes. */
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.ts";
import { Prisma, prisma } from "./db.ts";
import { pollDriveChanges } from "./drive-changes.ts";
import * as google from "./google.ts";
import { syncCandidateResume, type ResumeFileRow } from "./resume-files.ts";
import * as s3 from "./s3.ts";
import { claimNext, complete, enqueue, fail, resetRunning, type JobRow } from "./sync-queue.ts";
import { ChecksumMismatch, digest, s3KeyFor, s3MimeFor } from "./sync-rules.ts";

const frozen = (row: ResumeFileRow, job: JobRow) =>
  (row.state === "conflict" && !job.payload.resolve) || row.state === "pending_deletion" || row.state === "deleted";

/** Puts bytes in S3 and reads them back; throws unless length and SHA-256 match. */
async function putVerified(key: string, data: Buffer, mimeType: string, sha256: string) {
  const { versionId } = await s3.put(key, data, mimeType, sha256);
  const back = await s3.get(key, versionId);
  if (back.length !== data.length || digest(back).sha256 !== sha256) throw new ChecksumMismatch("S3 read-back");
  return versionId;
}

/** Drive (or server disk) → S3. Switches the candidate to S3 only after the copy is verified. */
async function toS3(job: JobRow, row: ResumeFileRow) {
  if (frozen(row, job)) return complete(job.id, prisma, "skipped: needs review");
  let data: Buffer;
  let baseline: { drive_md5: string | null; drive_version: string | null; drive_name: string } | null = null;
  if (row.drive_file_id) {
    // Metadata first: if the file changes during the download, its newer version shows up on the next poll.
    const meta = await google.getFileMeta(row.drive_file_id);
    if (meta.trashed) return complete(job.id, prisma, "skipped: trashed in Drive");
    data = (await google.downloadFile(row.drive_file_id, meta.mimeType)).data;
    if (meta.md5Checksum && digest(data).md5 !== meta.md5Checksum) throw new ChecksumMismatch("Drive download");
    baseline = { drive_md5: meta.md5Checksum ?? null, drive_version: meta.version ?? null, drive_name: meta.name };
  } else if (row.local_path) {
    if (!/^[0-9a-f-]{36}$/.test(row.local_path)) throw new Error("Bad local file id");
    data = await fs.readFile(path.join(config.dataDir, "resumes", row.local_path));
  } else {
    throw new Error("Resume has no source to copy from");
  }
  const { sha256 } = digest(data);
  let key = row.s3_key;
  let versionId = row.s3_version_id;
  if (!key || sha256 !== row.sha256) {
    key ??= s3KeyFor(row.drive_file_id ?? row.id, row.file_name, row.mime_type);
    versionId = await putVerified(key, data, s3MimeFor(row.mime_type), sha256);
  }
  await prisma.$transaction(async (tx) => {
    const updated = await tx.resume_files.update({
      where: { id: row.id },
      data: { s3_key: key, s3_version_id: versionId, sha256, size_bytes: data.length, ...(baseline ?? {}), state: "synced", conflict: Prisma.DbNull, last_synced_at: new Date(), last_error: null, updated_at: new Date() },
    });
    await syncCandidateResume(tx, updated);
    await complete(job.id, tx);
  });
  if (row.local_path && !row.drive_file_id && (await google.isConnected())) await enqueue(row.id, "to_drive");
}

export async function runJob(job: JobRow) {
  const row = await prisma.resume_files.findUnique({ where: { id: job.resume_file_id } });
  if (!row) return complete(job.id, prisma, "skipped: resume row gone");
  switch (job.kind) {
    case "to_s3":
      return toS3(job, row);
    default:
      throw new Error(`Unknown job kind ${job.kind}`);
  }
}

let running: Promise<void> | null = null;
let lastPoll = 0;
let lastPurgeScan = 0;
let started = false;

/** One pass of the worker. Jobs and Drive polling never overlap, so a change can't race a half-finished transfer. */
export function syncTick(): Promise<void> {
  running ??= doTick().finally(() => (running = null));
  return running;
}

async function doTick() {
  if (!s3.s3Configured()) return;
  if (!started) {
    await resetRunning();
    started = true;
  }
  const deadline = Date.now() + 50_000;
  while (Date.now() < deadline) {
    const job = await claimNext();
    if (!job) break;
    try {
      await runJob(job);
    } catch (e) {
      console.warn(`[sync] ${job.kind} ${job.resume_file_id}:`, e instanceof Error ? e.message : e);
      await fail(job, e);
    }
  }
  if (Date.now() - lastPoll >= config.driveSyncMinutes * 60_000) {
    lastPoll = Date.now();
    await pollDriveChanges();
  }
  if (Date.now() - lastPurgeScan >= 3_600_000) {
    lastPurgeScan = Date.now();
    await enqueueDuePurges();
  }
}

/** Placeholder until Task 8 adds purge handling. */
async function enqueueDuePurges() {}
```

- [ ] **Step 4: Start the worker and track Drive imports**

`backend/src/index.ts`: add `import { syncTick } from "./sync-jobs.ts";` and, after `every(config.driveSyncMinutes * 60_000, "drive", syncDrive);`, add:

```ts
every(30_000, "sync", syncTick);
```

`backend/src/drive.ts`: add `import { trackDriveImport } from "./resume-files.ts";`. In `importDriveFiles`, after the `prisma.drive_files.updateMany(...)` line inside the loop, add:

```ts
    await trackDriveImport(id, f);
```

- [ ] **Step 5: Type-check and run the check script**

Run: `cd backend && npm run typecheck && npm run check:sync`
Expected: no type errors; `check-sync: all assertions passed`.

- [ ] **Step 6: Verify the migration against a test bucket**

Requires a test bucket with Versioning on and a Drive connected to a test folder (Task 10 describes the setup). Put the four `AWS_*`/`S3_BUCKET` values in `backend/.env`, start the backend, then in another terminal:

```bash
cd backend && node --env-file-if-exists=.env -e "import('./src/resume-files.ts').then(m => m.startMigration()).then(r => { console.log(r); process.exit(0) })"
```

Wait ~1 minute, then:

```bash
node --env-file-if-exists=.env -e "import('./src/db.ts').then(async ({prisma}) => { console.log(await prisma.resume_files.groupBy({ by: ['state'], _count: true })); console.log(await prisma.\$queryRaw\`select count(*)::int n from candidates where resume->>'storage' = 's3'\`); process.exit(0) })"
```

Expected: every row `synced`, and the S3 count equals the number queued. Running `startMigration()` a second time reports `{ queued: 0 }` and creates no new rows. Drive files are unchanged.

- [ ] **Step 7: Commit**

```bash
git add backend/src/sync-jobs.ts backend/src/resume-files.ts backend/src/drive-changes.ts backend/src/index.ts backend/src/drive.ts
git commit -m "feat(sync): resumable Drive→S3 migration and sync worker"
```

---

### Task 6: Portal reads, uploads, replace, rename, and pushes to Drive

**Files:**
- Modify: `backend/src/storage.ts` (S3 upload and read)
- Modify: `backend/src/routes/candidates.ts` (upload linking, Replace and Rename routes, download name, has-file check)
- Modify: `backend/src/sync-jobs.ts` (add `to_drive` and `rename_drive` handlers)

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces:
  - `POST /api/candidates/:id/resume` (multipart, one `file`, `candidates.edit`) → `{ ok: true }`
  - `PATCH /api/candidates/:id/resume` body `{ fileName: string }` (`candidates.edit`) → `{ ok: true }`
  - `storeResume` returns `storage: "s3"` + `resumeFileId` when S3 is configured.
  - Job payloads: `to_drive` `{ md5?: string; newFileId?: string; resolve?: boolean }`, `rename_drive` `{ name: string; resolve?: boolean }`.

- [ ] **Step 1: S3 upload and read in `storage.ts`**

Add imports: `import { prisma } from "./db.ts";` (already present), `import * as s3 from "./s3.ts";`, `import { resumeJson } from "./resume-files.ts";`, `import { digest, s3KeyFor, s3MimeFor } from "./sync-rules.ts";`, `import { HttpError } from "./http.ts";`.

At the top of `storeResume`, after `const base = …`, add:

```ts
  if (s3.s3Configured()) {
    // S3 is the primary copy: write and verify it now; the Drive copy follows via the sync queue.
    const { sha256 } = digest(input.data);
    const row = await prisma.resume_files.create({ data: { file_name: input.fileName, mime_type: mimeType, size_bytes: input.data.length } });
    try {
      const key = s3KeyFor(row.id, input.fileName, mimeType);
      const { versionId } = await s3.put(key, input.data, mimeType, sha256);
      const back = await s3.get(key, versionId);
      if (back.length !== input.data.length || digest(back).sha256 !== sha256) throw new HttpError(502, "The upload to S3 couldn't be verified — try again");
      const saved = await prisma.resume_files.update({ where: { id: row.id }, data: { s3_key: key, s3_version_id: versionId, sha256 } });
      return resumeJson(saved, { uploadedAt: base.uploadedAt, uploadedById: input.uploadedById });
    } catch (e) {
      await prisma.resume_files.delete({ where: { id: row.id } }).catch(() => {});
      throw e;
    }
  }
```

At the top of `readResume`, add:

```ts
  if (resume.storage === "s3" && resume.resumeFileId) {
    const row = await prisma.resume_files.findUnique({ where: { id: resume.resumeFileId } });
    if (row?.s3_key) return { data: await s3.get(row.s3_key, row.s3_version_id ?? undefined), mimeType: s3MimeFor(row.mime_type) };
  }
```

The existing Drive/local branches below stay as the fallback for resumes not migrated yet.

- [ ] **Step 2: Candidate routes**

In `backend/src/routes/candidates.ts`, add imports: `import * as google from "../google.ts";`, `import { renameInS3, syncCandidateResume } from "../resume-files.ts";`, `import * as s3 from "../s3.ts";`, `import { enqueue } from "../sync-queue.ts";`, `import { ChecksumMismatch, digest, safeKeyName } from "../sync-rules.ts";`, `import { mimeFor } from "../storage.ts";` (extend the existing storage import), and `enqueueParse` from `../pipeline.ts` (extend the existing pipeline import).

In `loadResume`, change the check to:

```ts
    if (!resume?.driveFileId && !resume?.resumeFileId) throw new HttpError(404, "No resume on file");
```

In the download route, replace the `const name = …` line with:

```ts
    const name = file.mimeType === "application/pdf" && !/\.pdf$/i.test(resume.fileName) ? `${resume.fileName}.pdf` : resume.fileName;
```

In `POST /api/resumes`, replace the `created.push(await createCandidate(…))` line with:

```ts
      const candidateId = await createCandidate({ resume, jobId, sourceId: source?.id ?? null, intake: "upload", actorId: user.id });
      if (resume.resumeFileId) {
        await prisma.resume_files.update({ where: { id: resume.resumeFileId }, data: { candidate_id: candidateId } });
        if (await google.isConnected()) await enqueue(resume.resumeFileId, "to_drive", { md5: digest(data).md5 });
      }
      created.push(candidateId);
```

Append the Replace and Rename routes inside the plugin:

```ts
  async function editableResume(id: string) {
    if (!isUuid(id)) throw new HttpError(404, "Not found");
    const row = await prisma.resume_files.findUnique({ where: { candidate_id: id } });
    if (!row?.s3_key) throw new HttpError(409, "This resume hasn't been copied to S3 yet — try again once the migration has finished");
    if (row.state === "conflict" || row.state === "pending_deletion") throw new HttpError(409, "This resume has a sync issue — resolve it in Settings → Resume sync first");
    return row;
  }

  app.post("/api/candidates/:id/resume", async (req) => {
    const user = requirePerm(req, "candidates.edit");
    const { id } = req.params as { id: string };
    const row = await editableResume(id);
    const part = await req.file();
    if (!part || !/\.(pdf|docx)$/i.test(part.filename)) throw new HttpError(400, "Upload a PDF or Word (.docx) file");
    const data = await part.toBuffer();
    const { sha256, md5 } = digest(data);
    const mimeType = mimeFor(part.filename);
    const key = `${row.s3_key!.split("/").slice(0, 2).join("/")}/${safeKeyName(part.filename)}`;
    const { versionId } = await s3.put(key, data, mimeType, sha256);
    const back = await s3.get(key, versionId);
    if (back.length !== data.length || digest(back).sha256 !== sha256) throw new ChecksumMismatch("S3 read-back");
    await prisma.$transaction(async (tx) => {
      const u = await tx.resume_files.update({
        where: { id: row.id },
        data: { s3_key: key, s3_version_id: versionId, sha256, size_bytes: data.length, file_name: part.filename, mime_type: mimeType, state: "pending", updated_at: new Date() },
      });
      await syncCandidateResume(tx, u);
      await tx.candidates.update({ where: { id }, data: { parse_status: "pending" } });
      await enqueue(row.id, "to_drive", { md5 }, tx);
      if (part.filename !== row.drive_name) await enqueue(row.id, "rename_drive", { name: part.filename }, tx);
    });
    if (key !== row.s3_key) await s3.remove(row.s3_key!).catch((e) => console.warn("[resume] couldn't remove old key", e));
    enqueueParse(id);
    await logActivity(user.id, "resume_upload", `replaced the resume with ${part.filename}`, id);
    return { ok: true };
  });

  app.patch("/api/candidates/:id/resume", async (req) => {
    const user = requirePerm(req, "candidates.edit");
    const { id } = req.params as { id: string };
    const { fileName } = z
      .object({ fileName: z.string().trim().min(1).max(200).refine((n) => !/[\/\\\x00-\x1f\x7f]/.test(n), "A file name can't contain / \\ or control characters") })
      .parse(req.body);
    const row = await editableResume(id);
    if (fileName === row.file_name) return { ok: true };
    await renameInS3(row, fileName);
    await enqueue(row.id, "rename_drive", { name: fileName });
    await logActivity(user.id, "resume_upload", `renamed the resume to ${fileName}`, id);
    return { ok: true };
  });
```

- [ ] **Step 3: `to_drive` and `rename_drive` handlers in `sync-jobs.ts`**

Add imports: `import { registerDriveFile } from "./resume-files.ts";` (extend the existing import), `import { driveFolderFor } from "./storage.ts";`, `import { setPayload } from "./sync-queue.ts";` (extend), `import { GOOGLE_DOC, s3NameFor } from "./sync-rules.ts";` (extend).

Add the handlers:

```ts
/** Where a resume without a Drive file goes: its candidate's job/source folder. */
async function folderForRow(row: ResumeFileRow): Promise<string> {
  const c = row.candidate_id ? await prisma.candidates.findUnique({ where: { id: row.candidate_id }, select: { job_id: true, sources: { select: { name: true } } } }) : null;
  return (await driveFolderFor(c?.job_id ?? null, c?.sources?.name)) ?? (await google.ensureRootFolder());
}

/** Creates a Drive file with a pre-generated id stored in the job, so a retry after a crash can't make a second file. */
async function createDriveFileOnce(job: JobRow, folderId: string, name: string, mimeType: string, data: Buffer): Promise<string> {
  let fileId = job.payload.newFileId as string | undefined;
  if (!fileId) {
    fileId = await google.generateFileId();
    job.payload = { ...job.payload, newFileId: fileId };
    await setPayload(job.id, job.payload);
    await registerDriveFile(fileId, name, mimeType, folderId, data.length);
  }
  const exists = await google.getFileMeta(fileId).then(() => true, (e) => (e?.status === 404 ? false : Promise.reject(e)));
  if (!exists) await google.uploadFile(folderId, name, mimeType, data, fileId);
  return fileId;
}

/** S3 → Drive. Binary files get a new revision of the same Drive file; a Google Doc gets a PDF beside it and is archived. */
async function toDrive(job: JobRow, row: ResumeFileRow) {
  if (frozen(row, job)) return complete(job.id, prisma, "skipped: needs review");
  if (!row.s3_key) throw new Error("No S3 copy yet");
  if (!(await google.isConnected())) throw new Error("Google Drive isn't connected");
  const data = await s3.get(row.s3_key, row.s3_version_id ?? undefined);
  const { md5 } = digest(data);
  if (job.payload.md5 !== md5) {
    // Lets the change feed recognise this upload as our own echo.
    job.payload = { ...job.payload, md5 };
    await setPayload(job.id, job.payload);
  }
  const mimeType = s3MimeFor(row.mime_type);
  const name = s3NameFor(row.file_name, row.mime_type);
  let fileId = row.drive_file_id;
  const current = fileId ? await google.getFileMeta(fileId) : null;
  if (fileId && current?.mimeType === GOOGLE_DOC) {
    const parent = current.parents?.[0] ?? (await google.ensureRootFolder());
    const newId = await createDriveFileOnce(job, parent, name, mimeType, data);
    await google.moveFile(fileId, await google.findOrCreateFolder("_archive", await google.ensureRootFolder()));
    fileId = newId;
  } else if (fileId) {
    await google.updateFileContent(fileId, mimeType, data);
  } else {
    fileId = await createDriveFileOnce(job, await folderForRow(row), name, mimeType, data);
  }
  const meta = await google.getFileMeta(fileId);
  if (Number(meta.size) !== data.length || meta.md5Checksum !== md5) throw new ChecksumMismatch("Drive upload");
  await prisma.$transaction(async (tx) => {
    const updated = await tx.resume_files.update({
      where: { id: row.id },
      data: {
        drive_file_id: fileId,
        drive_md5: md5,
        drive_version: meta.version ?? null,
        drive_name: meta.name,
        mime_type: meta.mimeType === GOOGLE_DOC ? row.mime_type : meta.mimeType,
        state: "synced",
        ...(job.payload.resolve ? { conflict: Prisma.DbNull } : {}),
        last_synced_at: new Date(),
        last_error: null,
        updated_at: new Date(),
      },
    });
    await syncCandidateResume(tx, updated);
    await complete(job.id, tx);
  });
}

async function renameDrive(job: JobRow, row: ResumeFileRow) {
  if (frozen(row, job)) return complete(job.id, prisma, "skipped: needs review");
  if (!row.drive_file_id) return complete(job.id, prisma, "skipped: no Drive file yet (to_drive will use the name)");
  const name = String(job.payload.name);
  await google.renameFile(row.drive_file_id, name);
  const meta = await google.getFileMeta(row.drive_file_id);
  if (meta.name !== name) throw new Error(`Drive kept the name "${meta.name}"`);
  await prisma.$transaction(async (tx) => {
    await tx.resume_files.update({
      where: { id: row.id },
      data: { drive_name: name, drive_version: meta.version ?? null, state: "synced", ...(job.payload.resolve ? { conflict: Prisma.DbNull } : {}), last_synced_at: new Date(), updated_at: new Date() },
    });
    await complete(job.id, tx);
  });
}
```

In `runJob`'s `switch`, add:

```ts
    case "to_drive":
      return toDrive(job, row);
    case "rename_drive":
      return renameDrive(job, row);
```

- [ ] **Step 4: Type-check**

Run: `cd backend && npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Verify in the app (test bucket and test Drive folder)**

1. Upload a PDF through the portal. The S3 object `resumes/<rowId>/<name>.pdf` appears at once. Within about a minute the file appears in the job's Drive folder, and the row is `synced` with `drive_md5` equal to the MD5 of the file.
2. Run **Sync now** in Settings → Integrations. The uploaded file is not imported as a second candidate.
3. Replace the resume with a different PDF. S3 gets a new version and Drive gets a new revision of the same file id. The preview shows the new file.
4. Rename the resume. The S3 key changes, the old key now has a delete marker, and the Drive name updates.

- [ ] **Step 6: Commit**

```bash
git add backend/src/storage.ts backend/src/routes/candidates.ts backend/src/sync-jobs.ts
git commit -m "feat(sync): S3-first uploads, replace/rename, push to Drive"
```

---

### Task 7: Incremental Drive change sync and conflicts

**Files:**
- Modify: `backend/src/drive-changes.ts` (full poll and `applyChange`)
- Modify: `backend/src/sync-jobs.ts` (add `rename_s3` and `stash_conflict` handlers)

**Interfaces:**
- Consumes: `decide` (Task 1); `listChanges`, `getFileMeta` (Task 4); `enqueue` (Task 3); `startDeletion`, `renameInS3` (Task 4).
- Produces:
  - `pollDriveChanges(): Promise<{ applied: number }>` (replaces the Task 5 stub)
  - The conflict JSON shape: `{ on: "content" | "name"; detectedAt: string; drive: { md5: string | null; version: string | null; name: string; stashKey?: string }; s3: { sha256: string | null; key: string | null; versionId: string | null; name: string } }`
  - Job payloads: `rename_s3` `{ name: string; resolve?: boolean }`; `stash_conflict` `{}`.

- [ ] **Step 1: Implement the poll in `drive-changes.ts`**

Replace the `pollDriveChanges` stub with the following, and add the new imports:

```ts
import { Prisma, prisma } from "./db.ts";
import { HttpError } from "./http.ts";
import { startDeletion, type ResumeFileRow } from "./resume-files.ts";
import { enqueue } from "./sync-queue.ts";
import { decide, type DriveObservation, type PortalPending, type SyncState } from "./sync-rules.ts";
import { patchSetting } from "./settings.ts"; // extend the existing settings import

/**
 * Reads ALL pages of changes before applying any, and only then advances the stored checkpoint.
 * A failure anywhere leaves the checkpoint alone, so the next run repeats the same changes (each apply is idempotent).
 */
export async function pollDriveChanges(): Promise<{ applied: number }> {
  if (!(await google.isConnected())) return { applied: 0 };
  const st = await getSetting("driveChanges");
  if (!st.pageToken) {
    await ensureChangesCheckpoint();
    return { applied: 0 };
  }
  const changes: google.DriveChange[] = [];
  let token = st.pageToken;
  let next = "";
  for (;;) {
    const page = await google.listChanges(token, st.driveId);
    changes.push(...page.changes);
    if (page.nextPageToken) token = page.nextPageToken;
    else {
      next = page.newStartPageToken ?? token;
      break;
    }
  }
  let applied = 0;
  for (const ch of changes) {
    const row = await prisma.resume_files.findUnique({ where: { drive_file_id: ch.fileId } });
    if (!row) continue;
    await applyChange(row, ch);
    applied++;
  }
  await patchSetting("driveChanges", { pageToken: next, lastSuccessAt: new Date().toISOString() });
  return { applied };
}

async function portalPending(resumeFileId: string): Promise<PortalPending> {
  const jobs = await prisma.sync_jobs.findMany({
    where: { resume_file_id: resumeFileId, kind: { in: ["to_drive", "rename_drive"] }, status: { in: ["queued", "running", "failed"] } },
    orderBy: { created_at: "desc" },
  });
  const content = jobs.find((j) => j.kind === "to_drive");
  const rename = jobs.find((j) => j.kind === "rename_drive");
  return {
    contentQueued: !!content,
    contentMd5: ((content?.payload as { md5?: string } | undefined)?.md5) ?? null,
    renameTo: ((rename?.payload as { name?: string } | undefined)?.name) ?? null,
  };
}

async function flagConflict(row: ResumeFileRow, obs: DriveObservation, on: "content" | "name") {
  const now = new Date();
  await prisma.$transaction([
    prisma.resume_files.update({
      where: { id: row.id },
      data: {
        state: "conflict",
        conflict: {
          on,
          detectedAt: now.toISOString(),
          drive: { md5: obs.md5, version: obs.version, name: obs.name },
          s3: { sha256: row.sha256, key: row.s3_key, versionId: row.s3_version_id, name: row.file_name },
        } as Prisma.InputJsonValue,
        updated_at: now,
      },
    }),
    // Stop pushing the portal version over Drive until an Admin decides.
    prisma.sync_jobs.updateMany({
      where: { resume_file_id: row.id, kind: { in: ["to_drive", "rename_drive"] }, status: { in: ["queued", "failed"] } },
      data: { status: "done", last_error: "cancelled: conflict", finished_at: now },
    }),
  ]);
  // Keep a permanent copy of the Drive side in S3, so neither version depends on Drive's revision retention.
  if (on === "content") await enqueue(row.id, "stash_conflict");
}

export async function applyChange(row: ResumeFileRow, ch: google.DriveChange) {
  const f = ch.file;
  const obs: DriveObservation = {
    removed: ch.removed || !f,
    trashed: !!f?.trashed,
    md5: f?.md5Checksum ?? null,
    version: f?.version ?? null,
    name: f?.name ?? "",
    mimeType: f?.mimeType ?? row.mime_type,
  };
  const decisions = decide(
    { state: row.state as SyncState, deletedSide: row.deleted_side },
    { driveMd5: row.drive_md5, driveVersion: row.drive_version, driveName: row.drive_name },
    obs,
    await portalPending(row.id),
  );
  for (const d of decisions) {
    if (d.do === "copy_to_s3") await enqueue(row.id, "to_s3");
    else if (d.do === "rename_s3") await enqueue(row.id, "rename_s3", { name: d.name });
    else if (d.do === "conflict") await flagConflict(row, obs, d.on);
    else if (d.do === "start_deletion") await startDeletion(row.id, "drive");
    else if (d.do === "cancel_deletion")
      await prisma.resume_files.update({ where: { id: row.id }, data: { state: "synced", delete_after: null, deleted_side: null, updated_at: new Date() } });
    else if (d.do === "check_removed") {
      try {
        await google.getFileMeta(row.drive_file_id!);
        await prisma.resume_files.update({
          where: { id: row.id },
          data: { state: "failed", last_error: "Lost access to the Drive file (it exists but the connected account can't see it)", updated_at: new Date() },
        });
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) await startDeletion(row.id, "drive");
        else throw e;
      }
    }
  }
}
```

- [ ] **Step 2: `rename_s3` and `stash_conflict` handlers in `sync-jobs.ts`**

Add `renameInS3` to the `./resume-files.ts` import and `safeKeyName` to the `./sync-rules.ts` import, then add:

```ts
/** Drive renamed the file: move the S3 object to the new name (baseline name = the Drive name). */
async function renameS3(job: JobRow, row: ResumeFileRow) {
  if (frozen(row, job)) return complete(job.id, prisma, "skipped: needs review");
  const name = String(job.payload.name);
  await renameInS3(row, name, { drive_name: name });
  if (job.payload.resolve) {
    await prisma.resume_files.update({ where: { id: row.id }, data: { state: "synced", conflict: Prisma.DbNull, updated_at: new Date() } });
  }
  await complete(job.id);
}

/** Copies the Drive side of a content conflict into S3 under conflicts/, so both versions survive any resolution. */
async function stashConflict(job: JobRow, row: ResumeFileRow) {
  const conflict = row.conflict as { drive?: { stashKey?: string; name?: string } } | null;
  if (row.state !== "conflict" || !row.drive_file_id || conflict?.drive?.stashKey) return complete(job.id, prisma, "skipped");
  const meta = await google.getFileMeta(row.drive_file_id);
  const { data } = await google.downloadFile(row.drive_file_id, meta.mimeType);
  const { sha256 } = digest(data);
  const key = `conflicts/${row.id}/${Date.now()}-${safeKeyName(s3NameFor(meta.name, meta.mimeType))}`;
  await putVerified(key, data, s3MimeFor(meta.mimeType), sha256);
  await prisma.$transaction(async (tx) => {
    const fresh = await tx.resume_files.findUniqueOrThrow({ where: { id: row.id } });
    const c = (fresh.conflict ?? {}) as Record<string, any>;
    await tx.resume_files.update({ where: { id: row.id }, data: { conflict: { ...c, drive: { ...c.drive, stashKey: key } } as Prisma.InputJsonValue } });
    await complete(job.id, tx);
  });
}
```

In `runJob`'s `switch`, add:

```ts
    case "rename_s3":
      return renameS3(job, row);
    case "stash_conflict":
      return stashConflict(job, row);
```

- [ ] **Step 3: Type-check and run the check script**

Run: `cd backend && npm run typecheck && npm run check:sync`
Expected: no errors; all assertions pass.

- [ ] **Step 4: Verify against the test Drive folder** (set `DRIVE_SYNC_MINUTES=1` in `backend/.env` for this)

1. Edit a migrated PDF in Drive (upload a new version). Within about 2 minutes S3 has a new version, the row is `synced`, and `drive_md5` matches.
2. Rename it in Drive. The S3 key moves and no new `resume_files` row appears.
3. Stop the backend. Replace the resume in the portal, which leaves a `to_drive` job queued. Then upload a different version in Drive. Start the backend. The row becomes `conflict`, a `conflicts/<rowId>/…` object appears in S3, and the queued `to_drive` job is `done` with "cancelled: conflict".
4. Kill the backend in the middle of a poll (add a temporary `await new Promise(r => setTimeout(r, 30_000))` before `patchSetting` in `pollDriveChanges`). After a restart, the same change is applied again with no duplicate jobs or rows. Remove the delay afterwards.

- [ ] **Step 5: Commit**

```bash
git add backend/src/drive-changes.ts backend/src/sync-jobs.ts
git commit -m "feat(sync): incremental Drive change sync with baseline conflicts"
```

---

### Task 8: Deletions with the grace period

**Files:**
- Modify: `backend/src/routes/candidates.ts` (candidate delete starts the countdown)
- Modify: `backend/src/sync-jobs.ts` (`purge` handler and `enqueueDuePurges`)
- Modify: `frontend/src/pages/CandidateDetail.tsx`, `frontend/src/pages/Candidates.tsx` (confirm text)

**Interfaces:**
- Consumes: `graceDate` (Task 4), `enqueue` (Task 3), `config.resumeDeleteGraceDays` (Task 2).
- Produces: the `purge` job (payload `{}`), plus `enqueueDuePurges()` called hourly by `syncTick`.

- [ ] **Step 1: Candidate delete starts the countdown**

In `POST /api/candidates/delete`, before the `deleteMany`, add the following (and import `graceDate` from `../resume-files.ts` and `config` from `../config.ts`):

```ts
    // Their resumes stay in S3 and Drive for the grace period; an Admin can restore them from Settings → Resume sync.
    await prisma.resume_files.updateMany({
      where: { candidate_id: { in: ids }, state: { not: "deleted" } },
      data: { state: "pending_deletion", deleted_side: "portal", delete_after: graceDate(), updated_at: new Date() },
    });
```

Change the activity message to `` `deleted ${count} candidate${count === 1 ? "" : "s"} (resumes kept ${config.resumeDeleteGraceDays} days)` ``.

In `frontend/src/pages/CandidateDetail.tsx:137`, change the confirm text to `` `Delete ${fullName(c)}? Their resume is kept for 30 days and can be restored by an Admin.` ``. In `frontend/src/pages/Candidates.tsx:205`, change it to `` `Delete ${selected.length} candidates? Their resumes are kept for 30 days and can be restored by an Admin.` ``.

- [ ] **Step 2: Purge handler**

In `sync-jobs.ts`, replace the `enqueueDuePurges` placeholder with:

```ts
async function enqueueDuePurges() {
  const due = await prisma.resume_files.findMany({ where: { state: "pending_deletion", delete_after: { lte: new Date() } }, select: { id: true } });
  for (const r of due) await enqueue(r.id, "purge");
}

/** End of the grace period: the only automatic deletion. S3 keeps a noncurrent version; Drive keeps the file in trash. */
async function purge(job: JobRow, row: ResumeFileRow) {
  if (row.state !== "pending_deletion" || !row.delete_after || row.delete_after > new Date()) return complete(job.id, prisma, "skipped: restored or not due");
  if (row.s3_key) await s3.remove(row.s3_key);
  if (row.deleted_side === "portal" && row.drive_file_id && (await google.isConnected())) {
    await google.setTrashed(row.drive_file_id, true).catch((e) => {
      if (e?.status !== 404) throw e;
    });
  }
  await prisma.$transaction(async (tx) => {
    await tx.resume_files.update({ where: { id: row.id }, data: { state: "deleted", updated_at: new Date() } });
    await complete(job.id, tx);
  });
}
```

Add `case "purge": return purge(job, row);` to `runJob`.

- [ ] **Step 3: Type-check**

Run: `cd backend && npm run typecheck && cd ../frontend && npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 4: Verify**

1. Trash a synced resume in Drive. After the next poll the row is `pending_deletion` with `deleted_side = drive` and `delete_after` 30 days out, and S3 is untouched.
2. Restore it from Drive's trash. After the next poll the row is `synced` again.
3. Delete a candidate in the portal. Its row is `pending_deletion` with `deleted_side = portal`. Set its `delete_after` to the past with SQL and set `lastPurgeScan` aside by restarting the backend. After a tick, the S3 key has a delete marker, the Drive file is in the trash, and the row is `deleted`.
4. Delete a file from the folder only (move it out of the scanned folders). Nothing is marked for deletion.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/candidates.ts backend/src/sync-jobs.ts frontend/src/pages/CandidateDetail.tsx frontend/src/pages/Candidates.tsx
git commit -m "feat(sync): soft-delete with grace period and purge"
```

---

### Task 9: Admin API, dashboard, and candidate-page controls

**Files:**
- Create: `backend/src/routes/sync.ts`
- Modify: `backend/src/index.ts` (register routes), `backend/src/routes/bootstrap.ts`, `backend/src/serialize.ts`
- Create: `frontend/src/pages/ResumeSync.tsx`
- Modify: `frontend/src/pages/Settings.tsx`, `frontend/src/components/candidate.tsx`, `frontend/src/data/store.ts`

**Interfaces:**
- Consumes: `retryRow`, `enqueue` (Task 3); `startMigration`, `startDeletion` (Tasks 4–5); conflict JSON (Task 7).
- Produces:
  - `GET /api/sync/status` → `{ s3Configured: boolean; total: number; counts: Record<SyncStateName, number>; queuedJobs: number; review: number; migration: { verified: number; total: number; startedAt: string }; lastDriveSyncAt: string; lastJobAt: string | null }`
  - `GET /api/sync/items?state=conflict|failed|pending_deletion|review` → `SyncItem[]` where `SyncItem = { id; candidateId: string | null; candidateName: string; fileName: string; state: SyncStateName; lastError: string | null; conflict: unknown; deleteAfter: string | null; deletedSide: string | null; reviewReason: string | null; updatedAt: string }`
  - `POST /api/sync/items/:id/{retry|keep-portal|keep-drive|restore|delete-now|reviewed}`, `POST /api/sync/retry-failed`, `POST /api/sync/migrate`
  - Store actions `replaceResume(candidateId: string, file: File): Promise<boolean>`, `renameResume(candidateId: string, fileName: string): Promise<boolean>`

- [ ] **Step 1: `backend/src/routes/sync.ts`**

```ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { logActivity } from "../activity.ts";
import { prisma } from "../db.ts";
import * as google from "../google.ts";
import { HttpError, isUuid, requirePerm } from "../http.ts";
import { startMigration } from "../resume-files.ts";
import { s3Configured } from "../s3.ts";
import { getSetting } from "../settings.ts";
import { enqueue, retryRow } from "../sync-queue.ts";

const STATES = ["pending", "synced", "conflict", "failed", "pending_deletion", "deleted"] as const;

export default async function syncRoutes(app: FastifyInstance) {
  app.get("/api/sync/status", async (req) => {
    requirePerm(req, "storage.manage");
    const [byState, queuedJobs, review, lastJob, [mig], changes, migration] = await Promise.all([
      prisma.resume_files.groupBy({ by: ["state"], _count: { _all: true } }),
      prisma.sync_jobs.count({ where: { status: { in: ["queued", "running"] } } }),
      prisma.resume_files.count({ where: { review_reason: { not: null } } }),
      prisma.sync_jobs.findFirst({ where: { status: "done" }, orderBy: { finished_at: "desc" }, select: { finished_at: true } }),
      prisma.$queryRaw<{ total: number; verified: number }[]>`
        select count(*)::int as total, count(*) filter (where resume->>'storage' = 's3')::int as verified
        from candidates where coalesce(resume->>'driveFileId', '') <> '' or resume->>'resumeFileId' is not null`,
      getSetting("driveChanges"),
      getSetting("migration"),
    ]);
    const counts = Object.fromEntries(STATES.map((s) => [s, byState.find((b) => b.state === s)?._count._all ?? 0]));
    return {
      s3Configured: s3Configured(),
      total: byState.reduce((n, b) => n + b._count._all, 0),
      counts,
      queuedJobs,
      review,
      migration: { verified: mig?.verified ?? 0, total: mig?.total ?? 0, startedAt: migration.startedAt },
      lastDriveSyncAt: changes.lastSuccessAt,
      lastJobAt: lastJob?.finished_at?.toISOString() ?? null,
    };
  });

  app.get("/api/sync/items", async (req) => {
    requirePerm(req, "storage.manage");
    const { state } = z.object({ state: z.enum(["conflict", "failed", "pending_deletion", "review"]) }).parse(req.query);
    const rows = await prisma.resume_files.findMany({
      where: state === "review" ? { review_reason: { not: null } } : { state },
      orderBy: { updated_at: "desc" },
      take: 200,
      include: { candidates: { select: { first_name: true, last_name: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      candidateId: r.candidate_id,
      candidateName: r.candidates ? `${r.candidates.first_name} ${r.candidates.last_name}`.trim() : "(candidate deleted)",
      fileName: r.file_name,
      state: r.state,
      lastError: r.last_error,
      conflict: r.conflict,
      deleteAfter: r.delete_after?.toISOString() ?? null,
      deletedSide: r.deleted_side,
      reviewReason: r.review_reason,
      updatedAt: r.updated_at.toISOString(),
    }));
  });

  const rowFor = async (id: string) => {
    const row = isUuid(id) ? await prisma.resume_files.findUnique({ where: { id } }) : null;
    if (!row) throw new HttpError(404, "Not found");
    return row;
  };

  app.post("/api/sync/items/:id/:action", async (req) => {
    const user = requirePerm(req, "storage.manage");
    const { id, action } = z.object({ id: z.string(), action: z.enum(["retry", "keep-portal", "keep-drive", "restore", "delete-now", "reviewed"]) }).parse(req.params);
    const row = await rowFor(id);
    const conflict = row.conflict as { on?: "content" | "name"; drive?: { name?: string } } | null;
    switch (action) {
      case "retry":
        await retryRow(row.id);
        break;
      case "keep-portal":
      case "keep-drive": {
        if (row.state !== "conflict" || !conflict?.on) throw new HttpError(409, "This resume has no conflict");
        const portal = action === "keep-portal";
        if (conflict.on === "content") await enqueue(row.id, portal ? "to_drive" : "to_s3", { resolve: true });
        else await enqueue(row.id, portal ? "rename_drive" : "rename_s3", { name: portal ? row.file_name : conflict.drive?.name, resolve: true });
        await logActivity(user.id, "settings_changed", `resolved a resume conflict for ${row.file_name} (kept the ${portal ? "portal" : "Drive"} version)`);
        break;
      }
      case "restore":
        if (row.state !== "pending_deletion") throw new HttpError(409, "This resume isn't pending deletion");
        if (row.deleted_side === "drive") {
          try {
            await google.setTrashed(row.drive_file_id!, false);
            await prisma.resume_files.update({ where: { id: row.id }, data: { state: "synced", delete_after: null, deleted_side: null, updated_at: new Date() } });
          } catch (e) {
            if (!(e instanceof HttpError && e.status === 404)) throw e;
            // Gone from Drive for good: put the S3 copy back as a new Drive file.
            await prisma.resume_files.update({
              where: { id: row.id },
              data: { drive_file_id: null, drive_md5: null, drive_version: null, drive_name: null, state: "pending", delete_after: null, deleted_side: null, updated_at: new Date() },
            });
            await enqueue(row.id, "to_drive");
          }
        } else {
          if (!row.drive_file_id) throw new HttpError(409, "This resume never reached Drive, so it can't go back to the Drive inbox");
          // The candidate is gone: the file returns to the Drive inbox, where importing it creates a new candidate.
          await prisma.$transaction([
            prisma.drive_files.updateMany({ where: { drive_file_id: row.drive_file_id }, data: { status: "inbox", candidate_id: null } }),
            prisma.resume_files.update({ where: { id: row.id }, data: { state: "synced", delete_after: null, deleted_side: null, updated_at: new Date() } }),
          ]);
        }
        await logActivity(user.id, "settings_changed", `restored the resume ${row.file_name}`);
        break;
      case "delete-now":
        if (row.state !== "pending_deletion") throw new HttpError(409, "Only resumes pending deletion can be deleted now");
        await prisma.resume_files.update({ where: { id: row.id }, data: { delete_after: new Date(), updated_at: new Date() } });
        await enqueue(row.id, "purge");
        await logActivity(user.id, "settings_changed", `deleted the resume ${row.file_name} now`);
        break;
      case "reviewed":
        await prisma.resume_files.update({ where: { id: row.id }, data: { review_reason: null, updated_at: new Date() } });
        break;
    }
    return { ok: true };
  });

  app.post("/api/sync/retry-failed", async (req) => {
    requirePerm(req, "storage.manage");
    const rows = await prisma.resume_files.findMany({ where: { state: "failed" }, select: { id: true } });
    for (const r of rows) await retryRow(r.id);
    return { retried: rows.length };
  });

  app.post("/api/sync/migrate", async (req) => {
    const user = requirePerm(req, "storage.manage");
    if (!s3Configured()) throw new HttpError(409, "S3 isn't configured — set AWS_REGION, S3_BUCKET and the access keys first");
    const result = await startMigration();
    await logActivity(user.id, "settings_changed", `started the resume migration to S3 (${result.queued} queued)`);
    return result;
  });
}
```

Register it in `backend/src/index.ts`: `import syncRoutes from "./routes/sync.ts";` and `await app.register(syncRoutes);` after `sourceRoutes`.

- [ ] **Step 2: Sync state in the bootstrap data**

In `backend/src/routes/bootstrap.ts`, in the `prisma.candidates.findMany({ … })` call add `include: { resume_files: { select: { state: true } } },`.

In `backend/src/serialize.ts:96`, replace `resume: c.resume ?? {` with `resume: c.resume ? { ...c.resume, syncState: c.resume_files?.state } : {` (the default object after it stays as it is).

- [ ] **Step 3: Store actions**

In `frontend/src/data/store.ts`, add to the store interface after `uploadResumes`:

```ts
  replaceResume: (candidateId: string, file: File) => Promise<boolean>;
  renameResume: (candidateId: string, fileName: string) => Promise<boolean>;
```

and to the implementation after `uploadResumes`:

```ts
    replaceResume: (candidateId, file) => {
      const form = new FormData();
      form.append("file", file);
      return ok("Couldn't replace the resume", () => api.post(`/api/candidates/${candidateId}/resume`, form));
    },
    renameResume: (candidateId, fileName) => ok("Couldn't rename the resume", () => api.patch(`/api/candidates/${candidateId}/resume`, { fileName })),
```

- [ ] **Step 4: Candidate-page controls (`frontend/src/components/candidate.tsx`)**

Change `resumeUrl` to bust the cache when the S3 version changes:

```ts
export const resumeUrl = (candidateId: string, kind: "preview" | "download", version?: string) =>
  `/api/candidates/${candidateId}/resume/${kind}${version ? `?v=${encodeURIComponent(version)}` : ""}`;
```

Pass `candidate.resume.version` as the third argument at all three `resumeUrl(candidate.id, …)` calls in `ResumePreview`.

In `ResumePreview`:
- Change `const hasFile = !!candidate.resume.driveFileId;` to `const hasFile = !!(candidate.resume.driveFileId || candidate.resume.resumeFileId);`.
- Change the Drive link condition `candidate.resume.storage === "drive" && candidate.resume.driveUrl` to `candidate.resume.driveUrl`.
- Add after the `useState` lines:

```tsx
  const canEdit = useCan("candidates.edit");
  const replaceResume = useStore((s) => s.replaceResume);
  const renameResume = useStore((s) => s.renameResume);
  const toast = useStore((s) => s.toast);
  const fileInput = useRef<HTMLInputElement>(null);
  const sync = candidate.resume.syncState;
  const editable = canEdit && candidate.resume.storage === "s3" && sync !== "conflict" && sync !== "pending_deletion";
```

- After the file-name `<span>`, add:

```tsx
        {(sync === "conflict" || sync === "failed" || sync === "pending_deletion") && (
          <Badge tone={sync === "failed" ? "danger" : "warn"}>{sync === "conflict" ? "sync conflict" : sync === "failed" ? "sync failed" : "pending deletion"}</Badge>
        )}
        {editable && (
          <>
            <input
              ref={fileInput}
              type="file"
              accept=".pdf,.docx"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f && (await replaceResume(candidate.id, f))) toast("Resume replaced");
              }}
            />
            <button onClick={() => fileInput.current?.click()} className="h-7 rounded-md px-2 text-[12px] font-semibold text-ink-2 hover:bg-sunken" title="Replace with a new file">
              Replace
            </button>
            <button
              onClick={async () => {
                const name = window.prompt("Rename resume", candidate.resume.fileName)?.trim();
                if (name && name !== candidate.resume.fileName && (await renameResume(candidate.id, name))) toast("Resume renamed");
              }}
              className="h-7 rounded-md px-2 text-[12px] font-semibold text-ink-2 hover:bg-sunken"
            >
              Rename
            </button>
          </>
        )}
```

- Add `useRef` to the `react` import.

- [ ] **Step 5: Dashboard page `frontend/src/pages/ResumeSync.tsx`**

```tsx
import { AlertTriangle, CheckCircle2, Clock, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Tabs } from "../components/ui";
import { useStore } from "../data/store";
import { api, errorMessage } from "../lib/api";
import { timeAgo } from "../lib/utils";
import type { SyncStateName } from "../types";

interface SyncStatus {
  s3Configured: boolean;
  total: number;
  counts: Record<SyncStateName, number>;
  queuedJobs: number;
  review: number;
  migration: { verified: number; total: number; startedAt: string };
  lastDriveSyncAt: string;
  lastJobAt: string | null;
}

interface SyncItem {
  id: string;
  candidateId: string | null;
  candidateName: string;
  fileName: string;
  state: SyncStateName;
  lastError: string | null;
  conflict: { on?: "content" | "name"; drive?: { name?: string }; s3?: { name?: string } } | null;
  deleteAfter: string | null;
  deletedSide: "drive" | "portal" | null;
  reviewReason: string | null;
  updatedAt: string;
}

type ListTab = "conflict" | "failed" | "pending_deletion" | "review";

export default function ResumeSync() {
  const toast = useStore((s) => s.toast);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [tab, setTab] = useState<ListTab>("conflict");
  const [items, setItems] = useState<SyncItem[]>([]);
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const [s, list] = await Promise.all([api.get<SyncStatus>("/api/sync/status"), api.get<SyncItem[]>(`/api/sync/items?state=${tab}`)]);
      setStatus(s);
      setItems(list);
    } catch (e) {
      toast(`Couldn't load sync status: ${errorMessage(e)}`, "error");
    }
  }, [tab, toast]);

  useEffect(() => {
    void load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (key: string, url: string, done: string) => {
    setBusy(key);
    try {
      await api.post(url);
      toast(done);
      await load();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy("");
    }
  };

  if (!status) return <p className="text-sm text-muted">Loading…</p>;
  if (!status.s3Configured)
    return <p className="text-sm text-muted">S3 isn't configured. Set AWS_REGION, S3_BUCKET, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY on the server (see DEPLOY.md), then restart it.</p>;

  const tiles: [string, number | string][] = [
    ["Total resumes", status.total],
    ["Synchronized", status.counts.synced],
    ["Pending operations", status.queuedJobs],
    ["Conflicts", status.counts.conflict],
    ["Failures", status.counts.failed],
    ["Pending deletion", status.counts.pending_deletion],
    ["Migrated to S3", `${status.migration.verified} of ${status.migration.total}`],
    ["Last Drive sync", status.lastDriveSyncAt ? timeAgo(status.lastDriveSyncAt) : "never"],
  ];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {tiles.map(([label, value]) => (
          <div key={label} className="card p-3">
            <p className="text-xs text-muted">{label}</p>
            <p className="mt-1 text-lg font-semibold">{value}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button icon={<RefreshCw size={14} />} disabled={!!busy} onClick={() => act("migrate", "/api/sync/migrate", "Migration queued")}>
          {status.migration.startedAt ? "Re-run migration" : "Start migration"}
        </Button>
        <Button disabled={!!busy || !status.counts.failed} onClick={() => act("retry-all", "/api/sync/retry-failed", "Failed items re-queued")}>
          Retry all failed
        </Button>
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "conflict", label: "Conflicts", count: status.counts.conflict },
          { value: "failed", label: "Failures", count: status.counts.failed },
          { value: "pending_deletion", label: "Pending deletion", count: status.counts.pending_deletion },
          { value: "review", label: "Needs review", count: status.review },
        ]}
      />

      {items.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">
          <CheckCircle2 size={16} className="mr-1 inline" /> Nothing here
        </p>
      ) : (
        <ul className="card divide-y divide-line">
          {items.map((it) => (
            <li key={it.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
              <div className="min-w-[200px] flex-1">
                <p className="text-sm font-semibold">{it.fileName}</p>
                <p className="text-xs text-muted">
                  {it.candidateName} · updated {timeAgo(it.updatedAt)}
                </p>
                {it.state === "conflict" && it.conflict?.on === "name" && (
                  <p className="mt-1 text-xs text-ink-2">
                    Portal name “{it.conflict.s3?.name}” vs Drive name “{it.conflict.drive?.name}”
                  </p>
                )}
                {it.state === "conflict" && it.conflict?.on === "content" && <p className="mt-1 text-xs text-ink-2">Changed in both the portal and Drive. Both versions are kept.</p>}
                {it.lastError && (
                  <p className="mt-1 text-xs text-danger">
                    <AlertTriangle size={12} className="mr-1 inline" />
                    {it.lastError}
                  </p>
                )}
                {it.deleteAfter && (
                  <p className="mt-1 text-xs text-ink-2">
                    <Clock size={12} className="mr-1 inline" />
                    Deleted {it.deletedSide === "drive" ? "in Drive" : "in the portal"} · removed {new Date(it.deleteAfter).toLocaleDateString()}
                  </p>
                )}
                {it.reviewReason === "missing_filename" && <p className="mt-1 text-xs text-ink-2">Drive gave no filename, so a fallback name was used.</p>}
              </div>
              {it.state === "conflict" && (
                <>
                  <Button size="sm" disabled={!!busy} onClick={() => act(it.id, `/api/sync/items/${it.id}/keep-portal`, "Keeping the portal version")}>
                    Keep portal
                  </Button>
                  <Button size="sm" disabled={!!busy} onClick={() => act(it.id, `/api/sync/items/${it.id}/keep-drive`, "Keeping the Drive version")}>
                    Keep Drive
                  </Button>
                </>
              )}
              {it.state === "failed" && tab === "failed" && (
                <Button size="sm" disabled={!!busy} onClick={() => act(it.id, `/api/sync/items/${it.id}/retry`, "Re-queued")}>
                  Retry
                </Button>
              )}
              {tab === "pending_deletion" && (
                <>
                  <Button size="sm" disabled={!!busy} onClick={() => act(it.id, `/api/sync/items/${it.id}/restore`, "Restored")}>
                    Restore
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    icon={<Trash2 size={13} />}
                    disabled={!!busy}
                    onClick={() => confirm(`Delete ${it.fileName} from S3 and Drive now?`) && act(it.id, `/api/sync/items/${it.id}/delete-now`, "Deleting")}
                  >
                    Delete now
                  </Button>
                </>
              )}
              {tab === "review" && (
                <Button size="sm" disabled={!!busy} onClick={() => act(it.id, `/api/sync/items/${it.id}/reviewed`, "Marked reviewed")}>
                  Mark reviewed
                </Button>
              )}
              <Badge tone={it.state === "failed" ? "danger" : it.state === "synced" ? "brand" : "warn"}>{it.state.replace("_", " ")}</Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Settings tab**

In `frontend/src/pages/Settings.tsx`:
- Add `| "sync"` to `SettingsTab`.
- Add `import ResumeSync from "./ResumeSync";`.
- Add `const canSync = useCan("storage.manage");` next to `superAdmin`.
- In the `tabs` array, add `...(canSync ? [{ value: "sync" as const, label: "Resume sync" }] : []),` before the audit-log entry.
- Add `{tab === "sync" && <ResumeSync />}` next to the other tab bodies.

- [ ] **Step 7: Type-check and build**

Run: `cd backend && npm run typecheck && cd ../frontend && npx tsc --noEmit -p . && npm run build`
Expected: no errors; build succeeds.

- [ ] **Step 8: Verify in the browser**

- An Admin and a Super Admin see Settings → Resume sync; a Recruiter does not, and `GET /api/sync/status` returns 403 for them.
- The tiles match the database. Keep portal / Keep Drive resolve a conflict from Task 7, and the row returns to `synced` within a minute. Retry, Restore, Delete now and Mark reviewed each behave as described.
- On a candidate, Replace and then the preview shows the new file immediately (its URL has a new `?v=`). Rename updates the name in the header and the download filename.

- [ ] **Step 9: Commit**

```bash
git add backend/src/routes/sync.ts backend/src/index.ts backend/src/routes/bootstrap.ts backend/src/serialize.ts frontend/src
git commit -m "feat(sync): resume sync dashboard and candidate replace/rename"
```

---

### Task 10: Deployment docs and the manual runbook

**Files:**
- Modify: `DEPLOY.md`
- Create: `docs/superpowers/plans/2026-10-15-s3-drive-resume-sync-runbook.md`

- [ ] **Step 1: DEPLOY.md: add an "Amazon S3 (resume storage)" section**

```markdown
## Amazon S3 (resume storage)

Resumes are stored in S3 and kept in sync with Google Drive. Skip this section to keep resumes in Drive only.

1. Create a **private** bucket in your region. Block all public access.
2. **Turn on Versioning** (Bucket → Properties → Bucket Versioning → Enable). The app refuses to store files without it.
3. Add a lifecycle rule: *Permanently delete noncurrent versions* after 90 days (or your retention period).
4. Create an IAM user with this policy (replace `YOUR-BUCKET`) and an access key:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Effect": "Allow", "Action": ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject", "s3:DeleteObject"], "Resource": "arn:aws:s3:::YOUR-BUCKET/*" },
       { "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": "arn:aws:s3:::YOUR-BUCKET" }
     ]
   }
   ```

5. Set `AWS_REGION`, `S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (and optionally `RESUME_DELETE_GRACE_DAYS`) and restart.
6. In **Settings → Resume sync**, click **Start migration**. Watch *Migrated to S3* reach *N of N*. Drive files are not changed.
   Re-running the migration is safe. Keep the Drive originals until the dashboard shows every resume migrated and no failures.
```

- [ ] **Step 2: Write the runbook**

Create `docs/superpowers/plans/2026-10-15-s3-drive-resume-sync-runbook.md` listing each scenario, its steps and the expected result:

1. **Interrupted migration:** start the migration with 50+ resumes and kill the backend after about 10 jobs. Restart and re-run the migration. Expected: every row ends `synced`, the `resume_files` count equals the candidates with resumes, and there are no duplicate keys in S3.
2. **Duplicate change events:** repeat a poll by resetting `driveChanges.pageToken` to the previous value with SQL. Expected: no new jobs beyond merges, and no new rows.
3. **Simultaneous edit:** the Task 7 Step 4.3 procedure. Expected: a conflict, both versions retrievable (the S3 version id and the `conflicts/` object), and either resolution works.
4. **Crash after Drive upload:** add a temporary `throw new Error("crash")` right after `createDriveFileOnce` in `toDrive`, upload a resume, wait for one failure, remove the throw. Expected: the retry completes, and there is exactly one Drive file with the pre-generated id.
5. **Rename before copy:** queue a migration, stop the worker before it runs (`S3_BUCKET` empty), rename the file in Drive, restore the env and restart. Expected: the S3 object is created under the new name, with one row.
6. **Trash/untrash, removed (404 vs lost access), purge, restore (both sides):** as in Task 8 Step 4, plus share-revoke a file for "lost access", which should show `failed` and no countdown.
7. **Failed-job recovery:** set a wrong `AWS_SECRET_ACCESS_KEY`, upload a resume, and see it in Failures. Fix the key, click Retry, and it becomes `synced`.
8. **Preview cache after Replace:** the preview shows the new file without a hard refresh.
9. **Missing filename:** with SQL, set a `drive_files.file_name` to `''` before import. Expected: the name is `resume_<id>.pdf` and it appears under Needs review.

- [ ] **Step 3: Run the runbook end to end against the test bucket and Drive folder, and record pass/fail next to each scenario.**

- [ ] **Step 4: Commit**

```bash
git add DEPLOY.md docs/superpowers/plans/2026-10-15-s3-drive-resume-sync-runbook.md
git commit -m "docs: S3 setup and resume-sync runbook"
```
