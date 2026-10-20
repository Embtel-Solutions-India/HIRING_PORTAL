// Run against a local database with EMAIL_TRANSPORT=log: npm run check:reply-to
// Candidate replies reach whoever sent the email, plus everyone on an interview.
import assert from "node:assert/strict";
import { createApplication } from "../src/applications.ts";
import { config } from "../src/config.ts";
import { migrate, prisma } from "../src/db.ts";
import { createCampaign, sendCampaign, sendSystemEmail } from "../src/email.ts";
import { isConnected } from "../src/google.ts";
import { createInterview } from "../src/scheduling.ts";
import { getSetting } from "../src/settings.ts";

if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? "")) throw new Error("check-reply-to only runs against a local DATABASE_URL");
if (config.email.transport !== "log") throw new Error("check-reply-to needs EMAIL_TRANSPORT=log so nothing is really sent");
await migrate();
if (await isConnected()) throw new Error("Google is connected locally; check-reply-to would create real calendar events");

// The log transport prints each email; keep the Reply-To lines.
const replies: string[] = [];
const log = console.log;
console.log = (...args: unknown[]) => {
  const m = String(args[0]).match(/\[email:log\][\s\S]*?\nReply-To: (.*)\n/);
  if (m) replies.push(m[1]!);
  else log(...args);
};
async function nextReplyTo() {
  const seen = replies.length;
  for (let i = 0; i < 100 && replies.length === seen; i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(replies.length > seen, "an email was sent");
  return replies[replies.length - 1]!.split(",").sort().join(",");
}

const cleanup = async () => {
  await prisma.candidates.deleteMany({ where: { first_name: "CHK-RT" } });
  const ids = (await prisma.users.findMany({ where: { email: { endsWith: "@chk-rt.test" } }, select: { id: true } })).map((u) => u.id);
  await prisma.activity.deleteMany({ where: { actor_id: { in: ids } } });
  await prisma.email_campaigns.deleteMany({ where: { OR: [{ sent_by_id: { in: ids } }, { subject: { startsWith: "CHK-RT" } }] } });
  await prisma.users.deleteMany({ where: { id: { in: ids } } });
};
await cleanup();

const user = (name: string, role: string) => prisma.users.create({ data: { email: `${name}@chk-rt.test`, name, role, status: "active" } });
const recruiter = await user("recruiter", "user");
const admin = await user("admin", "admin");
const iv1 = await user("iv1", "interviewer");
const iv2 = await user("iv2", "interviewer");
const cand = await prisma.candidates.create({ data: { first_name: "CHK-RT", last_name: "Cand", email: "cand@chk-rt.test" } });
const applicationId = await createApplication({ candidateId: cand.id, jobId: null, actorId: null });
const one = [{ candidateId: cand.id, applicationId }];
const interview = (actorId: string | null) => ({ applicationId, title: "CHK-RT Interview", type: "phone" as const, start: new Date(Date.now() + 86_400_000), durationMin: 30, interviewerIds: [iv1.id, iv2.id], notifyCandidate: true, actorId });

try {
  await createCampaign({ recipients: one, subject: "CHK-RT a", body: "hi", actorId: recruiter.id });
  assert.equal(await nextReplyTo(), recruiter.email, "R1: recruiter's email → recruiter only");

  await createCampaign({ recipients: one, subject: "CHK-RT b", body: "hi", actorId: admin.id });
  assert.equal(await nextReplyTo(), admin.email, "R2: admin's email → admin only");

  // Scheduled sends are picked up later by the cron, with no in-memory context.
  const later = await createCampaign({ recipients: one, subject: "CHK-RT c", body: "hi", scheduledAt: new Date(Date.now() + 3_600_000).toISOString(), actorId: recruiter.id });
  void sendCampaign(later);
  assert.equal(await nextReplyTo(), recruiter.email, "R3: scheduled email still replies to its sender");

  await createInterview(interview(recruiter.id));
  assert.equal(await nextReplyTo(), [recruiter.email, iv1.email, iv2.email].sort().join(","), "R4: interview → recruiter + interviewers");

  await createInterview(interview(iv1.id));
  assert.equal(await nextReplyTo(), [iv1.email, iv2.email].sort().join(","), "R5: interviewer scheduling counts once");

  await createInterview(interview(null));
  assert.equal(await nextReplyTo(), [iv1.email, iv2.email].sort().join(","), "R6: self-booked → interviewers");

  await createCampaign({ recipients: one, subject: "CHK-RT d", body: "hi", actorId: null });
  assert.equal(await nextReplyTo(), (await getSetting("org")).replyTo, "R7: no sender → org reply-to");

  // Awaited, so it has already been logged by the time it returns.
  await sendSystemEmail("new@chk-rt.test", "CHK-RT invite", "hi", admin.email);
  assert.equal(replies.at(-1), admin.email, "R8: invite → inviting admin");
  log("R1–R8 ok");
} finally {
  await cleanup();
  await prisma.$disconnect();
}
