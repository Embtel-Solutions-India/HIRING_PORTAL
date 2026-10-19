import { addDays, differenceInCalendarDays, endOfWeek, format, isToday, parseISO, startOfDay, startOfWeek, subDays } from "date-fns";
import { AlertTriangle, ArrowRight, CalendarPlus, ChevronRight, ClipboardCheck, Hand, Hourglass, MapPin, Phone, Tag, Upload, Video } from "lucide-react";
import { useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ScheduleInterviewModal } from "../components/ScheduleInterviewModal";
import { UploadResumeModal } from "../components/UploadResumeModal";
import { Avatar, AvatarStack, Button, DriveMark, EmptyState, Segmented, Select, StageBadge } from "../components/ui";
import { useCan, useCards, useCurrentUser, useJobMap, useSourceMap, useStageMap, useStore, useTeamMap } from "../data/store";
import type { Application, Candidate as Person, Interview, Stage } from "../types";
import { cn, daysSince, fmtDayLabel, fmtTime, fullName, timeAgo } from "../lib/utils";

/** One application with its person folded in (id = the person); every dashboard number counts applications. */
type Candidate = Application & Person & { applicationId: string };

type Range = 7 | 30 | 90;

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (n: number, total: number) => (total ? Math.round((n / total) * 100) : 0);
const ivEnd = (i: Interview) => parseISO(i.start).getTime() + i.durationMin * 60_000;
const needsFeedback = (i: Interview) => i.status !== "cancelled" && i.status !== "no_show" && ivEnd(i) < Date.now() && !i.feedback?.length;

export default function Dashboard() {
  const seesAll = useCan("candidates.viewAll");
  return seesAll ? <TeamDashboard /> : <InterviewerDashboard />;
}

/* ============================== Team dashboard ============================== */

function TeamDashboard() {
  const user = useCurrentUser()!;
  const cards = useCards();
  const candidates = useMemo<Candidate[]>(() => cards.map(({ app, candidate }) => ({ ...app, ...candidate, applicationId: app.id })), [cards]);
  const stages = useStore((s) => s.stages);
  const jobs = useStore((s) => s.jobs);
  const interviews = useStore((s) => s.interviews);
  const activity = useStore((s) => s.activity);
  const inbox = useStore((s) => s.driveInbox);
  const settings = useStore((s) => s.settings);
  const canUpload = useCan("resumes.upload");
  const canSchedule = useCan("interviews.schedule");

  const [jobId, setJobId] = useState("all");
  const [range, setRange] = useState<Range>(30);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);

  const d = useMemo(() => {
    const now = new Date();
    const since = subDays(now, range);
    const prevSince = subDays(now, range * 2);
    const scoped = candidates.filter((c) => jobId === "all" || c.jobId === jobId);
    const ids = new Set(scoped.map((c) => c.id));
    const kindOf = (c: Candidate) => stages.find((s) => s.id === c.stageId)?.kind;
    const ivs = interviews.filter((i) => ids.has(i.candidateId));

    const applied = scoped.filter((c) => parseISO(c.appliedAt) >= since);
    const appliedPrev = scoped.filter((c) => {
      const t = parseISO(c.appliedAt);
      return t >= prevSince && t < since;
    });
    const active = scoped.filter((c) => kindOf(c) === "active");
    const hiredAll = scoped.filter((c) => kindOf(c) === "hired");
    const hiredInRange = hiredAll.filter((c) => parseISO(c.stageEnteredAt) >= since);
    const hiredIdx = stages.findIndex((s) => s.kind === "hired");
    const offerStage = hiredIdx > 0 ? [...stages.slice(0, hiredIdx)].reverse().find((s) => s.kind === "active") : undefined;

    const weekStart = startOfWeek(now, { weekStartsOn: 1 });
    const weekEnd = endOfWeek(now, { weekStartsOn: 1 });
    const thisWeek = ivs.filter((i) => i.status !== "cancelled" && parseISO(i.start) >= weekStart && parseISO(i.start) <= weekEnd);
    const upcoming = ivs.filter((i) => i.status === "scheduled" && parseISO(i.start).getTime() > now.getTime()).sort((a, b) => a.start.localeCompare(b.start));

    return {
      scoped,
      ids,
      applied,
      appliedPrev,
      active,
      hiredAll,
      hiredInRange,
      offerStage,
      offers: offerStage ? scoped.filter((c) => c.stageId === offerStage.id) : [],
      thisWeek,
      todayCount: thisWeek.filter((i) => isToday(parseISO(i.start))).length,
      upcoming,
      feedbackDue: ivs.filter(needsFeedback),
      stuck: active.filter((c) => daysSince(c.stageEnteredAt) >= 7),
      timeToHire: Math.round(avg(hiredAll.map((c) => Math.max(0, differenceInCalendarDays(parseISO(c.stageEnteredAt), parseISO(c.appliedAt)))))),
      openJobs: jobs.filter((j) => j.status === "open").length,
    };
  }, [candidates, stages, jobs, interviews, jobId, range]);

  const firstStage = stages.find((s) => s.kind === "active");
  const waitingFirst = firstStage ? d.scoped.filter((c) => c.stageId === firstStage.id).length : 0;
  const failed = d.scoped.filter((c) => c.summary.status === "failed" && c.resume.driveFileId).length;
  const sourceMap = useSourceMap();
  const canTag = useCan("candidates.tagSource");
  const untagged = d.active.filter((c) => !sourceMap[c.sourceId]).length;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const job = jobs.find((j) => j.id === jobId);

  return (
    <div className="flex flex-col gap-3">
      {/* Header + the one filter row that scopes everything below */}
      <div className="mb-1 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[13px] font-medium text-muted">{format(new Date(), "EEEE, MMMM d")}</p>
          <h1 className="text-[26px] leading-tight font-extrabold tracking-[-0.02em]">
            {greeting}, {user.name.split(" ")[0]}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select ariaLabel="Job" className="w-[168px]" value={jobId} onChange={setJobId} options={[{ value: "all", label: "All jobs" }, ...jobs.map((j) => ({ value: j.id, label: j.title }))]} />
          <Segmented
            value={String(range) as "7" | "30" | "90"}
            onChange={(v) => setRange(Number(v) as Range)}
            options={[
              { value: "7", label: "7 days" },
              { value: "30", label: "30 days" },
              { value: "90", label: "90 days" },
            ]}
          />
          {canSchedule && (
            <Button icon={<CalendarPlus size={15} />} onClick={() => setScheduleOpen(true)}>
              Schedule
            </Button>
          )}
          {canUpload && (
            <Button variant="primary" icon={<Upload size={15} />} onClick={() => setUploadOpen(true)}>
              Add candidates
            </Button>
          )}
        </div>
      </div>

      {/* Headline numbers */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Active candidates" value={d.active.length} sub={jobId === "all" ? `across ${d.openJobs} open job${d.openJobs === 1 ? "" : "s"}` : (job?.location ?? "")} to="/pipeline" />
        <Kpi label={`New · last ${range} days`} value={d.applied.length} delta={d.applied.length - d.appliedPrev.length} sub={`vs. ${d.appliedPrev.length} in the prior ${range}d`} to="/candidates" />
        <Kpi label="Interviews" value={d.thisWeek.length} sub={`this week · ${d.todayCount} today · ${d.upcoming.filter((i) => parseISO(i.start) <= endOfWeek(new Date(), { weekStartsOn: 1 })).length} to come`} to="/interviews" />
        <Kpi label="Feedback due" value={d.feedbackDue.length} sub={d.feedbackDue.length ? "scorecards missing" : "all scorecards in"} warn={d.feedbackDue.length > 0} to="/interviews" />
        <Kpi label={`${d.offerStage?.name ?? "Offer"} stage`} value={d.offers.length} sub={d.offers.length ? `avg ${Math.round(avg(d.offers.map((c) => daysSince(c.stageEnteredAt))))}d waiting` : "no open offers"} to={d.offerStage ? `/pipeline?stage=${d.offerStage.id}` : "/pipeline"} />
        <Kpi label={`Hired · last ${range} days`} value={d.hiredInRange.length} sub={d.hiredAll.length ? `avg ${d.timeToHire}d to hire` : "no hires yet"} to="/pipeline" />
      </div>

      {/* Every stage, its own tile */}
      <div className="scroll-slim -mx-4 flex gap-3 overflow-x-auto px-4 pb-1 sm:-mx-6 sm:px-6 lg:mx-0 lg:grid lg:overflow-visible lg:px-0 lg:pb-0" style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))` }}>
        {stages.map((s) => (
          <StageTile key={s.id} stage={s} candidates={d.scoped.filter((c) => c.stageId === s.id)} total={d.scoped.length} jobId={jobId} />
        ))}
      </div>

      {/* Six cards, three columns — fits one screen on desktop */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:h-[clamp(340px,calc(100dvh-424px),620px)] xl:grid-cols-12 xl:grid-rows-[minmax(0,1fr)]">
        <div className="flex min-h-0 flex-col gap-3 xl:col-span-5">
          <Card title="Applications" subtitle={`${d.applied.length} in the last ${range} days`} className="h-[260px] xl:h-auto xl:flex-1">
            <ApplicationsChart candidates={d.scoped} range={range} />
          </Card>
          <Card title="Where candidates come from" subtitle={`Added in the last ${range} days · click a source to see them`} className="h-[240px] xl:h-auto xl:flex-1">
            <Sources candidates={d.applied} />
          </Card>
        </div>
        <div className="flex min-h-0 flex-col gap-3 xl:col-span-4">
          <Card title={jobId === "all" ? "Candidates by job" : "Candidates by owner"} subtitle="Current stage mix · hover for detail" className="h-[260px] xl:h-auto xl:flex-1">
            <Breakdown candidates={d.scoped} stages={stages} by={jobId === "all" ? "job" : "owner"} />
          </Card>
          <Card title="Recent activity" action={<Link to={user.role === "super_admin" ? "/settings" : "/candidates"} className="text-[12px] font-semibold text-brand-700 hover:underline">{user.role === "super_admin" ? "Audit log" : "All"}</Link>} className="h-[240px] xl:h-auto xl:flex-1">
            <ActivityFeed items={activity.filter((a) => jobId === "all" || (a.candidateId && d.ids.has(a.candidateId)))} />
          </Card>
        </div>
        <div className="flex min-h-0 flex-col gap-3 lg:col-span-2 xl:col-span-3">
          <Card title="Upcoming interviews" subtitle={`${d.upcoming.length} scheduled`} action={<Link to="/interviews" className="text-[12px] font-semibold text-brand-700 hover:underline">Calendar</Link>} className="h-[260px] xl:h-auto xl:flex-1">
            <UpcomingList items={d.upcoming.slice(0, 8)} candidates={candidates} />
          </Card>
          <Card title="Needs attention" className="xl:h-auto xl:flex-1">
            <AttentionList
              rows={[
                waitingFirst > 0 && { icon: <Hand size={15} />, tone: "lime", count: waitingFirst, label: `to review in ${firstStage?.name ?? "the first stage"}`, to: "/review" },
                d.stuck.length > 0 && { icon: <Hourglass size={15} />, tone: "warn", count: d.stuck.length, label: "stuck 7+ days in a stage", to: "/pipeline" },
                d.feedbackDue.length > 0 && { icon: <ClipboardCheck size={15} />, tone: "warn", count: d.feedbackDue.length, label: "interviews need a scorecard", to: "/interviews" },
                canUpload && settings.google.connected && inbox.length > 0 && { icon: <DriveMark size={14} />, tone: "neutral", count: inbox.length, label: "new resumes in Drive", onClick: () => setUploadOpen(true) },
                canTag && untagged > 0 && { icon: <Tag size={15} />, tone: "neutral", count: untagged, label: "active candidates have no source", to: "/candidates?source=none" },
                failed > 0 && { icon: <AlertTriangle size={15} />, tone: "warn", count: failed, label: "summaries failed", to: "/candidates" },
              ]}
            />
          </Card>
        </div>
      </div>

      <UploadResumeModal open={uploadOpen} onClose={() => setUploadOpen(false)} defaultJobId={jobId === "all" ? undefined : jobId} />
      <ScheduleInterviewModal open={scheduleOpen} onClose={() => setScheduleOpen(false)} />
    </div>
  );
}

/* ============================== Building blocks ============================== */

function Kpi({ label, value, sub, delta, warn, to }: { label: string; value: number | string; sub: string; delta?: number; warn?: boolean; to?: string }) {
  const body = (
    <>
      <p className="truncate text-[12.5px] font-semibold text-muted">{label}</p>
      <div className="mt-1 flex items-baseline gap-2">
        <span className={cn("tabular text-[28px] leading-none font-bold tracking-tight", warn && "text-warn")}>{value}</span>
        {delta !== undefined && delta !== 0 && (
          <span className={cn("text-[12px] font-bold", delta > 0 ? "text-brand-600" : "text-danger")}>
            {delta > 0 ? "▲" : "▼"} {Math.abs(delta)}
          </span>
        )}
      </div>
      <p className="mt-1.5 truncate text-[11.5px] text-faint">{sub}</p>
    </>
  );
  return to ? (
    <Link to={to} className="card block p-3.5 transition hover:border-line-strong hover:shadow-pop">
      {body}
    </Link>
  ) : (
    <div className="card p-3.5">{body}</div>
  );
}

function StageTile({ stage, candidates, total, jobId }: { stage: Stage; candidates: Candidate[]; total: number; jobId: string }) {
  const n = candidates.length;
  const days = Math.round(avg(candidates.map((c) => daysSince(c.stageEnteredAt))));
  const stuck = stage.kind === "active" ? candidates.filter((c) => daysSince(c.stageEnteredAt) >= 7).length : 0;
  const share = pct(n, total);
  return (
    <Link
      to={`/pipeline?stage=${stage.id}${jobId !== "all" ? `&job=${jobId}` : ""}`}
      className="card group relative w-[150px] shrink-0 overflow-hidden p-3 transition hover:border-line-strong hover:shadow-pop lg:w-auto"
      title={`${stage.name}: ${n} candidate${n === 1 ? "" : "s"} · ${share}% of all · avg ${days} days in stage`}
    >
      <span className="absolute inset-x-0 top-0 h-[3px]" style={{ background: stage.color }} />
      <p className="flex items-center gap-1.5 truncate text-[12px] font-semibold text-ink-2">
        <span className="size-2 shrink-0 rounded-full" style={{ background: stage.color }} />
        <span className="truncate">{stage.name}</span>
      </p>
      <div className="mt-1.5 flex items-center justify-between gap-1">
        <span className="tabular text-[24px] leading-none font-bold tracking-tight">{n}</span>
        {stuck > 0 && (
          <span className="tabular rounded bg-amber-50 px-1 py-px text-[10px] font-bold whitespace-nowrap text-amber-800" title={`${stuck} waiting 7+ days`}>
            {stuck} · 7d+
          </span>
        )}
      </div>
      {/* share-of-pipeline meter: the track is a light step of the same hue */}
      <div className="mt-2 h-1 overflow-hidden rounded-full" style={{ background: `${stage.color}22` }}>
        <div className="h-full rounded-full" style={{ width: `${share}%`, background: stage.color }} />
      </div>
      <p className="mt-1.5 flex items-center justify-between gap-1 text-[11px] text-muted">
        <span className="tabular">{share}%</span>
        <span className="tabular">{n ? `${days}d avg` : "—"}</span>
      </p>
    </Link>
  );
}

function Card({ title, subtitle, action, children, className }: { title: string; subtitle?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("card flex min-h-0 flex-col p-4", className)}>
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-[14px] font-bold">{title}</h2>
          {subtitle && <p className="truncate text-[11.5px] text-muted">{subtitle}</p>}
        </div>
        {action}
      </div>
      <div className="relative min-h-0 flex-1">{children}</div>
    </section>
  );
}

/* ---------- tooltip (values lead, labels follow) ---------- */

interface Tip {
  x: number;
  y: number;
  title: string;
  rows: { color?: string; label: string; value: string }[];
}

function useTip() {
  const ref = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const show = (e: MouseEvent | { currentTarget: Element }, t: Omit<Tip, "x" | "y">) => {
    const host = ref.current?.getBoundingClientRect();
    if (!host) return;
    const r = (e.currentTarget as Element).getBoundingClientRect();
    setTip({ ...t, x: r.left + r.width / 2 - host.left, y: r.top - host.top });
  };
  const node = tip && (
    <div
      className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full rounded-lg bg-ink px-2.5 py-1.5 text-white shadow-pop"
      style={{ left: Math.max(60, Math.min(tip.x, (ref.current?.clientWidth ?? 0) - 60)), top: tip.y - 6 }}
    >
      <p className="text-[10.5px] whitespace-nowrap text-white/60">{tip.title}</p>
      {tip.rows.map((r) => (
        <p key={r.label} className="flex items-center gap-1.5 text-[12px] whitespace-nowrap">
          {r.color && <span className="h-0.5 w-2.5 rounded" style={{ background: r.color }} />}
          <b className="tabular font-bold">{r.value}</b>
          <span className="text-white/70">{r.label}</span>
        </p>
      ))}
    </div>
  );
  return { ref, show, hide: () => setTip(null), node };
}

/* ---------- Applications over time (single series column chart) ---------- */

function ApplicationsChart({ candidates, range }: { candidates: Candidate[]; range: Range }) {
  const tip = useTip();
  const buckets = useMemo(() => {
    const today = startOfDay(new Date());
    const weekly = range === 90;
    const count = weekly ? 13 : range;
    const size = weekly ? 7 : 1;
    return Array.from({ length: count }, (_, i) => {
      const start = subDays(today, (count - 1 - i) * size + (size - 1));
      const end = addDays(start, size);
      const n = candidates.filter((c) => {
        const t = parseISO(c.appliedAt);
        return t >= start && t < end;
      }).length;
      return { start, end, n, label: weekly ? `Week of ${format(start, "MMM d")}` : format(start, "EEE, MMM d") };
    });
  }, [candidates, range]);
  const max = Math.max(1, ...buckets.map((b) => b.n));
  const nice = max <= 4 ? max : Math.ceil(max / 2) * 2;

  return (
    <div ref={tip.ref} className="flex h-full flex-col" onMouseLeave={tip.hide}>
      <div className="relative min-h-0 flex-1">
        {/* recessive hairline grid: top tick + baseline */}
        <span className="absolute inset-x-0 top-0 border-t border-line/80" />
        <span className="tabular absolute top-0 left-0 -translate-y-1/2 bg-surface pr-1 text-[10px] text-faint">{nice}</span>
        <div className="absolute inset-0 flex items-end gap-[2px] border-b border-line-strong pl-5">
          {buckets.map((b, i) => (
            <button
              key={i}
              type="button"
              className="group flex h-full min-w-0 flex-1 items-end justify-center focus:outline-none"
              onMouseEnter={(e) => tip.show(e, { title: b.label, rows: [{ label: b.n === 1 ? "application" : "applications", value: String(b.n), color: "var(--color-brand-600)" }] })}
              onFocus={(e) => tip.show(e, { title: b.label, rows: [{ label: "applications", value: String(b.n) }] })}
              onBlur={tip.hide}
              aria-label={`${b.label}: ${b.n} applications`}
            >
              <span
                className="block w-full max-w-[24px] rounded-t-[4px] bg-brand-600 transition group-hover:bg-brand-500 group-focus-visible:bg-brand-500"
                style={{ height: b.n ? `${Math.max(3, (b.n / nice) * 100)}%` : 0 }}
              />
            </button>
          ))}
        </div>
      </div>
      <div className="mt-1.5 flex justify-between pl-5 text-[10px] text-faint">
        <span>{format(buckets[0]!.start, "MMM d")}</span>
        <span>{format(buckets[Math.floor(buckets.length / 2)]!.start, "MMM d")}</span>
        <span>{range === 90 ? "This week" : "Today"}</span>
      </div>
      {tip.node}
    </div>
  );
}

/* ---------- Sources (single hue bars, sorted) ---------- */

function Sources({ candidates }: { candidates: Candidate[] }) {
  const tip = useTip();
  const sourceMap = useSourceMap();
  const navigate = useNavigate();
  const rows = useMemo(() => {
    const m = new Map<string, number>();
    candidates.forEach((c) => {
      const key = sourceMap[c.sourceId] ? c.sourceId : "none";
      m.set(key, (m.get(key) ?? 0) + 1);
    });
    // Most common first; "no source yet" always last.
    return [...m.entries()].sort((a, b) => (a[0] === "none" ? 1 : b[0] === "none" ? -1 : b[1] - a[1]));
  }, [candidates, sourceMap]);
  const max = Math.max(1, ...rows.map((r) => r[1]));
  if (!rows.length) return <p className="py-6 text-center text-sm text-muted">No applications in this period</p>;
  return (
    <div ref={tip.ref} className="scroll-slim h-full space-y-1 overflow-y-auto pr-1" onMouseLeave={tip.hide}>
      {rows.map(([id, n]) => {
        const s = sourceMap[id];
        const name = s?.name ?? "No source yet";
        return (
          <button
            key={id}
            type="button"
            onClick={() => navigate(`/candidates?source=${id}`)}
            className="grid w-full grid-cols-[112px_minmax(0,1fr)_56px] items-center gap-2 rounded-md py-0.5 text-left hover:bg-paper"
            onMouseEnter={(e) => tip.show(e, { title: name, rows: [{ label: `of ${candidates.length} applications`, value: `${n} · ${pct(n, candidates.length)}%` }] })}
            title={`See ${name} candidates`}
          >
            <span className="flex min-w-0 items-center gap-1.5 text-[12px] font-medium text-ink-2">
              <span className={cn("size-1.5 shrink-0 rounded-full", !s && "border border-dashed border-faint")} style={s ? { background: s.color } : undefined} />
              <span className={cn("truncate", !s && "text-muted")}>{name}</span>
            </span>
            <span className={cn("h-3 rounded-r-[4px]", s ? "bg-brand-500/85" : "bg-line-strong")} style={{ width: `${Math.max(4, (n / max) * 100)}%` }} />
            <span className="tabular text-right text-[12px] font-semibold text-ink">
              {n} <span className="font-normal text-faint">{pct(n, candidates.length)}%</span>
            </span>
          </button>
        );
      })}
      {tip.node}
    </div>
  );
}

/* ---------- Stage mix per job / per owner (stacked bars, 2px gaps) ---------- */

function Breakdown({ candidates, stages, by }: { candidates: Candidate[]; stages: Stage[]; by: "job" | "owner" }) {
  const jobMap = useJobMap();
  const teamMap = useTeamMap();
  const tip = useTip();
  const groups = useMemo(() => {
    const m = new Map<string, Candidate[]>();
    candidates.forEach((c) => {
      const key = by === "job" ? c.jobId : c.ownerId;
      m.set(key, [...(m.get(key) ?? []), c]);
    });
    return [...m.entries()]
      .map(([key, list]) => ({ key, name: by === "job" ? (jobMap[key]?.title ?? "No job") : (teamMap[key]?.name ?? "Unassigned"), list }))
      .sort((a, b) => b.list.length - a.list.length);
  }, [candidates, by, jobMap, teamMap]);
  const max = Math.max(1, ...groups.map((g) => g.list.length));
  if (!groups.length) return <EmptyState icon={<ArrowRight size={16} />} title="No candidates yet" />;

  return (
    <div ref={tip.ref} className="scroll-slim h-full space-y-2.5 overflow-y-auto pr-1" onMouseLeave={tip.hide}>
      {groups.map((g) => {
        const segs = stages.map((s) => ({ s, n: g.list.filter((c) => c.stageId === s.id).length })).filter((x) => x.n);
        return (
          <div key={g.key} className="grid grid-cols-[112px_minmax(0,1fr)_28px] items-center gap-2">
            <span className="truncate text-[12px] font-medium text-ink-2" title={g.name}>
              {g.name}
            </span>
            <span className="flex h-3 gap-[2px]" style={{ width: `${Math.max(8, (g.list.length / max) * 100)}%` }}>
              {segs.map(({ s, n }, i) => (
                <span
                  key={s.id}
                  className={cn("h-full transition hover:brightness-110", i === segs.length - 1 && "rounded-r-[4px]")}
                  style={{ flexGrow: n, flexBasis: 0, background: s.color }}
                  onMouseEnter={(e) =>
                    tip.show(e, {
                      title: g.name,
                      rows: segs.map((x) => ({ label: x.s.name, value: String(x.n), color: x.s.color })),
                    })
                  }
                />
              ))}
            </span>
            <span className="tabular text-right text-[12px] font-semibold">{g.list.length}</span>
          </div>
        );
      })}
      {tip.node}
    </div>
  );
}

/* ---------- Lists ---------- */

function UpcomingList({ items, candidates }: { items: Interview[]; candidates: Candidate[] }) {
  const teamMap = useTeamMap();
  if (!items.length) return <EmptyState icon={<CalendarPlus size={16} />} title="Nothing scheduled" />;
  return (
    <ul className="scroll-slim -mx-1 h-full space-y-0.5 overflow-y-auto pr-1">
      {items.map((iv) => {
        const c = candidates.find((x) => x.id === iv.candidateId);
        if (!c) return null;
        return (
          <li key={iv.id}>
            <Link to={`/candidates/${c.id}`} className="flex items-center gap-2.5 rounded-lg px-1 py-1.5 hover:bg-paper">
              <span className="w-[60px] shrink-0">
                <span className="block text-[10px] font-semibold text-muted uppercase">{fmtDayLabel(iv.start)}</span>
                <span className="tabular block text-[12.5px] font-bold">{fmtTime(iv.start)}</span>
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold">{fullName(c)}</span>
                <span className="flex items-center gap-1 truncate text-[11px] text-muted">
                  {iv.type === "video" ? <Video size={11} /> : iv.type === "phone" ? <Phone size={11} /> : <MapPin size={11} />}
                  {iv.title}
                </span>
              </span>
              <AvatarStack members={iv.interviewerIds.map((id) => teamMap[id]!).filter(Boolean).slice(0, 2)} size={20} />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

interface AttentionRow {
  icon: ReactNode;
  tone: "lime" | "warn" | "neutral";
  count: number;
  label: string;
  to?: string;
  onClick?: () => void;
}

function AttentionList({ rows }: { rows: (AttentionRow | false)[] }) {
  const navigate = useNavigate();
  const list = rows.filter(Boolean) as AttentionRow[];
  if (!list.length) return <p className="py-4 text-center text-sm text-muted">All clear — nothing waiting on you.</p>;
  return (
    <ul className="scroll-slim h-full space-y-1 overflow-y-auto">
      {list.map((r) => (
        <li key={r.label}>
          <button onClick={() => (r.onClick ? r.onClick() : r.to && navigate(r.to))} className="flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left hover:bg-paper">
            <span
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-lg",
                r.tone === "lime" && "bg-lime text-brand-900",
                r.tone === "warn" && "bg-amber-50 text-amber-700",
                r.tone === "neutral" && "bg-paper ring-1 ring-line",
              )}
            >
              {r.icon}
            </span>
            <span className="line-clamp-2 min-w-0 flex-1 text-[13px] leading-snug text-ink-2">
              <b className="tabular font-bold text-ink">{r.count}</b> {r.label}
            </span>
            <ChevronRight size={14} className="shrink-0 text-faint" />
          </button>
        </li>
      ))}
    </ul>
  );
}

function ActivityFeed({ items }: { items: { id: string; actorId: string; message: string; candidateId?: string; createdAt: string }[] }) {
  const teamMap = useTeamMap();
  if (!items.length) return <p className="py-4 text-center text-sm text-muted">No activity yet</p>;
  return (
    <ul className="scroll-slim h-full space-y-2.5 overflow-y-auto pr-1">
      {items.slice(0, 30).map((a) => {
        const actor = teamMap[a.actorId];
        const text = (
          <>
            <b className="font-semibold text-ink">{actor?.name.split(" ")[0] ?? "Candidate"}</b> {a.message}
          </>
        );
        return (
          <li key={a.id} className="flex gap-2">
            <Avatar name={actor?.name ?? "System"} color={actor?.avatarColor} size={20} className="mt-0.5" />
            <p className="min-w-0 flex-1 text-[12px] leading-snug text-ink-2">
              {a.candidateId ? (
                <Link to={`/candidates/${a.candidateId}`} className="hover:text-brand-700">
                  {text}
                </Link>
              ) : (
                text
              )}
              <span className="block text-[10.5px] text-faint">{timeAgo(a.createdAt)}</span>
            </p>
          </li>
        );
      })}
    </ul>
  );
}

/* ============================== Interviewer dashboard ============================== */

function InterviewerDashboard() {
  const user = useCurrentUser()!;
  const cards = useCards();
  const candidates = useMemo<Candidate[]>(() => cards.map(({ app, candidate }) => ({ ...app, ...candidate, applicationId: app.id })), [cards]);
  const interviews = useStore((s) => s.interviews);
  const stageMap = useStageMap();
  const jobMap = useJobMap();
  const mine = interviews.filter((i) => i.interviewerIds.includes(user.id) && i.status !== "cancelled");
  const upcoming = mine.filter((i) => i.status === "scheduled" && ivEnd(i) > Date.now()).sort((a, b) => a.start.localeCompare(b.start));
  const due = mine.filter((i) => needsFeedback(i) || (i.status === "completed" && !i.feedback?.some((f) => f.authorId === user.id)));
  const today = upcoming.filter((i) => isToday(parseISO(i.start)));
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  return (
    <div className="flex flex-col gap-3">
      <div className="mb-1">
        <p className="text-[13px] font-medium text-muted">{format(new Date(), "EEEE, MMMM d")}</p>
        <h1 className="text-[26px] leading-tight font-extrabold tracking-[-0.02em]">
          {greeting}, {user.name.split(" ")[0]}
        </h1>
      </div>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Kpi label="Interviews today" value={today.length} sub={today[0] ? `next at ${fmtTime(today[0].start)}` : "none today"} to="/interviews" />
        <Kpi label="Coming up" value={upcoming.length} sub="scheduled with you" to="/interviews" />
        <Kpi label="Feedback to give" value={due.length} sub={due.length ? "scorecards waiting" : "all done"} warn={due.length > 0} to="/review" />
        <Kpi label="Your candidates" value={candidates.length} sub="people you're interviewing" to="/review" />
      </div>
      <div className="grid grid-cols-1 gap-3 xl:h-[clamp(420px,calc(100dvh-300px),640px)] xl:grid-cols-3 xl:grid-rows-[minmax(0,1fr)]">
        <Card title="Your next interviews" className="h-[320px] xl:h-auto">
          <UpcomingList items={upcoming.slice(0, 10)} candidates={candidates} />
        </Card>
        <Card title="Feedback to give" subtitle="Open the candidate and press Give feedback" className="h-[320px] xl:h-auto">
          {due.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">You're all caught up.</p>
          ) : (
            <ul className="scroll-slim h-full space-y-1 overflow-y-auto">
              {due.map((iv) => {
                const c = candidates.find((x) => x.id === iv.candidateId);
                return (
                  c && (
                    <li key={iv.id}>
                      <Link to="/review" className="flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-paper">
                        <span className="flex size-7 items-center justify-center rounded-lg bg-amber-50 text-amber-700">
                          <ClipboardCheck size={15} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-semibold">{fullName(c)}</span>
                          <span className="block truncate text-[11px] text-muted">
                            {iv.title} · {fmtDayLabel(iv.start)}
                          </span>
                        </span>
                        <ChevronRight size={14} className="text-faint" />
                      </Link>
                    </li>
                  )
                );
              })}
            </ul>
          )}
        </Card>
        <Card title="Your candidates" action={<Link to="/review" className="text-[12px] font-semibold text-brand-700 hover:underline">Review</Link>} className="h-[320px] xl:h-auto">
          <ul className="scroll-slim h-full space-y-1 overflow-y-auto">
            {candidates.map((c) => (
              <li key={c.applicationId}>
                <Link to={`/candidates/${c.id}`} className="flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-paper">
                  <Avatar name={fullName(c)} size={28} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold">{fullName(c)}</span>
                    <span className="block truncate text-[11px] text-muted">{jobMap[c.jobId]?.title}</span>
                  </span>
                  <StageBadge stage={stageMap[c.stageId]} />
                </Link>
              </li>
            ))}
            {!candidates.length && <p className="py-6 text-center text-sm text-muted">No candidates assigned yet.</p>}
          </ul>
        </Card>
      </div>
    </div>
  );
}
