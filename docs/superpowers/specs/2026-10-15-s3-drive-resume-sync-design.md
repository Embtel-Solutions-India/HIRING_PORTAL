# Resume storage: S3 primary, Google Drive synced — design

Date: 2026-10-15 · Status: draft for review

## Goal

Move every resume into Amazon S3 and make S3 the copy the Hiring Portal reads and writes. Keep Google Drive as a
synchronized secondary copy: adds, edits and renames on either side reach the other side, without loops, duplicates or
silent overwrites. Admins can see and fix the sync state.

## Decisions (agreed)

| Area | Decision |
|---|---|
| Who writes to S3 | Only the portal. S3 is never watched; every S3 change originates in our code. |
| Portal edits | New: **Replace resume** and **Rename resume** on the candidate page (`candidates.edit`). |
| Drive change detection | Drive **Changes API**, polled on the existing `DRIVE_SYNC_MINUTES` timer. No webhooks. |
| New-resume intake from Drive | Existing folder scan (`drive.ts`) unchanged; it creates candidates, then the file is queued for S3. |
| Conflicts | Compare each side to its **last-synced baseline**, never timestamps. Both changed → keep both, flag `conflict`, Admin picks. |
| Deletions | Only an explicit change-feed signal (trashed / confirmed removed) or a portal candidate delete starts a **30-day** countdown (`RESUME_DELETE_GRACE_DAYS`). A file missing from a folder scan never does. |
| Checksums | SHA-256 computed by us for every stored object (persisted). Drive `md5Checksum` compared against an MD5 we compute over the same bytes. S3 ETag is never treated as a checksum. |
| Bucket | Private bucket, **Versioning on**. Keys under `resumes/`. Credentials via env. |
| Google Docs resumes | Stay Docs in Drive; S3 holds a PDF export. Replacing one from the portal uploads a new file to Drive and moves the Doc to an `_archive` folder. |
| Downloads | S3 first; Drive fallback only while the resume has no verified S3 copy. |
| Migration | Resumable, idempotent; Drive originals untouched; candidate switched to S3 only after verification. |

## Data model (migration `004_resume_sync`)

### `resume_files` — one row per resume

| Column | Notes |
|---|---|
| `id uuid pk` | Internal row id. |
| `candidate_id uuid null` → candidates, `ON DELETE SET NULL` | **unique** (one current resume per candidate). Null after candidate delete. |
| `file_name`, `mime_type`, `size_bytes` | `file_name` is the **exact** original filename (Drive name, or the uploaded name), unmodified. |
| `s3_key text null` **unique** | `resumes/{sourceId}/{keyName}`. See *S3 object keys*. |
| `review_reason text null` | Set when a person should look at the row (e.g. `missing_filename`); listed on the dashboard. |
| `sha256 text null` | Of the current S3 object. Null until uploaded. |
| `s3_version_id text null` | S3 version of the current object. |
| `drive_file_id text null` | **unique**. Stable source id; prevents duplicate rows on re-run. |
| `drive_md5 text null`, `drive_version bigint null`, `drive_name text null`, `drive_folder_id text null` | **Baseline**: Drive state as of last successful sync. `drive_version` is Drive's per-file `version` (used for Google Docs, which have no md5). |
| `local_path text null` | For resumes still on server disk (pre-migration). |
| `state text` | `pending` · `synced` · `conflict` · `failed` · `pending_deletion` · `deleted` (check constraint). |
| `conflict jsonb null` | `{ drive: {md5, version, name}, s3: {sha256, key, versionId, name}, detectedAt }`. |
| `delete_after timestamptz null`, `deleted_side text null` | `drive` or `portal`; set with `pending_deletion`. |
| `last_synced_at timestamptz null`, `last_error text null`, `created_at`, `updated_at` | |

### S3 object keys

- Format: `resumes/{sourceId}/{keyName}`, e.g. `resumes/1AbC…xyz/Ritik_Saini_Java_Developer_Resume.pdf`.
- `sourceId` = the **Drive file id** for resumes that came from Drive (migration and folder intake). For resumes created in
  the portal (S3 first, no Drive id yet) it is the row's `id`. It never changes after the object is created; the full key is
  stored in `s3_key`, so nothing ever re-derives it.
- Identity is always `drive_file_id` / `id`, never the filename — two different resumes may share a name, and the
  `sourceId` prefix keeps their keys apart.
- `keyName` = `file_name` with only what S3 keys can't safely hold replaced: `/`, `\` and control characters → `_`, trimmed
  to 200 bytes (extension kept). The exact name stays in `file_name` and is sent as the download filename
  (`Content-Disposition`), so users always see the original.
- **Missing filename**: if Drive returns an empty name, `file_name = resume_{driveFileId}` plus the extension from the mime
  type, and `review_reason = missing_filename`.
- **Rename** (from Drive or the portal): `CopyObject` to the new key under the same `sourceId` prefix, verify (size + the
  SHA-256 stored as object metadata), update `s3_key` / `s3_version_id` / `file_name` in one transaction, then delete the old
  key. Same `resume_files` row, so no duplicate record and candidate links don't change. The old key's version history
  remains in the versioned bucket.

### `sync_jobs` — durable work queue

| Column | Notes |
|---|---|
| `id uuid pk`, `resume_file_id uuid` → resume_files | |
| `kind text` | `to_s3` (copy Drive/local → S3), `to_drive` (S3 → Drive), `rename_s3`, `rename_drive`, `purge` (end of grace period). |
| `status text` | `queued` · `running` · `done` · `failed`. |
| `attempts int`, `run_after timestamptz`, `last_error text`, `created_at`, `finished_at` | |
| partial unique index on `(resume_file_id, kind) where status in ('queued','running')` | Duplicate enqueues collapse into one job. |

### `settings` additions (existing key/value table)

`drive_changes`: `{ pageToken, lastSuccessAt }` — the Changes API checkpoint. `migration`: `{ startedAt, finishedAt }`.

### `candidates.resume` JSON

Keeps its shape so existing UI keeps working. Gains `resumeFileId` and `storage: "s3"`. `driveFileId` / `driveUrl` stay
populated (Drive link still shown).

## Components

All backend, in `backend/src/`:

- **`s3.ts`** — thin wrapper over `@aws-sdk/client-s3` (the one new dependency): `put(key, data, mime, sha256) → { versionId }`,
  `get(key, versionId?)`, `head(key)`, `copy(from, to)`, `remove(key)`. Config: `AWS_REGION`, `S3_BUCKET`, `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`.
- **`storage.ts`** (existing, changed) — `storeResume` writes to S3 and enqueues `to_drive`; `readResume` reads S3, falls back
  to Drive/disk only when `sha256` is null. New `replaceResume`, `renameResume`.
- **`sync.ts`** (new) — the queue worker plus pure decision functions (below). Started from `index.ts` every 30 s.
- **`drive.ts`** (existing) — folder-scan intake unchanged; after `importDriveFiles` creates a candidate it inserts a
  `resume_files` row and enqueues `to_s3`. Adds `pollDriveChanges()`.
- **`google.ts`** (existing) — add `md5Checksum,version,trashed` to file fields; add `getStartPageToken()`,
  `listChanges(token)`, `updateFile(id, data)` (new content revision), `renameFile(id, name)`, `trashFile(id)`.
- **`routes/sync.ts`** (new) — dashboard + admin actions (below).

## Flows

### Transfer + verification (used by every job)

1. Read source bytes (S3, Drive, or disk). Compute `sha256` (and `md5` when the destination is Drive).
2. Write destination. **S3**: `put`, then `get` it back and compare length + SHA-256. **Drive**: upload/update, then read
   metadata and compare `size` and `md5Checksum` to our MD5 (Google Docs: compare exported-PDF SHA-256 we stored).
3. Only on a match: update baseline (`sha256`, `s3_version_id`, `drive_md5`, `drive_version`, `drive_name`), set
   `state = synced`, `last_synced_at = now()`, all in one transaction with marking the job `done`.
4. Mismatch or error → job fails this attempt (see Retries). Nothing is marked synced.

### Migration (one-off, re-runnable from the dashboard)

1. For every candidate with a resume and no `resume_files` row: `INSERT … ON CONFLICT (drive_file_id) DO NOTHING`
   (local resumes keyed by `local_path`), state `pending`; enqueue `to_s3`. Re-running only adds what's missing.
2. The `to_s3` job verifies (above), then switches `candidates.resume` to `storage: "s3"` in the same transaction.
3. Local-disk resumes additionally get a `to_drive` job once S3 is verified.
4. Drive files are never modified or deleted by migration. The dashboard shows *N of M verified*, plus the unverified list.

### Portal upload / replace / rename

- **Upload**: `put` to S3 + verify → create candidate → enqueue `to_drive`.
- **Replace**: `put` new S3 version + verify → `candidates.resume` updated → enqueue `to_drive` (Drive gets a new revision of
  the same file id; Google Doc → new PDF file + Doc moved to `_archive`).
- **Rename**: S3 rename (see *S3 object keys*) → enqueue `rename_drive`.
- Preview/download: stream from S3 with the current `file_name`; existing permission checks unchanged.

### Drive changes (every `DRIVE_SYNC_MINUTES`)

1. Load `drive_changes.pageToken` (first run: `getStartPageToken()`, store it, process nothing).
2. Page through `changes.list` **to the end**, collecting changes in memory. If any page fails, stop; the checkpoint is
   not advanced and the next run repeats from the same token.
3. Apply each change for a file we track (`drive_file_id` match). Each is idempotent, so replaying after a crash is safe.
4. Only after all changes are applied, store `newStartPageToken` and `lastSuccessAt`.
5. Shared drives: if the root folder lives in a shared drive, the token and `changes.list` are scoped with its `driveId`.

Per tracked file, comparing the Drive metadata to the **baseline**:

| Drive says | Portal side changed since baseline?¹ | Action |
|---|---|---|
| md5/version equal to baseline, name equal | — | Echo of our own write or no-op. Ignore. |
| content differs | no | Enqueue `to_s3`. |
| content differs | yes | `conflict`: keep both (S3 version history + Drive revision), stop syncing this file until resolved. |
| only name differs | no | Enqueue `rename_s3`: server-side copy to the new key, update `file_name` and `candidates.resume.fileName`. No bytes leave AWS. |
| only name differs | portal renamed too | `conflict` (name only). |
| `trashed: true` | — | `pending_deletion`, `deleted_side = drive`, `delete_after = now + grace`. |
| `trashed: false` while `pending_deletion` from drive | — | Cancel countdown → `synced`. |
| `removed: true` | — | Confirm with `files.get`: 404 → treat as trashed (above). Otherwise (lost access) → `failed` with error; **no** countdown. |

¹ "Portal side changed" = a queued, running or failed `to_drive` / `rename_drive` job exists for the file. Every portal
write creates such a job, and it only becomes `done` after Drive verifies, so this is exact.

A file missing from the folder scan is never treated as deleted.

### Conflicts

Both versions stay retrievable (S3 key + version id in `conflict.s3`, Drive revision in `conflict.drive`). The candidate keeps
showing the current S3 version. Dashboard actions:

- **Keep portal version** → enqueue `to_drive` (Drive gets it as a new revision; the old Drive revision remains in Drive's
  revision history).
- **Keep Drive version** → enqueue `to_s3` (S3 gets a new version; the old one remains as a noncurrent version).

The chosen action clears `conflict` once its job verifies.

### Deletions (30-day grace)

- **Portal candidate delete** → its `resume_files` row: `candidate_id = null`, `pending_deletion`, `deleted_side = portal`.
- **Drive trash** → as in the table above.
- Dashboard actions while pending: **Restore** (portal side: needs a candidate, so it re-imports to the Drive inbox;
  drive side: un-trash the Drive file / re-upload from S3), **Delete now**.
- A daily pass enqueues `purge` for rows past `delete_after`: S3 `remove` (versioning keeps a noncurrent version, governed by
  the bucket's lifecycle rule) and Drive `trash` (Drive keeps trash a further 30 days). Then `state = deleted`.
- Purge is the only automatic deletion and only follows an explicit signal plus the configured grace period.

### Retries

Failed attempts: `run_after = now + min(1h, 30s · 2^attempts)` with ±20 % jitter. After 8 attempts → job `failed`,
`resume_files.state = failed`, `last_error` kept. Errors that can't succeed on retry (404 on the source, checksum
mismatch twice in a row, 403) fail immediately. Dashboard **Retry** resets `attempts` and re-queues. Jobs left `running` by
a crash are reset to `queued` on startup.

## Admin dashboard

New **Resume sync** section in Settings, gated by new permission `storage.manage` (Admin, Super Admin).

- Counters: total resumes, synced, pending (queued jobs), conflicts, failed, pending deletion, migration *N of M verified*,
  last successful Drive sync (`drive_changes.lastSuccessAt`) and last completed job.
- Lists for conflicts, failures, pending deletions and rows with a `review_reason`, each with its actions; **Retry all failed**; **Run migration**.
- API: `GET /api/sync/status`, `GET /api/sync/items?state=…`, `POST /api/sync/items/:id/{retry,keep-portal,keep-drive,restore,delete-now}`,
  `POST /api/sync/migrate`.

Candidate page: **Replace resume** and **Rename** in the resume card (permission `candidates.edit`); a small badge when
the resume is `conflict`, `failed` or `pending_deletion`.

## Configuration

`.env.example` gains `AWS_REGION`, `S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `RESUME_DELETE_GRACE_DAYS=30`.
Without S3 configured the app behaves exactly as today (Drive/disk), so deployments can upgrade first and migrate later.
`DEPLOY.md`: create the bucket (private, Versioning on, a lifecycle rule expiring noncurrent versions after e.g. 90 days)
and an IAM user limited to `s3:GetObject`, `s3:GetObjectVersion`, `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket` on
that bucket.

## Testing

- `backend/scripts/check-sync.ts`: assert-based checks of the pure decision function (table above: echo, content change,
  rename, conflict, trash, untrash, removed+404, removed+403), the backoff/retry rules, and key building (same name under two
  ids, `/` in a name, empty name, over-long name).
- Manual runbook against a test bucket and Drive folder: interrupted migration (kill mid-run, re-run → no duplicates),
  duplicate change events, simultaneous edit, trash/untrash, a forced failure then Retry.

## Implementation order

1. S3 wrapper, schema migration, config.
2. Resumable migration + verification report.
3. Portal upload / replace / rename / preview / download on S3.
4. Drive Changes checkpoint + incremental worker.
5. Conflicts, deletion grace, retries, dashboard.
6. Check script + manual runbook.

## Out of scope

S3 event notifications (nothing but the portal writes to S3), Drive push webhooks, multiple resumes per candidate.
