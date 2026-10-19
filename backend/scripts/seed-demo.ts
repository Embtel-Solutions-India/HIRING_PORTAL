// Fills a LOCAL database with sample team members, jobs, candidates and interviews so you can try the app.
// Usage: npm run seed:demo   (refuses to run when NODE_ENV=production)
import crypto from "node:crypto";
import { seedBookingLinks, seedCandidates, seedInterviews, seedJobs, seedTeam } from "../../frontend/src/data/seed.ts";
import { migrate, prisma } from "../src/db.ts";

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
  const email = u.email.replace("yourcompany.com", "example.com");
  const row = await prisma.users.upsert({
    where: { email },
    create: { id: id(u.id), email, name: u.name, title: u.title, role: u.role, status: u.status, avatar_color: u.avatarColor, last_active_at: u.lastActiveAt ?? null },
    update: { name: u.name },
    select: { id: true },
  });
  ids.set(u.id, row.id);
}
for (const j of seedJobs) {
  await prisma.jobs.create({
    data: { id: id(j.id), title: j.title, department: j.department, location: j.location, type: j.type, status: j.status, hiring_manager_id: id(j.hiringManagerId), openings: j.openings, created_at: j.createdAt },
  });
}
for (const c of seedCandidates) {
  await prisma.candidates.create({
    data: {
      id: id(c.id), first_name: c.firstName, last_name: c.lastName, email: c.email, phone: c.phone, location: c.location, current_title: c.currentTitle, current_company: c.currentCompany,
      source_id: c.sourceId || null, tags: c.tags, skills: c.skills, experience: c.experience.map((e) => ({ ...e })), education: c.education.map((e) => ({ ...e })),
      resume: { ...c.resume, storage: "local", driveFileId: "", uploadedById: id(c.resume.uploadedById) },
    },
  });
  // Each demo person has one application, sharing their id (as migrated data does).
  await prisma.applications.create({
    data: {
      id: id(c.id), candidate_id: id(c.id), job_id: id(c.jobId), stage_id: c.stageId, applied_at: c.appliedAt, stage_entered_at: c.stageEnteredAt, last_activity_at: c.stageEnteredAt,
      owner_id: id(c.ownerId), rating: c.rating, starred: c.starred, summary: { ...c.summary },
    },
  });
  await prisma.stage_transitions.create({ data: { application_id: id(c.id), from_stage_id: null, to_stage_id: c.stageId, created_at: c.stageEnteredAt } });
  for (const n of c.notes) await prisma.notes.create({ data: { candidate_id: id(c.id), application_id: id(c.id), author_id: id(n.authorId), body: n.body, created_at: n.createdAt } });
}
for (const l of seedBookingLinks) {
  await prisma.booking_links.createMany({
    data: {
      id: id(l.id), slug: `${l.slug}-demo`, title: l.title, duration_min: l.durationMin, type: l.type, host_ids: l.hostIds.map(id), days: l.days,
      start_hour: l.startHour, end_hour: l.endHour, buffer_min: l.bufferMin, active: l.active, bookings: l.bookings,
    },
    skipDuplicates: true,
  });
}
for (const i of seedInterviews) {
  await prisma.interviews.create({
    data: {
      id: id(i.id), candidate_id: id(i.candidateId), application_id: id(i.applicationId), job_id: id(i.jobId), title: i.title, type: i.type, start_at: i.start, duration_min: i.durationMin,
      interviewer_ids: i.interviewerIds.map(id), meet_link: i.meetLink ?? null, location: i.location ?? null, status: i.status,
    },
  });
  for (const f of i.feedback ?? []) await prisma.interview_feedback.create({ data: { interview_id: id(i.id), author_id: id(f.authorId), recommendation: f.recommendation, comment: f.comment } });
}
console.log(`Seeded ${seedTeam.length} people, ${seedJobs.length} jobs, ${seedCandidates.length} candidates, ${seedInterviews.length} interviews.`);
console.log("Team emails use @example.com — sign in with dev login, e.g. priya@example.com (Super Admin), daniel@example.com (Recruiter).");
await prisma.$disconnect();
