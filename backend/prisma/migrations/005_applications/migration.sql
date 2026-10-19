-- A candidate is now the person; each attempt at a job is an application with its own stage and history.
-- Existing candidates each become one application that reuses the candidate's id, so old links keep resolving.

create table rejection_reasons (
  id text primary key,
  label text not null,
  position int not null default 0,
  active boolean not null default true
);
insert into rejection_reasons (id, label, position) values
  ('experience', 'Not enough experience', 0),
  ('skills', 'Skills mismatch', 1),
  ('salary', 'Salary expectations', 2),
  ('withdrew', 'Candidate withdrew', 3),
  ('no_response', 'No response', 4),
  ('filled', 'Position filled', 5),
  ('other', 'Other', 6);

create table applications (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references candidates(id) on delete cascade,
  job_id uuid references jobs(id) on delete set null,
  stage_id text not null references stages(id),
  owner_id uuid references users(id) on delete set null,
  applied_at timestamptz not null default now(),
  stage_entered_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  rating int not null default 0,
  starred boolean not null default false,
  summary jsonb,
  created_at timestamptz not null default now()
);
create index applications_candidate_idx on applications(candidate_id);
create index applications_board_idx on applications(stage_id, last_activity_at desc);
create index applications_job_idx on applications(job_id);

-- Insert-only: every stage move, with who, why and when.
create table stage_transitions (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  from_stage_id text,
  to_stage_id text not null,
  actor_id uuid references users(id) on delete set null,
  reason_id text references rejection_reasons(id),
  reason_label text,
  note text,
  created_at timestamptz not null default now()
);
create index stage_transitions_app_idx on stage_transitions(application_id, created_at);

insert into applications (id, candidate_id, job_id, stage_id, owner_id, applied_at, stage_entered_at, last_activity_at, rating, starred, summary, created_at)
select c.id, c.id, c.job_id, c.stage_id, c.owner_id, c.applied_at, c.stage_entered_at,
       greatest(c.stage_entered_at,
                coalesce((select max(n.created_at) from notes n where n.candidate_id = c.id), c.stage_entered_at),
                coalesce((select max(a.created_at) from activity a where a.candidate_id = c.id), c.stage_entered_at)),
       c.rating, c.starred, c.summary, c.created_at
from candidates c;

insert into stage_transitions (application_id, from_stage_id, to_stage_id, created_at)
select id, null, stage_id, stage_entered_at from applications;

alter table interviews add column application_id uuid references applications(id) on delete cascade;
update interviews set application_id = candidate_id;
alter table interviews alter column application_id set not null;
create index interviews_application_idx on interviews(application_id);

alter table notes add column application_id uuid references applications(id) on delete set null;
update notes set application_id = candidate_id;

alter table email_messages add column application_id uuid references applications(id) on delete set null;

alter table candidates add column possible_duplicate_of uuid references candidates(id) on delete set null;
alter table candidates
  drop column job_id,
  drop column stage_id,
  drop column applied_at,
  drop column stage_entered_at,
  drop column owner_id,
  drop column rating,
  drop column starred,
  drop column summary;

create index activity_candidate_idx on activity(candidate_id, created_at desc);

alter table sync_jobs drop constraint sync_jobs_kind_check;
alter table sync_jobs add constraint sync_jobs_kind_check
  check (kind in ('to_s3', 'to_drive', 'rename_s3', 'rename_drive', 'stash_conflict', 'purge', 'move_drive'));
