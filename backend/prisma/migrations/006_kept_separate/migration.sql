-- People a recruiter confirmed are different, so the duplicate check stops pairing them.
alter table candidates add column kept_separate_from uuid[] not null default '{}';
