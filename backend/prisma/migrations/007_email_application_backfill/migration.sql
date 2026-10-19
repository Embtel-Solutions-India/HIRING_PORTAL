-- Emails queued before 005 (e.g. scheduled for later) had no application; their candidate's first application
-- shares the candidate's id, so link them to it and {{job_title}} / {{stage}} still render.
update email_messages m set application_id = m.candidate_id
from applications a
where m.application_id is null and a.id = m.candidate_id;
