/** Interviews ↔ Google Calendar, free/busy, and time-zone math for booking links. */
import { logActivity } from "./activity.ts";
import { config } from "./config.ts";
import { prisma } from "./db.ts";
import { createCampaign } from "./email.ts";
import * as google from "./google.ts";
import { HttpError } from "./http.ts";
import { getSetting } from "./settings.ts";

export interface NewInterview {
  candidateId: string;
  title: string;
  type: "phone" | "video" | "onsite";
  start: Date;
  durationMin: number;
  interviewerIds: string[];
  location?: string | null;
  /** Invite the candidate (calendar invite, or an email if Google isn't connected). */
  notifyCandidate: boolean;
  bookedVia?: string | null;
  actorId: string | null;
}

export async function createInterview(input: NewInterview) {
  const found = await prisma.candidates.findUnique({
    where: { id: input.candidateId },
    select: { id: true, first_name: true, last_name: true, email: true, job_id: true, jobs: { select: { title: true } } },
  });
  if (!found) throw new Error("Candidate not found");
  const c = { ...found, job_title: found.jobs?.title ?? null };
  const interviewers = await prisma.users.findMany({ where: { id: { in: input.interviewerIds } }, select: { email: true, name: true } });
  const org = await getSetting("org");
  const g = await getSetting("google");
  const end = new Date(input.start.getTime() + input.durationMin * 60_000);
  const name = `${c.first_name} ${c.last_name}`.trim();

  let calendarEventId: string | null = null;
  let meetLink: string | null = null;
  const location = input.type === "onsite" ? input.location || "Office" : null;
  const inviteCandidate = input.notifyCandidate && !!c.email;
  if (await google.isConnected()) {
    // The event description is visible to every guest, so the internal profile link is only added when the candidate isn't invited.
    const description = inviteCandidate
      ? `${input.title} for the ${c.job_title ?? ""} role at ${org.orgName}.\n\nQuestions? Reply to ${org.replyTo || org.senderAddress}.`
      : `${input.title} with ${name}${c.job_title ? ` (${c.job_title})` : ""}.\n\nCandidate profile: ${config.appUrl}/candidates/${c.id}`;
    const event = await google.createEvent({
      summary: `${input.title}: ${name}${c.job_title ? ` · ${c.job_title}` : ""}`,
      description,
      start: input.start,
      end,
      attendees: [...interviewers.map((i) => i.email), ...(inviteCandidate ? [c.email] : [])],
      withMeet: input.type === "video" && g.autoMeetLinks,
      location: location ?? undefined,
      sendUpdates: true,
    });
    calendarEventId = event.id;
    meetLink = event.meetLink ?? null;
  }

  const row = await prisma
    .$transaction(async (tx) => {
      // Share-lock the interviewers: a concurrent account delete either waits for this interview (and then sees it)
      // or has already removed the account (and this booking is refused).
      const ids = [...new Set(input.interviewerIds)];
      const present = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM users WHERE id = ANY(${ids}::uuid[]) FOR SHARE`;
      if (present.length !== ids.length) throw new HttpError(409, "One of the interviewers no longer exists — pick someone else");
      return tx.interviews.create({
        data: {
          candidate_id: c.id,
          job_id: c.job_id,
          title: input.title,
          type: input.type,
          start_at: input.start,
          duration_min: input.durationMin,
          interviewer_ids: input.interviewerIds,
          meet_link: meetLink,
          location,
          calendar_event_id: calendarEventId,
          booked_via: input.bookedVia ?? null,
        },
        select: { id: true },
      });
    })
    .catch(async (e) => {
      if (calendarEventId) await google.cancelEvent(calendarEventId).catch(() => {});
      throw e;
    });
  await logActivity(input.actorId, "interview_scheduled", `${input.bookedVia ? "booked" : "scheduled"} ${input.title.toLowerCase()} with ${name}`, c.id);

  // Without Google Calendar the candidate still gets a confirmation email.
  if (inviteCandidate && !calendarEventId) {
    const when = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: config.orgTimezone, timeZoneName: "short" }).format(input.start);
    await createCampaign({
      recipientIds: [c.id],
      subject: `Interview confirmed: ${input.title}`,
      body: `Hi {{first_name}},\n\nYour ${input.title.toLowerCase()} for {{job_title}} is confirmed for ${when}${location ? ` at ${location}` : ""}.\n\nSee you then,\n{{sender_name}}`,
      actorId: input.actorId,
    });
  }
  return row.id;
}

export async function cancelInterview(id: string) {
  const iv = await prisma.interviews.findUnique({ where: { id }, select: { calendar_event_id: true } });
  if (iv?.calendar_event_id && (await google.isConnected())) await google.cancelEvent(iv.calendar_event_id);
}

/** Busy blocks per user id, from Google Calendar (if connected) plus interviews already in the ATS. */
export async function busyFor(userIds: string[], from: Date, to: Date) {
  const users = await prisma.users.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } });
  const out: Record<string, { start: string; end: string }[]> = Object.fromEntries(users.map((u) => [u.id, []]));
  let source: "google" | "ats" = "ats";
  if (await google.isConnected()) {
    try {
      const fb = await google.freeBusy(users.map((u) => u.email), from, to);
      users.forEach((u) => out[u.id]!.push(...(fb[u.email.toLowerCase()] ?? [])));
      source = "google";
    } catch (e) {
      console.warn("[calendar] free/busy failed:", e instanceof Error ? e.message : e);
    }
  }
  const ivs = await prisma.$queryRaw<{ interviewer_ids: string[]; start_at: Date; duration_min: number }[]>`
    select interviewer_ids, start_at, duration_min from interviews
    where status = 'scheduled' and start_at < ${to} and start_at + make_interval(mins => duration_min) > ${from} and interviewer_ids && ${userIds}::uuid[]`;
  for (const iv of ivs) {
    const block = { start: iv.start_at.toISOString(), end: new Date(iv.start_at.getTime() + iv.duration_min * 60_000).toISOString() };
    iv.interviewer_ids.filter((id) => out[id]).forEach((id) => out[id]!.push(block));
  }
  return { busy: out, source };
}

export const overlaps = (aStart: number, aEnd: number, blocks: { start: string; end: string }[]) =>
  blocks.some((b) => aStart < new Date(b.end).getTime() && aEnd > new Date(b.start).getTime());

// ---------- time zones ----------

/** Offset (ms) of `tz` from UTC at instant `date`. */
function tzOffset(date: Date, tz: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  return asUtc - date.getTime();
}

/** Wall-clock time in `tz` → UTC instant. `ymd` is "2026-10-05". */
export function zonedTime(ymd: string, hour: number, minute: number, tz = config.orgTimezone): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  const guess = new Date(Date.UTC(y!, m! - 1, d!, hour, minute));
  const offset = tzOffset(guess, tz);
  const result = new Date(guess.getTime() - offset);
  // Correct for DST transitions between the guess and the result.
  const offset2 = tzOffset(result, tz);
  return offset2 === offset ? result : new Date(guess.getTime() - offset2);
}

/** "YYYY-MM-DD" and weekday (0=Sun) of an instant in `tz`. */
export function zonedDay(date: Date, tz = config.orgTimezone) {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  const weekday = new Date(`${ymd}T12:00:00Z`).getUTCDay();
  return { ymd, weekday };
}
