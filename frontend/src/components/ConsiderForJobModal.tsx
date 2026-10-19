import { useState } from "react";
import { useStageMap, useStore } from "../data/store";
import type { Application, Candidate } from "../types";
import { cn, fullName } from "../lib/utils";
import { Button, Modal } from "./ui";

/** Starts a new application for an existing person; their earlier applications keep their outcome. */
export function ConsiderForJobModal({ candidate, apps, open, onClose, onAdded }: { candidate: Candidate; apps: Application[]; open: boolean; onClose: () => void; onAdded: (applicationId: string) => void }) {
  const jobs = useStore((s) => s.jobs).filter((j) => j.status === "open");
  const considerForJob = useStore((s) => s.considerForJob);
  const toast = useStore((s) => s.toast);
  const stageMap = useStageMap();
  const [jobId, setJobId] = useState("");
  const [saving, setSaving] = useState(false);
  const busy = (id: string) => apps.some((a) => a.jobId === id && stageMap[a.stageId]?.kind === "active");

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Consider ${fullName(candidate)} for another job`}
      description="Starts a new application in the first stage. Earlier applications and their history stay as they are."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!jobId || saving}
            onClick={async () => {
              setSaving(true);
              const id = await considerForJob(candidate.id, jobId);
              setSaving(false);
              if (!id) return;
              toast(`Added to ${jobs.find((j) => j.id === jobId)?.title}`);
              setJobId("");
              onAdded(id);
            }}
          >
            Add to job
          </Button>
        </>
      }
    >
      <ul className="max-h-[50vh] space-y-1.5 overflow-y-auto">
        {jobs.map((j) => {
          const inProcess = busy(j.id);
          const before = apps.some((a) => a.jobId === j.id) && !inProcess;
          return (
            <li key={j.id}>
              <button
                disabled={inProcess}
                onClick={() => setJobId(j.id)}
                aria-pressed={jobId === j.id}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-[13.5px] transition disabled:cursor-not-allowed disabled:opacity-50",
                  jobId === j.id ? "border-brand-600 bg-brand-50" : "border-line hover:border-line-strong",
                )}
              >
                <span className="min-w-0 flex-1 truncate font-semibold">{j.title}</span>
                <span className="text-xs text-muted">{inProcess ? "already in process" : before ? "applied before" : j.department}</span>
              </button>
            </li>
          );
        })}
        {!jobs.length && <li className="py-4 text-center text-sm text-muted">No open jobs</li>}
      </ul>
    </Modal>
  );
}
