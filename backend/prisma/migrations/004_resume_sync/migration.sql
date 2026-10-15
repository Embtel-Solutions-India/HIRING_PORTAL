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
