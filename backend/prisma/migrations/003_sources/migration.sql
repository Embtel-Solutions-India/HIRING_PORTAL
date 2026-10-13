-- Recruiting sources (the platform a candidate came from): a list the team can edit.
-- Google Drive / manual upload are only how a resume reaches the ATS, so they are not sources.
create table sources (
  id text primary key,
  name text not null,
  color text not null default '#898781',
  position int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index sources_name_idx on sources (lower(name));

insert into sources (id, name, color, position) values
  ('linkedin', 'LinkedIn', '#2a78d6', 0),
  ('indeed', 'Indeed', '#4a3aa7', 1),
  ('referral', 'Referral', '#1baf7a', 2),
  ('instagram', 'Instagram', '#e87ba4', 3),
  ('internshala', 'Internshala', '#eda100', 4),
  ('naukri', 'Naukri', '#eb6834', 5),
  ('website', 'Company website', '#008300', 6),
  ('other', 'Other', '#898781', 7)
on conflict do nothing;

alter table candidates add column source_id text references sources(id) on delete set null;
update candidates set source_id = case lower(source)
  when 'linkedin' then 'linkedin'
  when 'indeed' then 'indeed'
  when 'referral' then 'referral'
  when 'careers page' then 'website'
  else null
end;
alter table candidates drop column source;
create index candidates_source_idx on candidates(source_id);

-- Source detected from the Drive sub-folder a file sits in (e.g. "Case Manager/LinkedIn/cv.pdf").
alter table drive_files add column source_id text references sources(id) on delete set null;
