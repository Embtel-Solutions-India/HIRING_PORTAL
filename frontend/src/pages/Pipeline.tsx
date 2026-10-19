import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { parseISO } from "date-fns";
import { CalendarClock, Clock, MailCheck, Search, Star } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { CandidateQuickView } from "../components/CandidateQuickView";
import { Avatar, Badge, Checkbox, MatchScore, PageHeader, Select, Stars } from "../components/ui";
import { useCan, useCards, useJobMap, useSourceMap, useStore, useTeamMap, type Card } from "../data/store";
import type { Stage } from "../types";
import { cn, daysSince, fullName, tint } from "../lib/utils";

export default function Pipeline() {
  const cards = useCards();
  const stages = useStore((s) => s.stages);
  const jobs = useStore((s) => s.jobs);
  const team = useStore((s) => s.team);
  const interviews = useStore((s) => s.interviews);
  const moveStage = useStore((s) => s.moveStage);
  const requestMove = useStore((s) => s.requestMove);
  const toast = useStore((s) => s.toast);
  const canMove = useCan("candidates.moveStage");
  const canEmail = useCan("emails.sendSingle");
  const [params, setParams] = useSearchParams();

  const jobId = params.get("job") ?? "all";
  const ownerId = params.get("owner") ?? "all";
  const sourceId = params.get("source") ?? "all";
  const sources = useStore((s) => s.sources);
  const focusStage = params.get("stage");
  const [q, setQ] = useState("");
  const [showClosed, setShowClosed] = useState(focusStage === "rejected");
  const [notify, setNotify] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const columnRefs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    if (focusStage) columnRefs.current[focusStage]?.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
  }, [focusStage]);

  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v === "all") next.delete(k);
    else next.set(k, v);
    next.delete("stage");
    setParams(next, { replace: true });
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 6 } }),
  );

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return cards.filter(
      ({ app, candidate: c }) =>
        (jobId === "all" || app.jobId === jobId) &&
        (ownerId === "all" || app.ownerId === ownerId) &&
        (sourceId === "all" || (sourceId === "none" ? !sources.some((s) => s.id === c.sourceId) : c.sourceId === sourceId)) &&
        (!term || [fullName(c), c.currentTitle, ...c.skills].join(" ").toLowerCase().includes(term)),
    );
  }, [cards, jobId, ownerId, sourceId, sources, q]);

  const upcomingByApplication = useMemo(() => {
    const m = new Set<string>();
    interviews.forEach((i) => i.status === "scheduled" && parseISO(i.start) > new Date() && m.add(i.applicationId));
    return m;
  }, [interviews]);

  const visibleStages = stages.filter((s) => showClosed || s.kind !== "closed");
  const active = activeId ? cards.find((c) => c.app.id === activeId) : null;

  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id));
  const onDragEnd = async (e: DragEndEvent) => {
    setActiveId(null);
    const id = String(e.active.id);
    const to = e.over?.id ? String(e.over.id) : null;
    const card = cards.find((x) => x.app.id === id);
    if (!card || !to || to === card.app.stageId) return;
    const from = card.app.stageId;
    const stage = stages.find((s) => s.id === to)!;
    // A closed stage asks for a reason first; cancelling leaves the card where it was.
    if (!(await requestMove([id], to, { notify: notify && canEmail }))) return;
    toast(`${fullName(card.candidate)} → ${stage.name}${notify && canEmail && stage.autoEmailTemplateId ? " · email sent" : ""}`, "success", {
      label: "Undo",
      onClick: () => moveStage([id], from),
    });
  };

  return (
    <>
      <PageHeader
        title="Pipeline"
        subtitle={`${filtered.length} candidates · drag cards between stages${canMove ? "" : " (view only)"}`}
        actions={
          canEmail && (
            <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-[13px] font-semibold text-ink-2 shadow-card">
              <Checkbox checked={notify} onChange={setNotify} label="Auto-email on stage change" />
              <MailCheck size={15} className="text-muted" /> Auto-email on move
            </label>
          )
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name or skill" className="field h-9 pl-9" aria-label="Filter board" />
        </div>
        <Select ariaLabel="Job" value={jobId} onChange={(v) => setParam("job", v)} options={[{ value: "all", label: "All jobs" }, ...jobs.map((j) => ({ value: j.id, label: j.title }))]} />
        <Select
          ariaLabel="Owner"
          value={ownerId}
          onChange={(v) => setParam("owner", v)}
          options={[{ value: "all", label: "All owners" }, ...team.filter((t) => t.status === "active").map((t) => ({ value: t.id, label: t.name }))]}
        />
        <Select
          ariaLabel="Source"
          value={sourceId}
          onChange={(v) => setParam("source", v)}
          options={[{ value: "all", label: "All sources" }, ...sources.filter((s) => s.active).map((s) => ({ value: s.id, label: s.name })), { value: "none", label: "No source yet" }]}
        />
        <label className="ml-auto flex cursor-pointer items-center gap-2 text-[13px] font-medium text-ink-2">
          <Checkbox checked={showClosed} onChange={setShowClosed} label="Show closed stage" /> Show “Not moving forward”
        </label>
      </div>

      <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setActiveId(null)}>
        <div className="scroll-slim -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:snap-none lg:px-8">
          {visibleStages.map((stage) => (
            <Column
              key={stage.id}
              stage={stage}
              ref={(el) => {
                columnRefs.current[stage.id] = el;
              }}
              highlighted={focusStage === stage.id}
              items={filtered.filter((c) => c.app.stageId === stage.id)}
              showJob={jobId === "all"}
              upcoming={upcomingByApplication}
              canDrag={canMove}
              onOpen={setOpenId}
            />
          ))}
        </div>
        <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" }}>
          {active && (
            <div className="w-[272px] rotate-[2deg]">
              <CardBody card={active} showJob={jobId === "all"} upcoming={upcomingByApplication.has(active.app.id)} lifted />
            </div>
          )}
        </DragOverlay>
      </DndContext>

      <CandidateQuickView applicationId={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

function Column({
  stage,
  items,
  showJob,
  upcoming,
  canDrag,
  onOpen,
  highlighted,
  ref,
}: {
  stage: Stage;
  items: Card[];
  showJob: boolean;
  upcoming: Set<string>;
  canDrag: boolean;
  onOpen: (id: string) => void;
  highlighted: boolean;
  ref: (el: HTMLDivElement | null) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  // Most recently worked-on first; starred and match score stay visible on the card but don't reorder it.
  const sorted = [...items].sort((a, b) => b.app.lastActivityAt.localeCompare(a.app.lastActivityAt));
  return (
    <div ref={ref} className="flex w-[288px] shrink-0 snap-start flex-col">
      <div className="mb-2 flex items-center gap-2 px-1">
        <span className="size-2.5 rounded-full" style={{ background: stage.color }} />
        <h3 className="text-[13px] font-bold">{stage.name}</h3>
        <span className="tabular rounded-md bg-sunken px-1.5 text-[11px] font-bold text-muted">{items.length}</span>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          "scroll-slim flex min-h-[140px] flex-1 flex-col gap-2 overflow-y-auto rounded-xl border p-2 transition lg:max-h-[calc(100dvh-260px)]",
          isOver ? "border-dashed" : "border-transparent",
          highlighted && !isOver && "ring-2 ring-offset-2 ring-offset-paper",
        )}
        style={{
          background: isOver ? tint(stage.color, 0.1) : tint(stage.color, 0.035),
          borderColor: isOver ? stage.color : undefined,
          ["--tw-ring-color" as string]: highlighted ? stage.color : undefined,
        }}
      >
        {sorted.map((c) => (
          <DraggableCard key={c.app.id} card={c} showJob={showJob} upcoming={upcoming.has(c.app.id)} disabled={!canDrag} onOpen={onOpen} />
        ))}
        {!items.length && <p className="py-8 text-center text-xs font-medium text-faint">Drop candidates here</p>}
      </div>
    </div>
  );
}

function DraggableCard({ card, showJob, upcoming, disabled, onOpen }: { card: Card; showJob: boolean; upcoming: boolean; disabled: boolean; onOpen: (id: string) => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: card.app.id, disabled });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={() => onOpen(card.app.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen(card.app.id);
        listeners?.onKeyDown?.(e);
      }}
      className={cn("touch-manipulation outline-none", isDragging && "opacity-30")}
      aria-label={`${fullName(card.candidate)}, open quick view`}
    >
      <CardBody card={card} showJob={showJob} upcoming={upcoming} />
    </div>
  );
}

function CardBody({ card: { app, candidate: c }, showJob, upcoming, lifted }: { card: Card; showJob: boolean; upcoming: boolean; lifted?: boolean }) {
  const jobMap = useJobMap();
  const teamMap = useTeamMap();
  const sourceMap = useSourceMap();
  const owner = teamMap[app.ownerId];
  const src = sourceMap[c.sourceId];
  const days = daysSince(app.stageEnteredAt);
  const pending = app.summary.status === "pending";
  return (
    <article
      className={cn(
        "cursor-grab rounded-xl border border-line bg-surface p-3 transition select-none active:cursor-grabbing",
        lifted ? "shadow-lift" : "shadow-card hover:border-line-strong hover:shadow-pop",
      )}
    >
      <div className="flex items-start gap-2.5">
        <Avatar name={fullName(c)} size={32} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1 truncate text-[13.5px] font-bold">
            {fullName(c)}
            {app.starred && <Star size={12} className="shrink-0 fill-amber-400 text-amber-400" />}
          </p>
          <p className="truncate text-xs text-muted">{c.currentTitle}</p>
        </div>
        {!pending && <MatchScore score={app.summary.matchScore} size={32} />}
      </div>
      {(showJob || src) && (
        <p className="mt-2 flex min-w-0 items-center gap-1.5 text-[12px] font-semibold text-ink-2">
          {showJob && <span className="truncate">{jobMap[app.jobId]?.title}</span>}
          {src && (
            <span className="inline-flex shrink-0 items-center gap-1 font-medium text-muted">
              {showJob && <span className="text-faint">·</span>}
              <span className="size-1.5 rounded-full" style={{ background: src.color }} />
              {src.name}
            </span>
          )}
        </p>
      )}
      <p className="mt-1.5 line-clamp-2 text-[12px] leading-snug text-muted">{pending ? "Summary generating…" : app.summary.headline}</p>
      <div className="mt-2.5 flex min-w-0 items-center gap-2">
        <Stars value={app.rating} size={11} />
        {upcoming ? (
          <Badge tone="info" className="min-w-0">
            <CalendarClock size={11} className="shrink-0" /> <span className="truncate">Interview</span>
          </Badge>
        ) : (
          c.tags.slice(0, 1).map((t) => (
            <Badge key={t} className="min-w-0">
              <span className="truncate">{t}</span>
            </Badge>
          ))
        )}
        <span className={cn("ml-auto flex shrink-0 items-center gap-1 text-[11px] font-semibold", days >= 7 ? "text-warn" : "text-faint")} title={`${days} days in stage`}>
          <Clock size={11} /> {days}d
        </span>
        {owner && <Avatar name={owner.name} color={owner.avatarColor} size={18} />}
      </div>
    </article>
  );
}
