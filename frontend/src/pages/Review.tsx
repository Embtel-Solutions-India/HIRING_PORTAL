import { AnimatePresence, motion, useDragControls, useMotionValue, useTransform, type PanInfo } from "motion/react";
import { ArrowUpRight, Check, ChevronLeft, ChevronRight, ClipboardCheck, FileText, Hand, MessageSquarePlus, PartyPopper, Sparkles, Star, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ContactRow, resumeUrl, ResumePreview, SummaryCard } from "../components/candidate";
import { prefetchDocx } from "../components/DocxViewer";
import { DuplicateBanner } from "../components/DuplicateBanner";
import { FeedbackForm } from "../components/FeedbackForm";
import { prefetchPdf } from "../components/PdfViewer";
import { SourceBadge } from "../components/SourcePicker";
import { Avatar, Badge, Button, Checkbox, Modal, Segmented, Select, StageBadge, Stars } from "../components/ui";
import { useCan, useCards, useCurrentUser, useJobMap, useStageMap, useStore, type Card } from "../data/store";
import type { Candidate } from "../types";
import { cn, daysSince, fmtDayLabel, fmtTime, fullName } from "../lib/utils";

const SWIPE_DISTANCE = 110;
const SWIPE_VELOCITY = 500;

const isTyping = (el: EventTarget | null) => {
  const t = el as HTMLElement | null;
  if (!t) return false;
  return t.tagName === "TEXTAREA" || t.isContentEditable || (t.tagName === "INPUT" && !["checkbox", "radio", "button"].includes((t as HTMLInputElement).type));
};

function prefetchResume(c: Candidate | undefined) {
  if (!c?.resume.driveFileId && !c?.resume.resumeFileId) return;
  const url = resumeUrl(c.id, "preview", c.resume.version);
  if (c.resume.mimeType.includes("wordprocessingml")) prefetchDocx(url);
  else if (c.resume.mimeType === "application/pdf" || c.resume.mimeType === "application/vnd.google-apps.document") prefetchPdf(url);
}

export default function Review() {
  const me = useCurrentUser()!;
  const cards = useCards();
  const stages = useStore((s) => s.stages);
  const jobs = useStore((s) => s.jobs);
  const interviews = useStore((s) => s.interviews);
  const requestMove = useStore((s) => s.requestMove);
  const toggleStar = useStore((s) => s.toggleStar);
  const setRating = useStore((s) => s.setRating);
  const addNote = useStore((s) => s.addNote);
  const toast = useStore((s) => s.toast);
  const stageMap = useStageMap();
  const canMove = useCan("candidates.moveStage");
  const canNote = useCan("candidates.addNote");
  const canEmail = useCan("emails.sendSingle");
  const seesAll = useCan("candidates.viewAll");

  const [jobId, setJobId] = useState("all");
  const [stageId, setStageId] = useState(seesAll ? "screening" : "all");
  const [sort, setSort] = useState<"match" | "newest" | "oldest" | "interview">(seesAll ? "match" : "interview");
  const [notify, setNotify] = useState(false);
  const [pane, setPane] = useState<"summary" | "resume">("summary");
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState(1);
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [feedbackFor, setFeedbackFor] = useState<string | null>(null);
  const deckRef = useRef<HTMLDivElement>(null);

  const myNextInterview = useCallback(
    (applicationId: string) => {
      const mine = interviews.filter((i) => i.applicationId === applicationId && i.interviewerIds.includes(me.id) && i.status !== "cancelled");
      return mine.find((i) => new Date(i.start) > new Date()) ?? mine[mine.length - 1];
    },
    [interviews, me.id],
  );

  // Snapshot the queue when filters change, so moving a candidate doesn't reshuffle the deck mid-review.
  const queueKey = `${jobId}|${stageId}|${sort}`;
  const [queueIds, setQueueIds] = useState<string[]>([]);
  const [snapKey, setSnapKey] = useState("");
  useEffect(() => {
    const matches = ({ app }: Card) => (jobId === "all" || app.jobId === jobId) && (stageId === "all" || app.stageId === stageId);
    if (snapKey === queueKey) {
      // Same filters: only append newcomers (e.g. resumes a teammate just imported) at the end.
      const extra = cards.filter((c) => !queueIds.includes(c.app.id) && matches(c));
      if (extra.length) setQueueIds((ids) => [...ids, ...extra.map((c) => c.app.id)]);
      return;
    }
    const ivTime = (c: Card) => {
      const iv = myNextInterview(c.app.id);
      return iv ? Math.abs(new Date(iv.start).getTime() - Date.now()) : Number.MAX_SAFE_INTEGER;
    };
    const list = cards.filter(matches);
    list.sort(({ app: a }, { app: b }) =>
      sort === "match"
        ? b.summary.matchScore - a.summary.matchScore
        : sort === "newest"
          ? b.appliedAt.localeCompare(a.appliedAt)
          : sort === "oldest"
            ? a.appliedAt.localeCompare(b.appliedAt)
            : 0,
    );
    if (sort === "interview") list.sort((a, b) => ivTime(a) - ivTime(b));
    setQueueIds(list.map((c) => c.app.id));
    setSnapKey(queueKey);
    setIndex(0);
    setDecisions({});
  }, [queueKey, cards, snapKey, queueIds, jobId, stageId, sort, myNextInterview]);

  const queue = useMemo(() => {
    const byId = new Map(cards.map((c) => [c.app.id, c]));
    return queueIds.flatMap((id) => byId.get(id) ?? []);
  }, [queueIds, cards]);
  const done = index >= queue.length;
  const current = queue[index];

  // Warm up the next and previous resumes so switching feels instant.
  useEffect(() => {
    prefetchResume(queue[index + 1]?.candidate);
    prefetchResume(queue[index - 1]?.candidate);
  }, [index, queue]);

  const go = useCallback(
    (delta: number) => {
      setDirection(delta >= 0 ? 1 : -1);
      setNote("");
      setNoteOpen(false);
      setIndex((i) => Math.max(0, Math.min(queue.length, i + delta)));
    },
    [queue.length],
  );
  const jump = (i: number) => {
    setDirection(i > index ? 1 : -1);
    setIndex(i);
  };

  const nextStageFor = (c: Card) => {
    const active = stages.filter((s) => s.kind !== "closed");
    const i = active.findIndex((s) => s.id === c.app.stageId);
    return i === -1 ? undefined : active[Math.min(i + 1, active.length - 1)];
  };
  const rejectStage = stages.find((s) => s.kind === "closed");

  // A second key press while the move is in flight would see the optimistic stage and move the same card again.
  const deciding = useRef(false);
  const decide = async (kind: "advance" | "reject") => {
    if (!current || !canMove || deciding.current) return;
    const target = kind === "advance" ? nextStageFor(current) : rejectStage;
    if (!target || target.id === current.app.stageId) return go(1);
    const from = current.app.stageId;
    const id = current.app.id;
    const name = current.candidate.firstName;
    deciding.current = true;
    const ok = await requestMove([id], target.id, { notify: notify && canEmail }).finally(() => (deciding.current = false));
    if (!ok) return;
    setDecisions((d) => ({ ...d, [id]: target.id }));
    toast(`${name} → ${target.name}`, "success", {
      label: "Undo",
      onClick: () => {
        void requestMove([id], from).then(
          (undone) =>
            undone &&
            setDecisions((d) => {
              const { [id]: _, ...rest } = d;
              return rest;
            }),
        );
      },
    });
    go(1);
  };

  // Keyboard: ← → anywhere on the page (except while typing or while a dialog is open).
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandler.current = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || document.querySelector('[role="dialog"]')) return;
    const t = e.target as HTMLElement;
    const key = e.key;
    const isNav = key === "ArrowRight" || key === "ArrowLeft" || key === "PageDown" || key === "PageUp";
    // A focused filter <select> would otherwise swallow the arrow keys.
    if (isNav && t.tagName === "SELECT") (t as HTMLSelectElement).blur();
    if (key === "ArrowRight" || key === "PageDown") {
      e.preventDefault();
      go(1);
    } else if (key === "ArrowLeft" || key === "PageUp") {
      e.preventDefault();
      go(-1);
    } else if (key === "Home") {
      e.preventDefault();
      jump(0);
    } else if (key.toLowerCase() === "a" && canMove) void decide("advance");
    else if (key.toLowerCase() === "r" && canMove) void decide("reject");
    else if (key.toLowerCase() === "s" && current && canNote) void toggleStar(current.app.id);
    else if (key.toLowerCase() === "f" && current && !canMove) {
      const iv = myNextInterview(current.app.id);
      if (iv) setFeedbackFor(iv.id);
    } else if (key === " " && current && t.tagName !== "BUTTON") {
      e.preventDefault();
      setPane((p) => (p === "summary" ? "resume" : "summary"));
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener("keydown", h);
    deckRef.current?.focus({ preventScroll: true }); // keys work immediately, no click needed
    return () => window.removeEventListener("keydown", h);
  }, []);

  const counter = queue.length ? `${Math.min(index + 1, queue.length)} / ${queue.length}` : "0 / 0";
  const advanced = Object.values(decisions).filter((s) => stageMap[s]?.kind !== "closed").length;
  const rejected = Object.values(decisions).filter((s) => stageMap[s]?.kind === "closed").length;
  const prev = queue[index - 1];
  const next = queue[index + 1];
  const currentIv = current ? myNextInterview(current.app.id) : undefined;
  const blurAfter = (fn: (v: string) => void) => (v: string) => {
    fn(v);
    (document.activeElement as HTMLElement | null)?.blur();
    deckRef.current?.focus({ preventScroll: true });
  };

  return (
    <div className="flex flex-col lg:h-[calc(100dvh-7rem)]">
      {/* Toolbar */}
      <div className="mb-3 flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="flex items-center gap-2 lg:mr-2">
          <h1 className="flex items-center gap-2 text-[22px] font-extrabold tracking-tight">
            <Hand size={20} className="text-brand-600" /> {seesAll ? "Swipe review" : "My candidates"}
          </h1>
          <span className="tabular ml-auto text-[13px] font-semibold text-muted lg:hidden">{counter}</span>
        </div>
        <div className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 [scrollbar-width:none] sm:-mx-6 sm:px-6 lg:mx-0 lg:flex-1 lg:px-0">
          <Select className="shrink-0" ariaLabel="Job" value={jobId} onChange={blurAfter(setJobId)} options={[{ value: "all", label: "All jobs" }, ...jobs.map((j) => ({ value: j.id, label: j.title }))]} />
          <Select className="shrink-0" ariaLabel="Stage" value={stageId} onChange={blurAfter(setStageId)} options={[{ value: "all", label: "All stages" }, ...stages.map((s) => ({ value: s.id, label: s.name }))]} />
          <Select
            className="shrink-0"
            ariaLabel="Sort"
            value={sort}
            onChange={blurAfter((v) => setSort(v as typeof sort))}
            options={[
              { value: "match", label: "Best match first" },
              { value: "interview", label: "Next interview first" },
              { value: "newest", label: "Newest first" },
              { value: "oldest", label: "Oldest first" },
            ]}
          />
          {canEmail && (
            <label className="flex shrink-0 cursor-pointer items-center gap-2 text-[13px] font-medium whitespace-nowrap text-ink-2">
              <Checkbox checked={notify} onChange={setNotify} label="Email candidates on decisions" /> Email on decisions
            </label>
          )}
          <span className="tabular ml-auto hidden text-[13px] font-semibold text-muted lg:inline">{counter}</span>
        </div>
      </div>

      {/* Progress: click any segment to jump */}
      <div className="mb-4 flex h-1.5 gap-0.5 overflow-hidden rounded-full">
        {queue.map((c, i) => (
          <button
            key={c.app.id}
            onClick={() => jump(i)}
            aria-label={`Go to ${fullName(c.candidate)}`}
            title={fullName(c.candidate)}
            className={cn(
              "h-full flex-1 transition hover:opacity-70",
              decisions[c.app.id] ? (stageMap[decisions[c.app.id]!]?.kind === "closed" ? "bg-danger/70" : "bg-brand-500") : i < index ? "bg-line-strong" : i === index ? "bg-ink" : "bg-sunken",
            )}
          />
        ))}
      </div>

      {/* Deck with side arrows */}
      <div
        ref={deckRef}
        tabIndex={-1}
        aria-label="Candidate cards. Use the left and right arrow keys to switch."
        className="relative h-[calc(100dvh-268px)] min-h-[460px] outline-none md:px-[72px] lg:h-auto lg:min-h-[560px] lg:flex-1"
      >
        <SideArrow side="left" disabled={index === 0} onClick={() => go(-1)} name={prev ? fullName(prev.candidate) : ""} />
        <SideArrow side="right" disabled={done} onClick={() => go(1)} name={next ? fullName(next.candidate) : current ? "Finish" : ""} />

        <div className="relative h-full">
          {done || !current ? (
            <AllDone total={queue.length} advanced={advanced} rejected={rejected} onRestart={() => jump(0)} empty={!queue.length} interviewer={!seesAll} />
          ) : (
            <>
              {[2, 1].map((offset) => {
                const c = queue[index + offset];
                if (!c) return null;
                return (
                  <div
                    key={c.app.id}
                    aria-hidden
                    className="absolute inset-0 rounded-2xl border border-line bg-surface shadow-card"
                    style={{ transform: `translateY(${offset * 10}px) scale(${1 - offset * 0.025})`, opacity: 1 - offset * 0.3 }}
                  />
                );
              })}
              <AnimatePresence initial={false} custom={direction} mode="popLayout">
                <SwipeCard key={current.app.id} card={current} direction={direction} onSwipe={go} pane={pane} setPane={setPane} decision={decisions[current.app.id]}>
                  <div className="flex flex-col gap-2 border-t border-line bg-paper/70 p-3 sm:flex-row sm:items-center sm:gap-3">
                    {canNote && (
                      <form
                        className={cn("flex-1 items-center gap-2", noteOpen ? "flex" : "hidden sm:flex")}
                        onSubmit={async (e) => {
                          e.preventDefault();
                          if (!note.trim()) return;
                          const body = note.trim();
                          setNote("");
                          if (await addNote(current.candidate.id, body, current.app.id)) toast("Note added");
                        }}
                      >
                        <MessageSquarePlus size={16} className="shrink-0 text-muted" />
                        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Quick note for the team… (Enter to save)" className="field h-9" aria-label="Quick note" />
                      </form>
                    )}
                    <div className="flex items-center gap-2">
                      {canNote && (
                        <button
                          onClick={() => setNoteOpen((o) => !o)}
                          className={cn("inline-flex size-9 shrink-0 items-center justify-center rounded-lg border sm:hidden", noteOpen ? "border-brand-600 bg-brand-50 text-brand-700" : "border-line bg-surface text-muted")}
                          aria-label="Add a note"
                        >
                          <MessageSquarePlus size={16} />
                        </button>
                      )}
                      <span className="hidden sm:inline-flex">
                        <Stars value={current.app.rating} onChange={canNote ? (v) => void setRating(current.app.id, v) : undefined} size={16} />
                      </span>
                      {canNote && (
                        <button
                          onClick={() => toggleStar(current.app.id)}
                          className={cn("inline-flex size-9 shrink-0 items-center justify-center rounded-lg border transition", current.app.starred ? "border-amber-300 bg-amber-50 text-amber-500" : "border-line bg-surface text-muted hover:text-ink")}
                          aria-label={current.app.starred ? "Unstar" : "Star"}
                          title="Star (S)"
                        >
                          <Star size={16} className={current.app.starred ? "fill-amber-400" : ""} />
                        </button>
                      )}
                      {canMove ? (
                        <>
                          <Button variant="secondary" onClick={() => decide("reject")} icon={<X size={16} />} className="flex-1 text-danger sm:flex-none" title="Not a fit (R)">
                            Not a fit
                          </Button>
                          <Button variant="primary" onClick={() => decide("advance")} icon={<Check size={16} />} className="flex-1 sm:flex-none" title="Advance (A)">
                            {nextStageFor(current) && nextStageFor(current)!.id !== current.app.stageId ? nextStageFor(current)!.name : "Advance"}
                          </Button>
                        </>
                      ) : (
                        currentIv && (
                          <Button variant="primary" onClick={() => setFeedbackFor(currentIv.id)} icon={<ClipboardCheck size={16} />} className="flex-1 sm:flex-none" title="Give feedback (F)">
                            Give feedback
                          </Button>
                        )
                      )}
                    </div>
                  </div>
                </SwipeCard>
              </AnimatePresence>
            </>
          )}
        </div>
      </div>

      {/* Hints + phone nav */}
      <div className="mt-4 flex items-center justify-center gap-3">
        <Button variant="secondary" size="lg" onClick={() => go(-1)} disabled={index === 0} icon={<ChevronLeft size={18} />} aria-label="Previous candidate" className="md:hidden" />
        <p className="hidden text-center text-xs text-muted md:block">
          <Kbd>←</Kbd> <Kbd>→</Kbd> or click the arrows to switch · <Kbd>Space</Kbd> resume/summary
          {canMove ? (
            <>
              {" "}
              · <Kbd>A</Kbd> advance · <Kbd>R</Kbd> not a fit
            </>
          ) : (
            <>
              {" "}
              · <Kbd>F</Kbd> feedback
            </>
          )}
          {canNote && (
            <>
              {" "}
              · <Kbd>S</Kbd> star
            </>
          )}
        </p>
        <p className="text-center text-xs text-muted md:hidden">Swipe left / right to switch</p>
        <Button variant="secondary" size="lg" onClick={() => go(1)} disabled={done} aria-label="Next candidate" className="md:hidden">
          <ChevronRight size={18} />
        </Button>
      </div>

      <Modal
        open={!!feedbackFor}
        onClose={() => setFeedbackFor(null)}
        title="Interview feedback"
        description={current ? `${fullName(current.candidate)}${currentIv ? ` · ${currentIv.title}, ${fmtDayLabel(currentIv.start)} ${fmtTime(currentIv.start)}` : ""}` : undefined}
      >
        {feedbackFor && <FeedbackForm interviewId={feedbackFor} onDone={() => setFeedbackFor(null)} />}
      </Modal>
    </div>
  );
}

function SideArrow({ side, disabled, onClick, name }: { side: "left" | "right"; disabled: boolean; onClick: () => void; name: string }) {
  const label = side === "left" ? "Previous candidate" : "Next candidate";
  return (
    <div className={cn("absolute top-1/2 z-20 hidden w-[60px] -translate-y-1/2 flex-col items-center gap-2 md:flex", side === "left" ? "left-0" : "right-0")}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={name ? `${label}: ${name}` : label}
        title={`${label} (${side === "left" ? "←" : "→"} key)`}
        className="flex size-14 items-center justify-center rounded-full border border-line bg-surface text-ink shadow-pop transition hover:scale-105 hover:border-brand-700 hover:bg-brand-700 hover:text-white active:scale-95 disabled:pointer-events-none disabled:opacity-30"
      >
        {side === "left" ? <ChevronLeft size={28} strokeWidth={2.5} /> : <ChevronRight size={28} strokeWidth={2.5} />}
      </button>
      {!disabled && name && <span className="line-clamp-2 text-center text-[10px] leading-tight font-semibold text-muted">{name}</span>}
    </div>
  );
}

// Exit direction comes from AnimatePresence's `custom`, so a card leaving "next" flies left and "previous" flies right.
const cardVariants = {
  enter: (d: number) => ({ x: d > 0 ? 260 : -260, opacity: 0, scale: 0.97 }),
  center: { x: 0, opacity: 1, scale: 1 },
  exit: (d: number) => ({ x: d > 0 ? -520 : 520, opacity: 0, rotate: d > 0 ? -6 : 6, transition: { duration: 0.24 } }),
};

function SwipeCard({
  card: { app, candidate: c },
  direction,
  onSwipe,
  pane,
  setPane,
  decision,
  children,
}: {
  card: Card;
  direction: number;
  onSwipe: (d: number) => void;
  pane: "summary" | "resume";
  setPane: (p: "summary" | "resume") => void;
  decision?: string;
  children: ReactNode;
}) {
  const stageMap = useStageMap();
  const jobMap = useJobMap();
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-320, 0, 320], [-6, 0, 6]);
  const nextHint = useTransform(x, [-140, -30], [1, 0]);
  const prevHint = useTransform(x, [30, 140], [0, 1]);
  const controls = useDragControls();

  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.x < -SWIPE_DISTANCE || info.velocity.x < -SWIPE_VELOCITY) onSwipe(1);
    else if (info.offset.x > SWIPE_DISTANCE || info.velocity.x > SWIPE_VELOCITY) onSwipe(-1);
  };

  return (
    <motion.div
      custom={direction}
      variants={cardVariants}
      initial="enter"
      animate="center"
      exit="exit"
      transition={{ type: "spring", damping: 30, stiffness: 320 }}
      drag="x"
      dragListener={false}
      dragControls={controls}
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.85}
      dragSnapToOrigin
      onDragEnd={onDragEnd}
      // Only touch/pen start a swipe. Mouse users click the arrows or use the keyboard, and can select text normally.
      onPointerDown={(e) => {
        if (e.pointerType !== "mouse" && !(e.target as HTMLElement).closest("button, a, input, textarea, select")) controls.start(e);
      }}
      style={{ x, rotate, touchAction: "pan-y" }}
      className="absolute inset-0 flex flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-pop"
    >
      <motion.div style={{ opacity: nextHint }} className="pointer-events-none absolute top-1/2 right-4 z-10 -translate-y-1/2 rounded-full bg-ink px-3 py-1.5 text-xs font-bold text-white shadow-pop">
        Next <ChevronRight size={13} className="inline" />
      </motion.div>
      <motion.div style={{ opacity: prevHint }} className="pointer-events-none absolute top-1/2 left-4 z-10 -translate-y-1/2 rounded-full bg-ink px-3 py-1.5 text-xs font-bold text-white shadow-pop">
        <ChevronLeft size={13} className="inline" /> Previous
      </motion.div>

      <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 sm:px-5">
        <Avatar name={fullName(c)} size={42} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-[18px] font-extrabold tracking-tight">{fullName(c)}</h2>
            <StageBadge stage={stageMap[app.stageId]} />
            <SourceBadge sourceId={c.sourceId} muted={false} />
            {decision && <Badge tone={stageMap[decision]?.kind === "closed" ? "danger" : "lime"}>Moved this session</Badge>}
          </div>
          <p className="truncate text-[13px] text-muted">
            {[c.currentTitle && `${c.currentTitle}${c.currentCompany ? ` · ${c.currentCompany}` : ""}`, jobMap[app.jobId] && `for ${jobMap[app.jobId]!.title}`, `applied ${daysSince(app.appliedAt)}d ago`]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="w-full lg:hidden [&>div]:flex [&>div]:w-full [&_button]:flex-1 [&_button]:justify-center">
          <Segmented
            value={pane}
            onChange={setPane}
            options={[
              { value: "summary", label: "Summary", icon: <Sparkles size={13} /> },
              { value: "resume", label: "Resume", icon: <FileText size={13} /> },
            ]}
          />
        </div>
        <Link to={`/candidates/${c.id}`} className="hidden items-center gap-0.5 text-[13px] font-semibold text-brand-700 hover:underline lg:inline-flex">
          Full profile <ArrowUpRight size={14} />
        </Link>
      </header>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[1.25fr_1fr]">
        <div className={cn("min-h-0 border-line lg:border-r", pane === "resume" ? "block" : "hidden lg:block")}>
          <ResumePreview candidate={c} compact />
        </div>
        <div className={cn("scroll-slim min-h-0 space-y-3 overflow-y-auto p-4 sm:p-5", pane === "summary" ? "block" : "hidden lg:block")}>
          <DuplicateBanner candidate={c} />
          <ContactRow candidate={c} />
          <SummaryCard candidate={c} app={app} />
          {c.notes.length > 0 && (
            <div className="card p-3">
              <p className="label mb-1.5">Latest note</p>
              <p className="text-[13px] leading-snug text-ink-2">“{c.notes[0]!.body}”</p>
            </div>
          )}
        </div>
      </div>
      {children}
    </motion.div>
  );
}

function AllDone({ total, advanced, rejected, onRestart, empty, interviewer }: { total: number; advanced: number; rejected: number; onRestart: () => void; empty: boolean; interviewer: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center rounded-2xl border border-dashed border-line-strong bg-surface p-10 text-center">
      <span className="flex size-14 items-center justify-center rounded-2xl bg-lime text-brand-900">
        <PartyPopper size={26} />
      </span>
      <h2 className="mt-4 text-xl font-extrabold tracking-tight">{empty ? "Nothing to review here" : "You're all caught up"}</h2>
      <p className="mt-1 max-w-sm text-sm text-muted">
        {empty
          ? interviewer
            ? "When a recruiter schedules you to interview someone, they'll show up here."
            : "No candidates match these filters. Try another job or stage."
          : interviewer
            ? `You went through all ${total} of your candidates.`
            : `You went through ${total} candidates — ${advanced} advanced, ${rejected} marked not a fit.`}
      </p>
      {!empty && (
        <Button className="mt-5" onClick={onRestart} icon={<ChevronLeft size={15} />}>
          Back to the first card
        </Button>
      )}
    </div>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line bg-surface px-1 py-px font-sans text-[10px] font-semibold text-ink-2">{children}</kbd>;
}
