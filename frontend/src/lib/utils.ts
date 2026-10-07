import { clsx, type ClassValue } from "clsx";
import { differenceInCalendarDays, format, formatDistanceToNowStrict, isToday, isTomorrow, parseISO } from "date-fns";
import type { Candidate, Job, Stage } from "../types";

export const cn = (...inputs: ClassValue[]) => clsx(inputs);

export const uid = (prefix = "id") => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

export const fullName = (c: Pick<Candidate, "firstName" | "lastName">) => `${c.firstName} ${c.lastName}`;

export const initials = (name: string) =>
  name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");

export const timeAgo = (iso: string) => formatDistanceToNowStrict(parseISO(iso), { addSuffix: true });

export const daysSince = (iso: string) => differenceInCalendarDays(new Date(), parseISO(iso));

export const fmtDate = (iso: string, pattern = "MMM d, yyyy") => format(parseISO(iso), pattern);

export const fmtTime = (iso: string) => format(parseISO(iso), "h:mm a");

export const fmtDayLabel = (iso: string) => {
  const d = parseISO(iso);
  if (isToday(d)) return "Today";
  if (isTomorrow(d)) return "Tomorrow";
  return format(d, "EEE, MMM d");
};

/** Replace {{merge_fields}} in an email template for one candidate. */
export function renderTemplate(
  text: string,
  ctx: { candidate: Candidate; job?: Job; stage?: Stage; orgName: string; senderName: string; bookingUrl?: string },
) {
  const map: Record<string, string> = {
    first_name: ctx.candidate.firstName,
    last_name: ctx.candidate.lastName,
    full_name: fullName(ctx.candidate),
    job_title: ctx.job?.title ?? "the role",
    stage: ctx.stage?.name ?? "",
    company: ctx.orgName,
    sender_name: ctx.senderName,
    booking_link: ctx.bookingUrl ?? "https://hire.yourcompany.com/book/intro-call",
  };
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key: string) => map[key] ?? m);
}

export const MERGE_FIELDS = [
  "first_name",
  "last_name",
  "full_name",
  "job_title",
  "stage",
  "company",
  "sender_name",
  "booking_link",
];

/** Hex to rgba helper for tinted stage chips. */
export function tint(hex: string, alpha: number) {
  const h = hex.replace("#", "");
  const n = parseInt(h, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
