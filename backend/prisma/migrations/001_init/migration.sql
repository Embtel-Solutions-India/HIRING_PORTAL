create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text not null,
  title text not null default '',
  role text not null check (role in ('interviewer', 'user', 'admin', 'super_admin')),
  status text not null default 'invited' check (status in ('active', 'invited', 'deactivated')),
  avatar_color text not null default '#1d5a3a',
  last_active_at timestamptz,
  created_at timestamptz not null default now()
);

create table sessions (
  id text primary key, -- sha256 of the cookie token
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index sessions_user_idx on sessions(user_id);

create table settings (
  key text primary key,
  value jsonb not null
);

create table email_templates (
  id text primary key,
  name text not null,
  subject text not null,
  body text not null,
  category text not null default 'general',
  updated_at timestamptz not null default now()
);

create table stages (
  id text primary key,
  name text not null,
  color text not null,
  kind text not null check (kind in ('active', 'hired', 'closed')),
  position int not null,
  auto_email_template_id text references email_templates(id) on delete set null
);

create table jobs (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  department text not null default '',
  location text not null default '',
  type text not null default 'Full-time',
  status text not null default 'open' check (status in ('open', 'paused', 'closed')),
  hiring_manager_id uuid references users(id) on delete set null,
  openings int not null default 1,
  description text not null default '',
  drive_folder text not null default '',
  drive_folder_id text,
  created_at timestamptz not null default now()
);

create table candidates (
  id uuid primary key default gen_random_uuid(),
  first_name text not null default '',
  last_name text not null default '',
  email text not null default '',
  phone text not null default '',
  location text not null default '',
  current_title text not null default '',
  current_company text not null default '',
  job_id uuid references jobs(id) on delete set null,
  stage_id text not null references stages(id),
  source text not null default 'Manual upload',
  applied_at timestamptz not null default now(),
  stage_entered_at timestamptz not null default now(),
  owner_id uuid references users(id) on delete set null,
  rating int not null default 0,
  starred boolean not null default false,
  tags text[] not null default '{}',
  skills text[] not null default '{}',
  experience jsonb not null default '[]',
  education jsonb not null default '[]',
  summary jsonb,
  resume jsonb,
  resume_text text,
  parse_status text not null default 'ready' check (parse_status in ('pending', 'ready', 'failed')),
  created_at timestamptz not null default now()
);
create index candidates_job_idx on candidates(job_id);
create index candidates_stage_idx on candidates(stage_id);
create index candidates_email_idx on candidates(lower(email));

create table notes (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references candidates(id) on delete cascade,
  author_id uuid references users(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now()
);
create index notes_candidate_idx on notes(candidate_id);

create table booking_links (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  duration_min int not null default 30,
  type text not null default 'video',
  host_ids uuid[] not null default '{}',
  days int[] not null default '{1,2,3,4,5}',
  start_hour int not null default 9,
  end_hour int not null default 17,
  buffer_min int not null default 15,
  active boolean not null default true,
  bookings int not null default 0,
  created_at timestamptz not null default now()
);

create table interviews (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references candidates(id) on delete cascade,
  job_id uuid references jobs(id) on delete set null,
  title text not null,
  type text not null check (type in ('phone', 'video', 'onsite')),
  start_at timestamptz not null,
  duration_min int not null,
  interviewer_ids uuid[] not null default '{}',
  meet_link text,
  location text,
  status text not null default 'scheduled' check (status in ('scheduled', 'completed', 'cancelled', 'no_show')),
  calendar_event_id text,
  booked_via uuid references booking_links(id) on delete set null,
  created_at timestamptz not null default now()
);
create index interviews_candidate_idx on interviews(candidate_id);
create index interviews_start_idx on interviews(start_at);

create table interview_feedback (
  id uuid primary key default gen_random_uuid(),
  interview_id uuid not null references interviews(id) on delete cascade,
  author_id uuid references users(id) on delete set null,
  recommendation text not null check (recommendation in ('strong_yes', 'yes', 'no', 'strong_no')),
  comment text not null,
  created_at timestamptz not null default now()
);

create table email_campaigns (
  id uuid primary key default gen_random_uuid(),
  subject text not null,
  body text not null,
  template_id text references email_templates(id) on delete set null,
  from_address text not null,
  sent_by_id uuid references users(id) on delete set null,
  send_at timestamptz not null default now(),
  status text not null default 'scheduled' check (status in ('scheduled', 'sending', 'sent', 'failed')),
  created_at timestamptz not null default now()
);

create table email_messages (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references email_campaigns(id) on delete cascade,
  candidate_id uuid references candidates(id) on delete set null,
  to_address text not null,
  subject text not null default '',
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed')),
  provider_id text,
  error text,
  sent_at timestamptz,
  opened_at timestamptz,
  clicked_at timestamptz
);
create index email_messages_campaign_idx on email_messages(campaign_id);

create table activity (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references users(id) on delete set null,
  type text not null,
  candidate_id uuid references candidates(id) on delete set null,
  message text not null,
  created_at timestamptz not null default now()
);
create index activity_created_idx on activity(created_at desc);

create table drive_files (
  drive_file_id text primary key,
  file_name text not null,
  mime_type text not null,
  folder_id text,
  folder_name text not null default '',
  size_kb int not null default 0,
  modified_at timestamptz,
  status text not null default 'inbox' check (status in ('inbox', 'imported', 'ignored')),
  candidate_id uuid references candidates(id) on delete set null,
  created_at timestamptz not null default now()
);
