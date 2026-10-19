/** No-login endpoints: candidate self-booking and email tracking. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { bookingApplication } from "../applications.ts";
import { config } from "../config.ts";
import { verifySignature } from "../crypto.ts";
import { prisma } from "../db.ts";
import { HttpError, isUuid } from "../http.ts";
import { busyFor, createInterview, overlaps, zonedDay, zonedTime } from "../scheduling.ts";
import { getSetting } from "../settings.ts";

// Tiny per-IP rate limit for public endpoints.
const hits = new Map<string, { n: number; reset: number }>();
function limit(req: FastifyRequest, max: number) {
  const key = `${req.ip}:${req.routeOptions.url}`;
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < now) hits.set(key, { n: 1, reset: now + 60_000 });
  else if (++h.n > max) throw new HttpError(429, "Too many requests — please wait a minute.");
}

interface LinkRow {
  id: string;
  slug: string;
  title: string;
  duration_min: number;
  type: "phone" | "video" | "onsite";
  host_ids: string[];
  days: number[];
  start_hour: number;
  end_hour: number;
  buffer_min: number;
  active: boolean;
}

async function activeLink(slug: string) {
  const link = (await prisma.booking_links.findUnique({ where: { slug } })) as LinkRow | null;
  if (!link || !link.active || !link.host_ids.length) throw new HttpError(404, "This booking link isn't available");
  return link;
}

/** Open slots per day; a slot is open if at least one host is free (round-robin). */
async function openSlots(link: LinkRow, fromDay: Date, days: number) {
  const tz = config.orgTimezone;
  const minStart = Date.now() + 4 * 3600_000; // at least 4 hours' notice
  const rangeEnd = new Date(fromDay.getTime() + (days + 1) * 86400_000);
  const { busy } = await busyFor(link.host_ids, fromDay, rangeEnd);
  const out: { date: string; slots: { start: string; hostId: string }[] }[] = [];
  for (let i = 0; i < days; i++) {
    const { ymd, weekday } = zonedDay(new Date(fromDay.getTime() + i * 86400_000), tz);
    if (!link.days.includes(weekday) || out.some((d) => d.date === ymd)) continue;
    const slots: { start: string; hostId: string }[] = [];
    for (let m = link.start_hour * 60; m + link.duration_min <= link.end_hour * 60; m += link.duration_min + link.buffer_min) {
      const start = zonedTime(ymd, Math.floor(m / 60), m % 60, tz);
      const s = start.getTime();
      if (s < minStart) continue;
      const e = s + link.duration_min * 60_000;
      const pad = link.buffer_min * 60_000;
      const host = link.host_ids.find((h) => !overlaps(s - pad, e + pad, busy[h] ?? []));
      if (host) slots.push({ start: start.toISOString(), hostId: host });
    }
    out.push({ date: ymd, slots });
  }
  return out;
}

export default async function publicRoutes(app: FastifyInstance) {
  app.get("/api/public/booking/:slug", async (req) => {
    limit(req, 60);
    const link = await activeLink((req.params as { slug: string }).slug);
    const { c } = req.query as { c?: string };
    const org = await getSetting("org");
    const hosts = await prisma.users.findMany({ where: { id: { in: link.host_ids }, status: "active" }, select: { name: true, avatar_color: true } });
    const candidate = isUuid(c) ? await prisma.candidates.findUnique({ where: { id: c }, select: { first_name: true } }) : null;
    return {
      orgName: org.orgName,
      timezone: config.orgTimezone,
      link: { title: link.title, durationMin: link.duration_min, type: link.type, days: link.days, startHour: link.start_hour, endHour: link.end_hour },
      hosts: hosts.map((h) => ({ name: h.name, avatarColor: h.avatar_color })),
      candidateFirstName: candidate?.first_name,
    };
  });

  app.get("/api/public/booking/:slug/slots", async (req) => {
    limit(req, 30);
    const link = await activeLink((req.params as { slug: string }).slug);
    return { days: await openSlots(link, new Date(), 21) };
  });

  app.post("/api/public/booking/:slug", async (req) => {
    limit(req, 10);
    const link = await activeLink((req.params as { slug: string }).slug);
    const body = z
      .object({ start: z.string().datetime({ offset: true }), name: z.string().trim().min(1).max(120), email: z.string().trim().email().max(200), notes: z.string().max(2000).optional(), candidateId: z.string().optional() })
      .parse(req.body);

    const candidate =
      (isUuid(body.candidateId) ? await prisma.candidates.findUnique({ where: { id: body.candidateId }, select: { id: true, email: true } }) : null) ??
      // Raw so the comparison stays an exact lower() match (uses candidates_email_idx), not ILIKE.
      (await prisma.$queryRaw<{ id: string; email: string }[]>`select id, email from candidates where lower(email) = lower(${body.email}) order by created_at desc limit 1`)[0];
    if (!candidate) throw new HttpError(404, "We couldn't find your application. Please use the link from the email we sent you.");

    // Re-check the slot is still open and pick the host.
    const start = new Date(body.start);
    const day = await openSlots(link, new Date(start.getTime() - 86400_000), 2);
    const slot = day.flatMap((d) => d.slots).find((s) => s.start === start.toISOString());
    if (!slot) throw new HttpError(409, "Sorry, that time was just taken. Please pick another.");

    if (!candidate.email && body.email) await prisma.candidates.updateMany({ where: { id: candidate.id }, data: { email: body.email } });
    // The booking is for the job they're being considered for now.
    const applicationId = await bookingApplication(candidate.id);
    if (!applicationId) throw new HttpError(404, "We couldn't find your application. Please use the link from the email we sent you.");
    const id = await createInterview({
      applicationId,
      title: link.title,
      type: link.type,
      start,
      durationMin: link.duration_min,
      interviewerIds: [slot.hostId],
      notifyCandidate: true,
      bookedVia: link.id,
      actorId: null,
    });
    if (body.notes?.trim()) await prisma.notes.create({ data: { candidate_id: candidate.id, author_id: null, body: `Booking note from candidate: ${body.notes.trim()}` } });
    await prisma.booking_links.updateMany({ where: { id: link.id }, data: { bookings: { increment: 1 } } });
    const iv = await prisma.interviews.findUnique({ where: { id }, select: { meet_link: true } });
    return { start: slot.start, meetLink: iv?.meet_link ?? null };
  });

  // ---------- email tracking ----------

  const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

  app.get("/t/o/:file", async (req, reply) => {
    const id = (req.params as { file: string }).file.replace(/\.gif$/, "");
    if (isUuid(id)) prisma.email_messages.updateMany({ where: { id, opened_at: null }, data: { opened_at: new Date() } }).catch(() => {});
    reply.header("cache-control", "no-store");
    return reply.type("image/gif").send(GIF);
  });

  app.get("/t/c/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { u, s } = req.query as { u?: string; s?: string };
    if (!u || !s || !isUuid(id) || !verifySignature(`${id}|${u}`, s) || !/^https?:\/\//.test(u)) return reply.redirect(config.appUrl);
    const now = new Date();
    prisma
      .$transaction([
        prisma.email_messages.updateMany({ where: { id, clicked_at: null }, data: { clicked_at: now } }),
        prisma.email_messages.updateMany({ where: { id, opened_at: null }, data: { opened_at: now } }),
      ])
      .catch(() => {});
    return reply.redirect(u);
  });
}
