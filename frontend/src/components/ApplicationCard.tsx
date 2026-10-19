import { ChevronDown } from "lucide-react";
import { useCan, useJobMap, useStageMap, useStore, useTeamMap } from "../data/store";
import type { Application, StageTransition } from "../types";
import { cn, daysSince, fmtDate, timeAgo } from "../lib/utils";
import { Badge, StageBadge } from "./ui";

/** One application on the profile: job, stage stepper, outcome and its full stage history. */
export function ApplicationCard({
  app,
  transitions,
  expanded,
  selected,
  onToggle,
  onSelect,
}: {
  app: Application;
  transitions: StageTransition[];
  expanded: boolean;
  selected: boolean;
  onToggle: () => void;
  onSelect: () => void;
}) {
  const stages = useStore((s) => s.stages);
  const moveStage = useStore((s) => s.moveStage);
  const requestMove = useStore((s) => s.requestMove);
  const toast = useStore((s) => s.toast);
  const stageMap = useStageMap();
  const jobMap = useJobMap();
  const teamMap = useTeamMap();
  const canMove = useCan("candidates.moveStage");
  const stepStages = stages.filter((s) => s.kind !== "closed");
  const currentIdx = stepStages.findIndex((s) => s.id === app.stageId);
  const closed = stageMap[app.stageId]?.kind === "closed";
  const job = jobMap[app.jobId];

  return (
    <section className={cn("rounded-xl border bg-surface", selected ? "border-brand-600 ring-1 ring-brand-600/30" : "border-line")}>
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <button onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={expanded}>
          <ChevronDown size={16} className={cn("shrink-0 text-muted transition", !expanded && "-rotate-90")} />
          <span className="truncate text-[14px] font-bold">{job?.title ?? "No job"}</span>
          <StageBadge stage={stageMap[app.stageId]} />
          <span className="text-xs text-muted">applied {fmtDate(app.appliedAt)}</span>
        </button>
        {app.outcome && (
          <Badge tone="danger">
            {app.outcome.reasonLabel || "Closed"}
            {teamMap[app.outcome.actorId] && ` · ${teamMap[app.outcome.actorId]!.name.split(" ")[0]}`}
          </Badge>
        )}
        {!selected && (
          <button onClick={onSelect} className="text-[12px] font-semibold text-brand-700 hover:underline">
            Work on this
          </button>
        )}
      </div>

      {expanded && (
        <div className="border-t border-line px-4 pt-3 pb-4">
          <ol className="scroll-slim flex gap-1 overflow-x-auto pb-1">
            {stepStages.map((s, i) => {
              const reached = !closed && i <= currentIdx;
              const isCurrent = s.id === app.stageId;
              return (
                <li key={s.id} className="min-w-[96px] flex-1">
                  <button
                    disabled={!canMove || isCurrent}
                    onClick={async () => {
                      const from = app.stageId;
                      if (await requestMove([app.id], s.id)) toast(`Moved to ${s.name}`, "success", { label: "Undo", onClick: () => moveStage([app.id], from) });
                    }}
                    className="group w-full text-left disabled:cursor-default"
                    title={isCurrent ? "Current stage" : `Move to ${s.name}`}
                  >
                    <span className={cn("block h-1.5 rounded-full transition", reached ? "" : "bg-sunken group-hover:bg-line-strong")} style={reached ? { background: s.color } : undefined} />
                    <span className={cn("mt-1.5 block truncate text-[12px] font-semibold", isCurrent ? "text-ink" : reached ? "text-ink-2" : "text-faint")}>{s.name}</span>
                    {isCurrent && <span className="block text-[11px] text-muted">{daysSince(app.stageEnteredAt)} days in stage</span>}
                  </button>
                </li>
              );
            })}
          </ol>

          <p className="label mt-4 mb-2">Stage history</p>
          <ol className="relative space-y-2.5 border-l border-line pl-4">
            {[...transitions].reverse().map((t) => (
              <li key={t.id} className="relative text-[13px] text-ink-2">
                <span className="absolute top-1.5 -left-[21px] size-2.5 rounded-full border-2 border-surface" style={{ background: stageMap[t.toStageId]?.color ?? "#999" }} />
                {t.fromStageId ? (
                  <>
                    {stageMap[t.fromStageId]?.name ?? t.fromStageId} → <b className="font-semibold text-ink">{stageMap[t.toStageId]?.name ?? t.toStageId}</b>
                  </>
                ) : (
                  <>
                    Entered at <b className="font-semibold text-ink">{stageMap[t.toStageId]?.name ?? t.toStageId}</b>
                  </>
                )}
                {t.reasonLabel && <span className="text-danger"> · {t.reasonLabel}</span>}
                <span className="block text-[11px] text-faint">
                  {teamMap[t.actorId]?.name ?? "System"} · {timeAgo(t.createdAt)} · {fmtDate(t.createdAt, "MMM d, yyyy h:mm a")}
                </span>
                {t.note && <p className="mt-0.5 rounded-md bg-paper px-2 py-1 text-[12.5px]">“{t.note}”</p>}
              </li>
            ))}
            {!transitions.length && <li className="text-[13px] text-muted">Loading…</li>}
          </ol>
        </div>
      )}
    </section>
  );
}
