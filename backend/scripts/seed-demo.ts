// Fills a LOCAL database with sample team members, jobs, candidates and interviews so you can try the app.
// Usage: npm run seed:demo   (refuses to run when NODE_ENV=production)
import crypto from "node:crypto";
import { seedBookingLinks, seedCandidates, seedInterviews, seedJobs, seedTeam } from "../../frontend/src/data/seed.ts";
import { migrate, pool, q } from "../src/db.ts";

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to seed demo data in production.");
  process.exit(1);
}

await migrate();
const ids = new Map<string, string>();
const id = (key: string) => {
  if (!ids.has(key)) ids.set(key, crypto.randomUUID());
  return ids.get(key)!;
};

for (const u of seedTeam) {
  const rows = await q<{ id: string }>(
    `insert into users (id, email, name, title, role, status, avatar_color, last_active_at) values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (email) do update set name = excluded.name returning id`,
    [id(u.id), u.email.replace("yourcompany.com", "example.com"), u.name, u.title, u.role, u.status, u.avatarColor, u.lastActiveAt ?? null],
  );
  ids.set(u.id, rows[0]!.id);
}
for (const j of seedJobs) {
  await q("insert into jobs (id, title, department, location, type, status, hiring_manager_id, openings, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [
    id(j.id),
    j.title,
    j.department,
    j.location,
    j.type,
    j.status,
    id(j.hiringManagerId),
    j.openings,
    j.createdAt,
  ]);
}
for (const c of seedCandidates) {
  await q(
    `insert into candidates (id, first_name, last_name, email, phone, location, current_title, current_company, job_id, stage_id, source_id, applied_at, stage_entered_at,
       owner_id, rating, starred, tags, skills, experience, education, summary, resume)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
    [
      id(c.id), c.firstName, c.lastName, c.email, c.phone, c.location, c.currentTitle, c.currentCompany, id(c.jobId), c.stageId, c.sourceId || null, c.appliedAt, c.stageEnteredAt,
      id(c.ownerId), c.rating, c.starred, c.tags, c.skills, JSON.stringify(c.experience), JSON.stringify(c.education), JSON.stringify(c.summary),
      JSON.stringify({ ...c.resume, storage: "local", driveFileId: "", uploadedById: id(c.resume.uploadedById) }),
    ],
  );
  for (const n of c.notes) await q("insert into notes (candidate_id, author_id, body, created_at) values ($1,$2,$3,$4)", [id(c.id), id(n.authorId), n.body, n.createdAt]);
}
for (const l of seedBookingLinks) {
  await q(
    "insert into booking_links (id, slug, title, duration_min, type, host_ids, days, start_hour, end_hour, buffer_min, active, bookings) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict (slug) do nothing",
    [id(l.id), `${l.slug}-demo`, l.title, l.durationMin, l.type, l.hostIds.map(id), l.days, l.startHour, l.endHour, l.bufferMin, l.active, l.bookings],
  );
}
for (const i of seedInterviews) {
  await q(
    "insert into interviews (id, candidate_id, job_id, title, type, start_at, duration_min, interviewer_ids, meet_link, location, status) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
    [id(i.id), id(i.candidateId), id(i.jobId), i.title, i.type, i.start, i.durationMin, i.interviewerIds.map(id), i.meetLink ?? null, i.location ?? null, i.status],
  );
  for (const f of i.feedback ?? []) await q("insert into interview_feedback (interview_id, author_id, recommendation, comment) values ($1,$2,$3,$4)", [id(i.id), id(f.authorId), f.recommendation, f.comment]);
}
console.log(`Seeded ${seedTeam.length} people, ${seedJobs.length} jobs, ${seedCandidates.length} candidates, ${seedInterviews.length} interviews.`);
console.log("Team emails use @example.com — sign in with dev login, e.g. priya@example.com (Super Admin), daniel@example.com (Recruiter).");
await pool.end();
