import { addDays, addWeeks, format, isSameDay, isToday, parseISO, startOfWeek } from "date-fns";
import { CalendarPlus, ChevronLeft, ChevronRight, Copy, ExternalLink, Link2, MapPin, Pencil, Phone, Plus, Trash2, Video } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { FeedbackForm } from "../components/FeedbackForm";
import { ScheduleInterviewModal } from "../components/ScheduleInterviewModal";
import { Avatar, AvatarStack, Badge, Button, CalendarMark, EmptyState, Field, Modal, PageHeader, Segmented, Select, Tabs, Toggle } from "../components/ui";
import { useCan, useJobMap, useStore, useTeamMap } from "../data/store";
import type { BookingLink, Interview, InterviewType } from "../types";
import { cn, fmtDayLabel, fmtTime, fullName, uid } from "../lib/utils";

const HOURS = Array.from({ length: 10 }, (_, i) => 8 + i); // 8am – 5pm rows
const ROW_H = 56;

const TYPE_ICON: Record<InterviewType, React.ReactNode> = { phone: <Phone size={12} />, video: <Video size={12} />, onsite: <MapPin size={12} /> };

export default function Interviews() {
  const interviews = useStore((s) => s.interviews);
  const settings = useStore((s) => s.settings);
  const [tab, setTab] = useState<"calendar" | "list" | "links">("calendar");
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const canSchedule = useCan("interviews.schedule");
  const canLinks = useCan("interviews.manageBookingLinks");
  const upcoming = interviews.filter((i) => i.status === "scheduled" && parseISO(i.start) > new Date()).length;
  const needsFeedback = interviews.filter((i) => i.status === "completed" && !i.feedback?.length).length;

  return (
    <>
      <PageHeader
        title="Interviews"
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <CalendarMark size={14} /> {settings.google.connected ? `Synced with Google Calendar (${settings.google.calendarId})` : "Google Calendar not connected"} · {upcoming} upcoming
          </span>
        }
        actions={
          canSchedule && (
            <Button variant="primary" icon={<CalendarPlus size={15} />} onClick={() => setScheduleOpen(true)}>
              Schedule interview
            </Button>
          )
        }
      />
      <Tabs
        className="mb-4"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "calendar", label: "Calendar" },
          { value: "list", label: "All interviews", count: needsFeedback || undefined },
          ...(canLinks ? [{ value: "links" as const, label: "Booking links" }] : []),
        ]}
      />
      {tab === "calendar" && <WeekCalendar onOpen={setOpenId} />}
      {tab === "list" && <InterviewList onOpen={setOpenId} />}
      {tab === "links" && <BookingLinks />}

      <ScheduleInterviewModal open={scheduleOpen} onClose={() => setScheduleOpen(false)} />
      <InterviewDetail id={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

function WeekCalendar({ onOpen }: { onOpen: (id: string) => void }) {
  const interviews = useStore((s) => s.interviews);
  const candidates = useStore((s) => s.candidates);
  const team = useStore((s) => s.team);
  const thisWeek = () => {
    const now = new Date();
    // On weekends, "this week" is the coming work week.
    return startOfWeek(now.getDay() === 0 || now.getDay() === 6 ? addDays(now, 2) : now, { weekStartsOn: 1 });
  };
  const [weekStart, setWeekStart] = useState(thisWeek);
  const [who, setWho] = useState("all");
  const [mobileDay, setMobileDay] = useState(() => new Date());
  const days = Array.from({ length: 5 }, (_, i) => addDays(weekStart, i));

  const visible = interviews.filter((i) => i.status !== "cancelled" && (who === "all" || i.interviewerIds.includes(who)));
  const byDay = (d: Date) => visible.filter((i) => isSameDay(parseISO(i.start), d));
  const candidateName = (id: string) => {
    const c = candidates.find((x) => x.id === id);
    return c ? fullName(c) : "Candidate";
  };

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <Button size="sm" onClick={() => setWeekStart(thisWeek())}>
          Today
        </Button>
        <span className="flex">
          <button className="rounded-lg p-1.5 text-muted hover:bg-sunken" onClick={() => setWeekStart((w) => addWeeks(w, -1))} aria-label="Previous week">
            <ChevronLeft size={18} />
          </button>
          <button className="rounded-lg p-1.5 text-muted hover:bg-sunken" onClick={() => setWeekStart((w) => addWeeks(w, 1))} aria-label="Next week">
            <ChevronRight size={18} />
          </button>
        </span>
        <h2 className="font-bold">
          {format(days[0]!, "MMM d")} – {format(days[4]!, "MMM d, yyyy")}
        </h2>
        <Select
          className="ml-auto"
          ariaLabel="Interviewer"
          value={who}
          onChange={setWho}
          options={[{ value: "all", label: "Everyone's interviews" }, ...team.filter((t) => t.status === "active").map((t) => ({ value: t.id, label: t.name }))]}
        />
      </div>

      {/* Desktop week grid */}
      <div className="hidden md:block">
        <div className="grid grid-cols-[56px_repeat(5,1fr)] border-b border-line">
          <div />
          {days.map((d) => (
            <div key={d.toISOString()} className="border-l border-line px-3 py-2">
              <p className={cn("text-[11px] font-semibold uppercase", isToday(d) ? "text-brand-600" : "text-muted")}>{format(d, "EEE")}</p>
              <p className={cn("text-lg font-bold", isToday(d) && "text-brand-700")}>{format(d, "d")}</p>
            </div>
          ))}
        </div>
        <div className="scroll-slim relative grid max-h-[620px] grid-cols-[56px_repeat(5,1fr)] overflow-y-auto pt-2">
          <div>
            {HOURS.map((h) => (
              <div key={h} style={{ height: ROW_H }} className="pr-2 text-right text-[11px] font-medium text-faint">
                <span className="relative -top-2">{format(new Date().setHours(h, 0), "h a")}</span>
              </div>
            ))}
          </div>
          {days.map((d) => (
            <div key={d.toISOString()} className={cn("relative border-l border-line", isToday(d) && "bg-brand-50/30")}>
              {HOURS.map((h) => (
                <div key={h} style={{ height: ROW_H }} className="border-t border-line/70" />
              ))}
              {isToday(d) && <NowLine />}
              {layoutDay(byDay(d)).map(({ iv, col, cols }) => {
                const s = parseISO(iv.start);
                const top = (s.getHours() - HOURS[0]! + s.getMinutes() / 60) * ROW_H;
                const height = Math.max(26, (iv.durationMin / 60) * ROW_H - 3);
                const past = s < new Date();
                return (
                  <button
                    key={iv.id}
                    onClick={() => onOpen(iv.id)}
                    style={{ top, height, left: `calc(${(col / cols) * 100}% + 4px)`, width: `calc(${100 / cols}% - 8px)` }}
                    className={cn(
                      "absolute overflow-hidden rounded-lg border-l-[3px] px-2 py-1 text-left text-[12px] transition hover:z-10 hover:shadow-pop",
                      past ? "border-line-strong bg-sunken text-muted" : iv.type === "onsite" ? "border-amber-500 bg-amber-50 text-amber-950" : "border-brand-600 bg-brand-50 text-brand-900",
                    )}
                  >
                    <p className="truncate font-bold">{candidateName(iv.candidateId)}</p>
                    {height > 34 && (
                      <p className="flex items-center gap-1 truncate opacity-75">
                        {TYPE_ICON[iv.type]} {fmtTime(iv.start)} · {iv.title}
                      </p>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Mobile agenda */}
      <div className="md:hidden">
        <div className="scroll-slim flex gap-1.5 overflow-x-auto px-3 py-3">
          {days.map((d) => (
            <button
              key={d.toISOString()}
              onClick={() => setMobileDay(d)}
              className={cn("flex w-14 shrink-0 flex-col items-center rounded-xl border py-1.5", isSameDay(d, mobileDay) ? "border-brand-700 bg-brand-700 text-white" : "border-line")}
            >
              <span className="text-[10px] font-semibold uppercase opacity-70">{format(d, "EEE")}</span>
              <span className="text-[17px] font-bold">{format(d, "d")}</span>
              <span className={cn("mt-0.5 size-1 rounded-full", byDay(d).length ? (isSameDay(d, mobileDay) ? "bg-lime" : "bg-brand-500") : "bg-transparent")} />
            </button>
          ))}
        </div>
        <ul className="divide-y divide-line border-t border-line">
          {byDay(mobileDay).length === 0 && <EmptyState icon={<CalendarPlus size={18} />} title="No interviews this day" />}
          {byDay(mobileDay).map((iv) => (
            <li key={iv.id}>
              <button onClick={() => onOpen(iv.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
                <span className="tabular w-16 text-sm font-bold">{fmtTime(iv.start)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{candidateName(iv.candidateId)}</span>
                  <span className="flex items-center gap-1 text-xs text-muted">
                    {TYPE_ICON[iv.type]} {iv.title} · {iv.durationMin}m
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Side-by-side columns for interviews that overlap in time (greedy column assignment per overlap cluster). */
function layoutDay(items: Interview[]) {
  const sorted = [...items].sort((a, b) => a.start.localeCompare(b.start));
  const out: { iv: Interview; col: number; cols: number }[] = [];
  let cluster: { iv: Interview; col: number; end: number }[] = [];
  let clusterEnd = 0;
  const flush = () => {
    const cols = Math.max(1, ...cluster.map((c) => c.col + 1));
    cluster.forEach((c) => out.push({ iv: c.iv, col: c.col, cols }));
    cluster = [];
  };
  for (const iv of sorted) {
    const start = parseISO(iv.start).getTime();
    const end = start + iv.durationMin * 60000;
    if (cluster.length && start >= clusterEnd) flush();
    const used = new Set(cluster.filter((c) => c.end > start).map((c) => c.col));
    let col = 0;
    while (used.has(col)) col++;
    cluster.push({ iv, col, end });
    clusterEnd = Math.max(clusterEnd, end);
  }
  flush();
  return out;
}

function NowLine() {
  const now = new Date();
  const top = (now.getHours() - HOURS[0]! + now.getMinutes() / 60) * ROW_H;
  if (top < 0 || top > HOURS.length * ROW_H) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 z-[5] flex items-center" style={{ top }}>
      <span className="-ml-1 size-2 rounded-full bg-danger" />
      <span className="h-px flex-1 bg-danger" />
    </div>
  );
}

function InterviewList({ onOpen }: { onOpen: (id: string) => void }) {
  const interviews = useStore((s) => s.interviews);
  const candidates = useStore((s) => s.candidates);
  const teamMap = useTeamMap();
  const jobMap = useJobMap();
  const [filter, setFilter] = useState<"upcoming" | "past" | "feedback">("upcoming");
  const list = useMemo(() => {
    const now = new Date();
    if (filter === "upcoming") return interviews.filter((i) => i.status === "scheduled" && parseISO(i.start) >= now);
    if (filter === "feedback") return interviews.filter((i) => i.status === "completed" && !i.feedback?.length);
    return interviews.filter((i) => parseISO(i.start) < now || i.status !== "scheduled").reverse();
  }, [interviews, filter]);

  return (
    <div className="card">
      <div className="border-b border-line px-4 py-3">
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: "upcoming", label: "Upcoming" },
            { value: "past", label: "Past" },
            { value: "feedback", label: "Needs feedback" },
          ]}
        />
      </div>
      {list.length === 0 ? (
        <EmptyState icon={<CalendarPlus size={18} />} title="Nothing here" />
      ) : (
        <ul className="divide-y divide-line">
          {list.map((iv) => {
            const c = candidates.find((x) => x.id === iv.candidateId);
            return (
              <li key={iv.id}>
                <button onClick={() => onOpen(iv.id)} className="flex w-full items-center gap-4 px-4 py-3 text-left hover:bg-paper">
                  <div className="w-24 shrink-0">
                    <p className="text-[11px] font-semibold text-muted uppercase">{fmtDayLabel(iv.start)}</p>
                    <p className="tabular text-sm font-bold">{fmtTime(iv.start)}</p>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{c ? fullName(c) : "—"}</p>
                    <p className="flex items-center gap-1 truncate text-xs text-muted">
                      {TYPE_ICON[iv.type]} {iv.title} · {jobMap[iv.jobId]?.title}
                    </p>
                  </div>
                  {iv.bookedVia && <Badge tone="lime">Self-booked</Badge>}
                  <AvatarStack members={iv.interviewerIds.map((id) => teamMap[id]!).filter(Boolean)} />
                  <Badge tone={iv.status === "scheduled" ? "info" : iv.status === "completed" ? (iv.feedback?.length ? "neutral" : "warn") : "danger"}>
                    {iv.status === "completed" && !iv.feedback?.length ? "feedback due" : iv.status.replace("_", "-")}
                  </Badge>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function InterviewDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const iv = useStore((s) => s.interviews.find((i) => i.id === id));
  const candidates = useStore((s) => s.candidates);
  const update = useStore((s) => s.updateInterview);
  const toast = useStore((s) => s.toast);
  const currentUserId = useStore((s) => s.currentUserId);
  const settings = useStore((s) => s.settings);
  const teamMap = useTeamMap();
  const jobMap = useJobMap();
  const canSchedule = useCan("interviews.schedule");
  const c = iv && candidates.find((x) => x.id === iv.candidateId);
  const upcoming = iv && iv.status === "scheduled" && parseISO(iv.start) > new Date();
  const mine = !!iv && !!currentUserId && iv.interviewerIds.includes(currentUserId);
  const alreadyGave = !!iv?.feedback?.some((f) => f.authorId === currentUserId);
  const canMark = canSchedule || mine;

  return (
    <Modal
      open={!!iv}
      onClose={onClose}
      title={iv?.title ?? ""}
      description={iv && `${fmtDayLabel(iv.start)} · ${fmtTime(iv.start)} · ${iv.durationMin} min`}
      footer={
        iv &&
        iv.status === "scheduled" &&
        canMark && (
          <>
            {canSchedule && (
              <Button
                variant="ghost"
                className="mr-auto text-danger"
                onClick={async () => {
                  if (!confirm("Cancel this interview? Everyone invited gets a cancellation from Google Calendar.")) return;
                  if (await update(iv.id, { status: "cancelled" })) toast(settings.google.connected ? "Interview cancelled · calendar event removed" : "Interview cancelled");
                  onClose();
                }}
              >
                Cancel interview
              </Button>
            )}
            <Button onClick={() => update(iv.id, { status: "no_show" })}>Mark no-show</Button>
            <Button variant="primary" onClick={() => update(iv.id, { status: "completed" })}>
              Mark completed
            </Button>
          </>
        )
      }
    >
      {iv && c && (
        <div className="space-y-4">
          <Link to={`/candidates/${c.id}`} onClick={onClose} className="flex items-center gap-3 rounded-xl border border-line p-3 hover:border-line-strong">
            <Avatar name={fullName(c)} size={38} />
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">{fullName(c)}</span>
              <span className="block truncate text-xs text-muted">
                {c.currentTitle} · {jobMap[c.jobId]?.title}
              </span>
            </span>
            <ExternalLink size={15} className="text-muted" />
          </Link>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="label">Type</dt>
              <dd className="mt-1 flex items-center gap-1.5 font-semibold capitalize">
                {TYPE_ICON[iv.type]} {iv.type === "video" ? "Google Meet" : iv.type}
              </dd>
            </div>
            <div>
              <dt className="label">Status</dt>
              <dd className="mt-1 font-semibold capitalize">{iv.status.replace("_", "-")}</dd>
            </div>
            <div className="col-span-2">
              <dt className="label">Interviewers</dt>
              <dd className="mt-1.5 flex flex-wrap gap-2">
                {iv.interviewerIds.map((i) => (
                  <span key={i} className="inline-flex items-center gap-1.5 text-[13px] font-medium">
                    <Avatar name={teamMap[i]?.name ?? "?"} color={teamMap[i]?.avatarColor} size={22} /> {teamMap[i]?.name}
                  </span>
                ))}
              </dd>
            </div>
          </dl>
          {iv.meetLink && upcoming && (
            <a href={iv.meetLink} target="_blank" rel="noreferrer" className="flex h-10 items-center justify-center gap-2 rounded-lg bg-brand-700 text-sm font-semibold text-white hover:bg-brand-800">
              <Video size={16} /> Join Google Meet
            </a>
          )}
          {iv.location && (
            <p className="flex items-center gap-1.5 text-sm text-ink-2">
              <MapPin size={14} className="text-muted" /> {iv.location}
            </p>
          )}

          {(iv.feedback?.length || (mine && iv.status !== "cancelled")) && (
            <div className="space-y-3 border-t border-line pt-4">
              <p className="label">Scorecard</p>
              {iv.feedback?.map((f, i) => (
                <div key={i} className="rounded-lg bg-paper p-3 text-[13px]">
                  <b>{teamMap[f.authorId]?.name}</b> · <span className="capitalize">{f.recommendation.replace("_", " ")}</span>
                  <p className="mt-1 text-ink-2">{f.comment}</p>
                </div>
              ))}
              {mine && !alreadyGave && iv.status !== "cancelled" && <FeedbackForm interviewId={iv.id} />}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function BookingLinks() {
  const links = useStore((s) => s.bookingLinks);
  const upsert = useStore((s) => s.upsertBookingLink);
  const remove = useStore((s) => s.deleteBookingLink);
  const toast = useStore((s) => s.toast);
  const teamMap = useTeamMap();
  const canManage = useCan("interviews.manageBookingLinks");
  const [editing, setEditing] = useState<BookingLink | null>(null);
  const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">Calendly-style links candidates use to self-book. Slots are computed from each host's Google Calendar free/busy, and bookings create the event + Meet link automatically.</p>
        {canManage && (
          <Button
            icon={<Plus size={15} />}
            onClick={() =>
              setEditing({ id: uid("bl"), slug: "new-link", title: "New booking link", durationMin: 30, type: "video", hostIds: [], days: [1, 2, 3, 4, 5], startHour: 9, endHour: 17, bufferMin: 15, active: true, bookings: 0 })
            }
          >
            New link
          </Button>
        )}
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {links.map((l) => {
          const url = `${window.location.origin}/book/${l.slug}`;
          return (
            <div key={l.id} className={cn("card flex flex-col p-4", !l.active && "opacity-60")}>
              <div className="flex items-start gap-3">
                <span className="flex size-10 items-center justify-center rounded-xl bg-brand-50 text-brand-700">{TYPE_ICON[l.type]}</span>
                <div className="min-w-0 flex-1">
                  <p className="font-bold">{l.title}</p>
                  <p className="text-xs text-muted">
                    {l.durationMin} min · {l.days.map((d) => DAY[d]).join(", ")} · {l.startHour}:00–{l.endHour}:00
                  </p>
                </div>
                {canManage && <Toggle checked={l.active} onChange={(v) => upsert({ ...l, active: v })} label="Active" />}
              </div>
              <div className="mt-3 flex items-center gap-2">
                <AvatarStack members={l.hostIds.map((h) => teamMap[h]!).filter(Boolean)} />
                <span className="text-xs text-muted">{l.hostIds.map((h) => teamMap[h]?.name.split(" ")[0]).join(", ") || "No hosts"}</span>
                <span className="tabular ml-auto text-xs font-semibold text-ink-2">{l.bookings} booked</span>
              </div>
              <div className="mt-3 flex items-center gap-1 rounded-lg bg-paper p-1 pl-2.5">
                <Link2 size={13} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-2">/book/{l.slug}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Copy size={13} />}
                  onClick={() => {
                    navigator.clipboard?.writeText(url);
                    toast("Link copied", "info");
                  }}
                >
                  Copy
                </Button>
                <a href={`/book/${l.slug}`} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-[13px] font-semibold text-ink-2 hover:bg-sunken">
                  <ExternalLink size={13} /> Preview
                </a>
              </div>
              {canManage && (
                <div className="mt-2 flex justify-end gap-1">
                  <Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={() => setEditing(l)}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-danger"
                    icon={<Trash2 size={13} />}
                    onClick={() => {
                      remove(l.id);
                      toast("Booking link deleted");
                    }}
                  >
                    Delete
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <BookingLinkEditor
        key={editing?.id ?? "closed"}
        link={editing}
        onClose={() => setEditing(null)}
        onSave={async (l) => {
          if (!(await upsert(l))) return;
          setEditing(null);
          toast("Booking link saved");
        }}
      />
    </>
  );
}

function BookingLinkEditor({ link, onClose, onSave }: { link: BookingLink | null; onClose: () => void; onSave: (l: BookingLink) => void }) {
  const team = useStore((s) => s.team);
  const [draft, setDraft] = useState<BookingLink | null>(link);
  const DAY = ["S", "M", "T", "W", "T", "F", "S"];
  const set = (patch: Partial<BookingLink>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  return (
    <Modal
      open={!!link}
      onClose={onClose}
      title={link?.title === "New booking link" ? "New booking link" : "Edit booking link"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!draft?.title || !draft.hostIds.length} onClick={() => draft && onSave(draft)}>
            Save link
          </Button>
        </>
      }
    >
      {draft && (
        <div className="space-y-4">
          <Field label="Title">
            <input className="field" value={draft.title} onChange={(e) => set({ title: e.target.value })} />
          </Field>
          <Field label="URL" hint={`${window.location.origin}/book/${draft.slug}`}>
            <input className="field font-mono" value={draft.slug} onChange={(e) => set({ slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })} />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Duration">
              <Select ariaLabel="Duration" className="w-full" value={String(draft.durationMin)} onChange={(v) => set({ durationMin: Number(v) })} options={["15", "30", "45", "60", "90"].map((d) => ({ value: d, label: `${d} min` }))} />
            </Field>
            <Field label="Type">
              <Select
                ariaLabel="Type"
                className="w-full"
                value={draft.type}
                onChange={(v) => set({ type: v as InterviewType })}
                options={[
                  { value: "phone", label: "Phone" },
                  { value: "video", label: "Google Meet" },
                  { value: "onsite", label: "Onsite" },
                ]}
              />
            </Field>
            <Field label="Buffer">
              <Select ariaLabel="Buffer" className="w-full" value={String(draft.bufferMin)} onChange={(v) => set({ bufferMin: Number(v) })} options={["0", "10", "15", "30"].map((d) => ({ value: d, label: `${d} min` }))} />
            </Field>
          </div>
          <div>
            <span className="mb-1.5 block text-[13px] font-semibold text-ink-2">Available days & hours</span>
            <div className="flex flex-wrap items-center gap-1.5">
              {DAY.map((d, i) => (
                <button
                  key={i}
                  onClick={() => set({ days: draft.days.includes(i) ? draft.days.filter((x) => x !== i) : [...draft.days, i].sort() })}
                  className={cn("size-8 rounded-lg border text-[12px] font-bold", draft.days.includes(i) ? "border-brand-700 bg-brand-700 text-white" : "border-line text-muted")}
                  aria-pressed={draft.days.includes(i)}
                >
                  {d}
                </button>
              ))}
              <Select ariaLabel="From" className="ml-2" value={String(draft.startHour)} onChange={(v) => set({ startHour: Number(v) })} options={Array.from({ length: 12 }, (_, i) => ({ value: String(i + 7), label: `${i + 7}:00` }))} />
              <span className="text-muted">–</span>
              <Select ariaLabel="To" value={String(draft.endHour)} onChange={(v) => set({ endHour: Number(v) })} options={Array.from({ length: 12 }, (_, i) => ({ value: String(i + 10), label: `${i + 10}:00` }))} />
            </div>
          </div>
          <div>
            <span className="mb-1.5 block text-[13px] font-semibold text-ink-2">Hosts (round-robin)</span>
            <div className="flex flex-wrap gap-1.5">
              {team
                .filter((t) => t.status === "active")
                .map((m) => {
                  const on = draft.hostIds.includes(m.id);
                  return (
                    <button
                      key={m.id}
                      onClick={() => set({ hostIds: on ? draft.hostIds.filter((x) => x !== m.id) : [...draft.hostIds, m.id] })}
                      className={cn("inline-flex items-center gap-1.5 rounded-full border py-0.5 pr-2.5 pl-0.5 text-[12px] font-semibold", on ? "border-brand-600 bg-brand-50" : "border-line")}
                    >
                      <Avatar name={m.name} color={m.avatarColor} size={22} /> {m.name}
                    </button>
                  );
                })}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
