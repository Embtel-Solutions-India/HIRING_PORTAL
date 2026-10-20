import { addDays, addMinutes, format, isSameDay, isWeekend, setHours, setMinutes, startOfDay } from "date-fns";
import { CalendarCheck, Copy, Link2, MapPin, Phone, Video } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useStageMap, useStore } from "../data/store";
import { preferredApp } from "../lib/pool";
import { api } from "../lib/api";
import type { InterviewType } from "../types";
import { cn, fullName } from "../lib/utils";
import { Avatar, Button, CalendarMark, Checkbox, Field, Modal, Segmented, Select, Tabs } from "./ui";

const TYPE_ICON: Record<InterviewType, React.ReactNode> = {
  phone: <Phone size={13} />,
  video: <Video size={13} />,
  onsite: <MapPin size={13} />,
};

type Busy = Record<string, { start: string; end: string }[]>;

export function ScheduleInterviewModal({ open, onClose, candidateId, applicationId }: { open: boolean; onClose: () => void; candidateId?: string; applicationId?: string }) {
  const candidates = useStore((s) => s.candidates);
  const applications = useStore((s) => s.applications);
  const stageMap = useStageMap();
  const team = useStore((s) => s.team);
  const bookingLinks = useStore((s) => s.bookingLinks);
  const settings = useStore((s) => s.settings);
  const schedule = useStore((s) => s.scheduleInterview);
  const sendEmail = useStore((s) => s.sendEmail);
  const toast = useStore((s) => s.toast);

  const [tab, setTab] = useState<"pick" | "link">("pick");
  const [cid, setCid] = useState(candidateId ?? "");
  const [title, setTitle] = useState("Interview · Round 1");
  const [type, setType] = useState<InterviewType>("video");
  const [duration, setDuration] = useState("45");
  const [interviewerIds, setInterviewerIds] = useState<string[]>([]);
  const [day, setDay] = useState<Date>(startOfDay(new Date()));
  const [slot, setSlot] = useState<Date | null>(null);
  const [notify, setNotify] = useState(true);
  const [linkId, setLinkId] = useState(bookingLinks.find((l) => l.active)?.id ?? "");
  const [busy, setBusy] = useState<{ map: Busy; source: "google" | "ats" } | null>(null);
  const [saving, setSaving] = useState(false);
  const [location, setLocation] = useState("");

  useEffect(() => {
    if (!open) return;
    setCid(candidateId ?? "");
    setSlot(null);
    setTab("pick");
    // No default: the scheduler is always invited to the event anyway, so they pick the real interviewers.
    setInterviewerIds([]);
    let d = startOfDay(addDays(new Date(), 1));
    while (isWeekend(d)) d = addDays(d, 1);
    setDay(d);
    setLinkId(bookingLinks.find((l) => l.active)?.id ?? "");
  }, [open]);

  // Real free/busy from Google Calendar (plus interviews already in the ATS) for the chosen day.
  useEffect(() => {
    if (!open || !interviewerIds.length) return setBusy(null);
    let cancelled = false;
    const from = startOfDay(day);
    const to = addDays(from, 1);
    api
      .get<{ busy: Busy; source: "google" | "ats" }>(`/api/calendar/busy?users=${interviewerIds.join(",")}&from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`)
      .then((r) => !cancelled && setBusy({ map: r.busy, source: r.source }))
      .catch(() => !cancelled && setBusy(null));
    return () => {
      cancelled = true;
    };
  }, [open, day, interviewerIds]);

  const days = useMemo(() => {
    const out: Date[] = [];
    let d = startOfDay(new Date());
    while (out.length < 10) {
      if (!isWeekend(d)) out.push(d);
      d = addDays(d, 1);
    }
    return out;
  }, []);

  const slots = useMemo(() => {
    const out: { at: Date; busy: string[] }[] = [];
    const len = Number(duration) * 60000;
    for (let h = 8; h < 18; h++) {
      for (const m of [0, 30]) {
        const at = setMinutes(setHours(day, h), m);
        const s = at.getTime();
        const busyIds = interviewerIds.filter((id) => (busy?.map[id] ?? []).some((b) => s < new Date(b.end).getTime() && s + len > new Date(b.start).getTime()));
        out.push({ at, busy: busyIds });
      }
    }
    return out;
  }, [day, interviewerIds, busy, duration]);

  const activeTeam = team.filter((t) => t.status === "active");
  const candidate = candidates.find((c) => c.id === cid);
  const link = bookingLinks.find((l) => l.id === linkId);
  const linkUrl = link ? `${window.location.origin}/book/${link.slug}${candidate ? `?c=${candidate.id}` : ""}` : "";

  const submit = async () => {
    const appId = (applicationId && candidate?.id === candidateId ? applicationId : undefined) ?? (candidate && preferredApp(applications.filter((a) => a.candidateId === candidate.id), stageMap)?.id);
    if (!candidate || !slot || !appId) return;
    setSaving(true);
    const ok = await schedule(
      { applicationId: appId, title, type, start: slot.toISOString(), durationMin: Number(duration), interviewerIds, location: type === "onsite" ? location || undefined : undefined },
      { notify },
    );
    setSaving(false);
    if (!ok) return;
    toast(
      settings.google.connected
        ? `Interview booked · Google Calendar invite sent to ${notify ? "candidate, interviewers & you · confirmation emailed to candidate" : "interviewers & you"}`
        : `Interview booked${notify ? " · confirmation emailed to candidate" : ""}`,
    );
    onClose();
  };

  const sendLink = async () => {
    if (!candidate || !link) return;
    setSaving(true);
    const ok = await sendEmail({
      recipientIds: [candidate.id],
      subject: `Pick a time: ${link.title}`,
      body: `Hi {{first_name}},\n\nPlease choose a time that works for you for a ${link.title.toLowerCase()}:\n${linkUrl}\n\nThanks,\n{{sender_name}}`,
    });
    setSaving(false);
    if (!ok) return;
    toast("Booking link emailed to candidate");
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={780}
      title="Schedule interview"
      description={
        <span className="inline-flex items-center gap-1.5">
          <CalendarMark size={14} /> {settings.google.connected ? `Creates a Google Calendar event · ${settings.google.calendarId}` : "Google Calendar not connected — the interview is saved in the ATS only"}
        </span>
      }
      footer={
        tab === "pick" ? (
          <>
            <label className="mr-auto flex items-center gap-2 text-[13px] font-medium text-ink-2">
              <Checkbox checked={notify} onChange={setNotify} label="Email candidate" /> Email the candidate a confirmation + invite
            </label>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!candidate || !slot || !interviewerIds.length || saving} onClick={submit} icon={<CalendarCheck size={15} />}>
              {slot ? `Book ${format(slot, "EEE h:mm a")}` : "Pick a time"}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!candidate || !link || saving || !candidate.email} onClick={sendLink} icon={<Link2 size={15} />}>
              Email booking link
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        <Field label="Candidate">
          <Select
            ariaLabel="Candidate"
            value={cid}
            onChange={setCid}
            className="w-full"
            options={[{ value: "", label: "Select a candidate…" }, ...candidates.map((c) => ({ value: c.id, label: `${fullName(c)} — ${c.currentTitle}` }))]}
          />
        </Field>

        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "pick", label: "Pick a time" },
            { value: "link", label: "Let candidate choose (booking link)" },
          ]}
        />

        {tab === "pick" ? (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto_auto]">
              <Field label="Title">
                <input value={title} onChange={(e) => setTitle(e.target.value)} className="field" />
              </Field>
              <div>
                <span className="mb-1.5 block text-[13px] font-semibold text-ink-2">Type</span>
                <Segmented
                  value={type}
                  onChange={setType}
                  options={[
                    { value: "phone", label: "Phone", icon: TYPE_ICON.phone },
                    { value: "video", label: "Meet", icon: TYPE_ICON.video },
                    { value: "onsite", label: "Onsite", icon: TYPE_ICON.onsite },
                  ]}
                />
              </div>
              <div>
                <span className="mb-1.5 block text-[13px] font-semibold text-ink-2">Duration</span>
                <Select
                  ariaLabel="Duration"
                  value={duration}
                  onChange={setDuration}
                  options={["15", "30", "45", "60", "90"].map((d) => ({ value: d, label: `${d} min` }))}
                />
              </div>
            </div>

            <div>
              <span className="mb-1.5 block text-[13px] font-semibold text-ink-2">Interviewers</span>
              <div className="flex flex-wrap gap-1.5">
                {activeTeam.map((m) => {
                  const on = interviewerIds.includes(m.id);
                  return (
                    <button
                      key={m.id}
                      onClick={() => setInterviewerIds((x) => (on ? x.filter((i) => i !== m.id) : [...x, m.id]))}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full border py-0.5 pr-2.5 pl-0.5 text-[12px] font-semibold transition",
                        on ? "border-brand-600 bg-brand-50 text-brand-800" : "border-line bg-surface text-ink-2 hover:border-line-strong",
                      )}
                    >
                      <Avatar name={m.name} color={m.avatarColor} size={22} />
                      {m.name.split(" ")[0]}

                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[13px] font-semibold text-ink-2">
                  Date & time{" "}
                  <span className="font-normal text-muted">
                    · {busy?.source === "google" ? "busy times from Google Calendar" : "busy times from scheduled interviews"} · your time zone
                  </span>
                </span>
                <span className="flex items-center gap-3 text-[11px] text-muted">
                  <span className="flex items-center gap-1">
                    <span className="size-2.5 rounded-sm border border-brand-200 bg-brand-50" /> Everyone free
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="size-2.5 rounded-sm bg-sunken" /> Busy
                  </span>
                </span>
              </div>
              <div className="scroll-slim -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-2">
                {days.map((d) => (
                  <button
                    key={d.toISOString()}
                    onClick={() => {
                      setDay(d);
                      setSlot(null);
                    }}
                    className={cn(
                      "flex w-14 shrink-0 flex-col items-center rounded-xl border py-1.5 transition",
                      isSameDay(d, day) ? "border-brand-700 bg-brand-700 text-white" : "border-line bg-surface hover:border-line-strong",
                    )}
                  >
                    <span className={cn("text-[10px] font-semibold uppercase", isSameDay(d, day) ? "text-white/70" : "text-muted")}>{format(d, "EEE")}</span>
                    <span className="text-[17px] font-bold">{format(d, "d")}</span>
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-10">
                {slots.map(({ at, busy }) => {
                  const past = at < new Date();
                  const disabled = past || busy.length > 0;
                  const selected = slot?.getTime() === at.getTime();
                  return (
                    <button
                      key={at.toISOString()}
                      disabled={disabled}
                      onClick={() => setSlot(at)}
                      title={busy.length ? `Busy: ${busy.map((id) => team.find((t) => t.id === id)?.name).join(", ")}` : undefined}
                      className={cn(
                        "tabular rounded-lg border py-1.5 text-[12px] font-semibold transition",
                        selected && "border-brand-700 bg-brand-700 text-white",
                        !selected && !disabled && "border-brand-200 bg-brand-50 text-brand-800 hover:border-brand-500",
                        disabled && "cursor-not-allowed border-transparent bg-sunken text-faint line-through decoration-faint/60",
                      )}
                    >
                      {format(at, "h:mm")}
                    </button>
                  );
                })}
              </div>
              {type === "onsite" && (
                <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Where? e.g. Main office, Room B" className="field mt-3" aria-label="Location" />
              )}
              {slot && (
                <p className="mt-2 text-[12px] text-muted">
                  {format(slot, "EEEE, MMM d · h:mm a")} – {format(addMinutes(slot, Number(duration)), "h:mm a")}
                  {type === "video" && settings.google.autoMeetLinks && " · Google Meet link added automatically"}
                </p>
              )}
            </div>
          </>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted">Send the candidate a Calendly-style link. They pick an open slot and the event lands on the host's Google Calendar automatically.</p>
            <div className="grid gap-2">
              {bookingLinks
                .filter((l) => l.active)
                .map((l) => (
                  <button
                    key={l.id}
                    onClick={() => setLinkId(l.id)}
                    className={cn("flex items-center gap-3 rounded-xl border p-3 text-left transition", linkId === l.id ? "border-brand-600 bg-brand-50" : "border-line bg-surface hover:border-line-strong")}
                  >
                    <span className="flex size-9 items-center justify-center rounded-lg bg-surface text-brand-700 ring-1 ring-line">{TYPE_ICON[l.type]}</span>
                    <span className="flex-1">
                      <span className="block text-sm font-bold">{l.title}</span>
                      <span className="block text-xs text-muted">
                        {l.durationMin} min · /book/{l.slug}
                      </span>
                    </span>
                  </button>
                ))}
            </div>
            {link && (
              <div className="flex items-center gap-2 rounded-lg border border-line bg-paper p-2 pl-3">
                <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{linkUrl}</span>
                <Button
                  size="sm"
                  icon={<Copy size={13} />}
                  onClick={() => {
                    navigator.clipboard?.writeText(linkUrl);
                    toast("Link copied", "info");
                  }}
                >
                  Copy
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
