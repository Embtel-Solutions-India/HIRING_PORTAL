import type { FastifyInstance } from "fastify";
import { can } from "../../../frontend/src/lib/permissions.ts";
import { prisma } from "../db.ts";
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
      prisma.users.findMany({ orderBy: { created_at: "asc" } }) as Promise<UserRow[]>,
      prisma.stages.findMany({ orderBy: { position: "asc" } }),
      prisma.jobs.findMany({ orderBy: { created_at: "desc" } }),
      prisma.candidates.findMany({
        where: all ? {} : { interviews: { some: { interviewer_ids: { has: me.id } } } },
        orderBy: { applied_at: "desc" },
      }),
      prisma.sources
        .findMany({ orderBy: { position: "asc" } })
        .then((rows) => rows.sort((a, b) => a.position - b.position || a.name.toLowerCase().localeCompare(b.name.toLowerCase()))),
    ]);
    const candidateIds = candidates.map((c) => c.id);

    const [notes, interviews] = await Promise.all([
      prisma.notes.findMany({ where: { candidate_id: { in: candidateIds } }, orderBy: { created_at: "desc" } }),
      prisma.interviews.findMany({
        where: all ? { start_at: { gt: new Date(Date.now() - 180 * 86400_000) } } : { interviewer_ids: { has: me.id } },
        orderBy: { start_at: "asc" },
      }),
    ]);
    const feedback = await prisma.interview_feedback.findMany({ where: { interview_id: { in: interviews.map((i) => i.id) } }, orderBy: { created_at: "asc" } });

    const canEmail = can(me.role, "emails.sendSingle");
    const [bookingLinks, templates, campaigns, activity, driveInbox] = await Promise.all([
      all ? prisma.booking_links.findMany({ orderBy: { created_at: "asc" } }) : Promise.resolve([]),
      canEmail ? prisma.email_templates.findMany({ orderBy: { name: "asc" } }) : Promise.resolve([]),
      canEmail
        ? prisma.$queryRaw<Row[]>`select c.*,
               array_agg(m.candidate_id) as recipient_ids,
               count(*) filter (where m.status = 'sent')::int as delivered,
               count(m.opened_at)::int as opened,
               count(m.clicked_at)::int as clicked,
               count(*) filter (where m.status = 'failed')::int as failed
             from email_campaigns c left join email_messages m on m.campaign_id = c.id
             group by c.id order by c.send_at desc limit 150`
        : Promise.resolve([]),
      all
        ? prisma.activity.findMany({ orderBy: { created_at: "desc" }, take: 300 })
        : prisma.activity.findMany({ where: { candidate_id: { in: candidateIds } }, orderBy: { created_at: "desc" }, take: 100 }),
      can(me.role, "resumes.upload")
        ? prisma.drive_files.findMany({ where: { status: "inbox" }, orderBy: { modified_at: { sort: "desc", nulls: "last" } }, take: 200 })
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
