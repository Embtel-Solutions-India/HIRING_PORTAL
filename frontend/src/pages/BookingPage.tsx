import { addMinutes, format, parseISO } from "date-fns";
import { CalendarCheck, CalendarX, Clock, Globe, Loader2, MapPin, Phone, Video } from "lucide-react";
import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Avatar, Button, Field } from "../components/ui";
import { api, errorMessage } from "../lib/api";
import { cn } from "../lib/utils";

/** Public, candidate-facing self-booking page (no login). Times are shown in the candidate's own time zone. */
interface Info {
  orgName: string;
  timezone: string;
  link: { title: string; durationMin: number; type: "phone" | "video" | "onsite" };
  hosts: { name: string; avatarColor: string }[];
  candidateFirstName?: string;
}
interface Day {
  date: string;
  slots: { start: string }[];
}

export default function BookingPage() {
  const { slug } = useParams();
  const [params] = useSearchParams();
  const candidateId = params.get("c") ?? undefined;
  const [info, setInfo] = useState<Info | null>(null);
  const [days, setDays] = useState<Day[] | null>(null);
  const [failed, setFailed] = useState("");
  const [day, setDay] = useState<string | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [booked, setBooked] = useState<{ start: string; meetLink: string | null } | null>(null);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const loadSlots = () =>
    api
      .get<{ days: Day[] }>(`/api/public/booking/${slug}/slots`)
      .then((r) => {
        setDays(r.days);
        setDay((d) => d ?? r.days.find((x) => x.slots.length)?.date ?? null);
      })
      .catch((e) => setFailed(errorMessage(e)));

  useEffect(() => {
    api
      .get<Info>(`/api/public/booking/${slug}${candidateId ? `?c=${candidateId}` : ""}`)
      .then((i) => {
        setInfo(i);
        if (i.candidateFirstName) setName(i.candidateFirstName);
      })
      .catch((e) => setFailed(errorMessage(e)));
    void loadSlots();
  }, [slug, candidateId]);

  if (failed && !info) {
    return (
      <Shell orgName="">
        <div className="py-16 text-center">
          <CalendarX className="mx-auto text-muted" />
          <h1 className="mt-3 text-xl font-bold">This booking link isn't available</h1>
          <p className="mt-1 text-sm text-muted">Please reply to the email you received and we'll send you a new one.</p>
        </div>
      </Shell>
    );
  }
  if (!info || !days) {
    return (
      <Shell orgName={info?.orgName ?? ""}>
        <div className="flex justify-center py-20 text-muted">
          <Loader2 className="animate-spin" />
        </div>
      </Shell>
    );
  }

  const TypeIcon = info.link.type === "video" ? Video : info.link.type === "phone" ? Phone : MapPin;
  const selectedDay = days.find((d) => d.date === day);

  const confirm = async () => {
    if (!slot) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      const r = await api.post<{ start: string; meetLink: string | null }>(`/api/public/booking/${slug}`, { start: slot, name, email, notes, candidateId });
      setBooked(r);
    } catch (e) {
      setSubmitError(errorMessage(e));
      setSlot(null);
      void loadSlots();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Shell orgName={info.orgName}>
      {booked ? (
        <div className="px-6 py-12 text-center">
          <span className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-lime text-brand-900">
            <CalendarCheck size={26} />
          </span>
          <h1 className="mt-4 text-2xl font-extrabold tracking-tight">You're booked!</h1>
          <p className="mt-1 text-muted">
            {info.link.title} · {format(parseISO(booked.start), "EEEE, MMMM d 'at' h:mm a")}
          </p>
          <p className="mx-auto mt-3 max-w-sm text-sm text-muted">
            A calendar invite{booked.meetLink ? " with the Google Meet link" : ""} is on its way to <b className="text-ink-2">{email}</b>.
          </p>
          {booked.meetLink && (
            <a href={booked.meetLink} className="mt-4 inline-block text-sm font-semibold text-brand-700 hover:underline">
              {booked.meetLink.replace("https://", "")}
            </a>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-[260px_minmax(0,1fr)]">
          <aside className="border-b border-line p-6 md:border-r md:border-b-0">
            <span className="flex -space-x-2">
              {info.hosts.map((h) => (
                <span key={h.name} className="rounded-full ring-2 ring-surface">
                  <Avatar name={h.name} color={h.avatarColor} size={36} />
                </span>
              ))}
            </span>
            <p className="mt-3 text-sm font-semibold text-muted">{info.hosts.map((h) => h.name).join(" or ")}</p>
            <h1 className="mt-1 text-xl font-extrabold tracking-tight">{info.link.title}</h1>
            <ul className="mt-4 space-y-2 text-sm text-ink-2">
              <li className="flex items-center gap-2">
                <Clock size={15} className="text-muted" /> {info.link.durationMin} minutes
              </li>
              <li className="flex items-center gap-2">
                <TypeIcon size={15} className="text-muted" /> {info.link.type === "video" ? "Google Meet" : info.link.type === "phone" ? "Phone call" : "In person"}
              </li>
              <li className="flex items-center gap-2">
                <Globe size={15} className="text-muted" /> Times shown in {tz.replace(/_/g, " ")}
              </li>
            </ul>
            {info.candidateFirstName && <p className="mt-5 rounded-lg bg-paper p-3 text-[13px] text-ink-2">Hi {info.candidateFirstName} — pick any time that works for you.</p>}
          </aside>

          <section className="p-6">
            {submitError && <p className="mb-4 rounded-lg bg-rose-50 p-3 text-[13px] font-medium text-rose-800">{submitError}</p>}
            {!slot ? (
              <>
                <h2 className="font-bold">Select a day</h2>
                {days.every((d) => !d.slots.length) ? (
                  <p className="mt-3 text-sm text-muted">No open times in the next three weeks. Please reply to our email and we'll find a time.</p>
                ) : (
                  <div className="mt-3 grid grid-cols-4 gap-1.5 sm:grid-cols-5">
                    {days.map((d) => {
                      const date = parseISO(`${d.date}T12:00:00`);
                      const empty = !d.slots.length;
                      return (
                        <button
                          key={d.date}
                          disabled={empty}
                          onClick={() => setDay(d.date)}
                          className={cn(
                            "flex flex-col items-center rounded-xl border py-2 transition disabled:cursor-not-allowed disabled:opacity-35",
                            day === d.date ? "border-brand-700 bg-brand-700 text-white" : "border-line hover:border-brand-500",
                          )}
                        >
                          <span className="text-[10px] font-semibold uppercase opacity-70">{format(date, "EEE")}</span>
                          <span className="text-lg font-bold">{format(date, "d")}</span>
                          <span className="text-[10px] opacity-70">{format(date, "MMM")}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
                {selectedDay && selectedDay.slots.length > 0 && (
                  <>
                    <h2 className="mt-6 font-bold">{format(parseISO(`${selectedDay.date}T12:00:00`), "EEEE, MMMM d")}</h2>
                    <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
                      {selectedDay.slots.map((s) => (
                        <button key={s.start} onClick={() => setSlot(s.start)} className="tabular rounded-lg border border-brand-200 bg-brand-50 py-2 text-sm font-bold text-brand-800 transition hover:border-brand-600">
                          {format(parseISO(s.start), "h:mm a")}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </>
            ) : (
              <form
                className="max-w-md space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void confirm();
                }}
              >
                <button type="button" onClick={() => setSlot(null)} className="text-[13px] font-semibold text-brand-700 hover:underline">
                  ← Change time
                </button>
                <p className="rounded-xl bg-paper p-3 text-sm font-semibold">
                  {format(parseISO(slot), "EEEE, MMMM d · h:mm a")} – {format(addMinutes(parseISO(slot), info.link.durationMin), "h:mm a")}
                </p>
                <Field label="Full name">
                  <input required value={name} onChange={(e) => setName(e.target.value)} className="field" autoComplete="name" />
                </Field>
                <Field label="Email" hint="Use the email address you applied with.">
                  <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="field" autoComplete="email" />
                </Field>
                <Field label="Anything we should know? (optional)">
                  <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className="field resize-none" />
                </Field>
                <Button type="submit" variant="primary" size="lg" className="w-full" disabled={submitting}>
                  {submitting ? "Booking…" : "Confirm booking"}
                </Button>
              </form>
            )}
          </section>
        </div>
      )}
    </Shell>
  );
}

function Shell({ orgName, children }: { orgName: string; children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-paper px-4 py-8 sm:py-14">
      <div className="mx-auto max-w-3xl">
        {orgName && (
          <div className="mb-4 flex items-center gap-2 text-sm font-bold">
            <Avatar name={orgName} color="#143f28" size={28} /> {orgName} · Careers
          </div>
        )}
        <div className="card overflow-hidden">{children}</div>
      </div>
    </div>
  );
}
