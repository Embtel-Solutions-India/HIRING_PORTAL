import type { FastifyInstance } from "fastify";
import { can } from "../../../frontend/src/lib/permissions.ts";
import { q } from "../db.ts";
import { requireUser, type UserRow } from "../http.ts";

// Rows are mapped field-by-field in serialize.ts.
type Row = Record<string, any>;
import * as s from "../serialize.ts";
import { getSetting } from "../settings.ts";

/** Everything the signed-in person is allowed to see, in one payload. The app re-fetches it every ~20s. */
export default async function bootstrapRoutes(app: FastifyInstance) {
  app.get("/api/bootstrap", async (req) => {
    const me = requireUser(req);
    const all = can(me.role, "candidates.viewAll");
    const org = await getSetting("org");

    const [team, stages, jobs, candidates, sources] = await Promise.all([
      q<UserRow>("select * from users order by created_at"),
      q<Row>("select * from stages order by position"),
      q<Row>("select * from jobs order by created_at desc"),
      all
        ? q<Row>("select * from candidates order by applied_at desc")
        : q<Row>("select c.* from candidates c where exists (select 1 from interviews i where i.candidate_id = c.id and $1 = any(i.interviewer_ids)) order by applied_at desc", [me.id]),
      q<Row>("select * from sources order by position, lower(name)"),
    ]);
    const candidateIds = candidates.map((c) => c.id as string);

    const [notes, interviews] = await Promise.all([
      q<Row>("select * from notes where candidate_id = any($1::uuid[]) order by created_at desc", [candidateIds]),
      all
        ? q<Row>("select * from interviews where start_at > now() - interval '180 days' order by start_at")
        : q<Row>("select * from interviews where $1 = any(interviewer_ids) order by start_at", [me.id]),
    ]);
    const feedback = await q<Row>("select * from interview_feedback where interview_id = any($1::uuid[]) order by created_at", [interviews.map((i) => i.id)]);

    const canEmail = can(me.role, "emails.sendSingle");
    const [bookingLinks, templates, campaigns, activity, driveInbox] = await Promise.all([
      all ? q<Row>("select * from booking_links order by created_at") : Promise.resolve([]),
      canEmail ? q<Row>("select * from email_templates order by name") : Promise.resolve([]),
      canEmail
        ? q<Row>(`select c.*,
               array_agg(m.candidate_id) as recipient_ids,
               count(*) filter (where m.status = 'sent')::int as delivered,
               count(m.opened_at)::int as opened,
               count(m.clicked_at)::int as clicked,
               count(*) filter (where m.status = 'failed')::int as failed
             from email_campaigns c left join email_messages m on m.campaign_id = c.id
             group by c.id order by c.send_at desc limit 150`)
        : Promise.resolve([]),
      all
        ? q<Row>("select * from activity order by created_at desc limit 300")
        : q<Row>("select * from activity where candidate_id = any($1::uuid[]) order by created_at desc limit 100", [candidateIds]),
      can(me.role, "resumes.upload")
        ? q<Row>("select * from drive_files where status = 'inbox' order by modified_at desc nulls last limit 200")
        : Promise.resolve([]),
    ]);

    const notesBy = new Map<string, typeof notes>();
    notes.forEach((n) => notesBy.set(n.candidate_id, [...(notesBy.get(n.candidate_id) ?? []), n]));
    const fbBy = new Map<string, typeof feedback>();
    feedback.forEach((f) => fbBy.set(f.interview_id, [...(fbBy.get(f.interview_id) ?? []), f]));

    return {
      me: s.user(me, org.emailDomain),
      team: team.map((u) => s.user(u, org.emailDomain)),
      stages: stages.map(s.stage),
      sources: sources.map(s.source),
      jobs: jobs.map(s.job),
      candidates: candidates.map((c) => s.candidate(c, notesBy.get(c.id) ?? [])),
      interviews: interviews.map((i) => s.interview(i, fbBy.get(i.id) ?? [])),
      bookingLinks: bookingLinks.map(s.bookingLink),
      templates: templates.map(s.template),
      campaigns: campaigns.map(s.campaign),
      activity: activity.map((a) => ({ id: a.id, actorId: a.actor_id ?? "system", type: a.type, candidateId: a.candidate_id ?? undefined, message: a.message, createdAt: a.created_at })),
      settings: await s.orgSettings(),
      driveInbox: driveInbox.map((f) => ({ driveFileId: f.drive_file_id, fileName: f.file_name, folder: f.folder_name, sourceId: f.source_id ?? undefined, sizeKb: f.size_kb, modifiedAt: f.modified_at ?? f.created_at })),
    };
  });
}
