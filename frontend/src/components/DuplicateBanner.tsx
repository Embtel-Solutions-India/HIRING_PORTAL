import { Users } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useCan, useStore } from "../data/store";
import type { Candidate } from "../types";
import { cn, fullName } from "../lib/utils";
import { Button } from "./ui";

/** Shown when this person's email or phone matches an older record: a recruiter decides whether they're the same. */
export function DuplicateBanner({ candidate, className }: { candidate: Candidate; className?: string }) {
  const other = useStore((s) => s.candidates.find((c) => c.id === candidate.possibleDuplicateOf));
  const otherApps = useStore((s) => s.applications.filter((a) => a.candidateId === candidate.possibleDuplicateOf).length);
  const keepSeparate = useStore((s) => s.keepSeparate);
  const merge = useStore((s) => s.mergeCandidate);
  const toast = useStore((s) => s.toast);
  const navigate = useNavigate();
  const canEdit = useCan("candidates.edit");
  const canMerge = useCan("candidates.moveStage");
  if (!other) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-[13px] text-amber-900", className)}>
      <Users size={15} className="shrink-0" />
      <span className="min-w-0 flex-1">
        Looks like{" "}
        <Link to={`/candidates/${other.id}`} className="font-bold underline">
          {fullName(other)}
        </Link>{" "}
        ({otherApps} application{otherApps === 1 ? "" : "s"}) — same email or phone.
      </span>
      {canMerge && (
        <Button
          size="sm"
          variant="primary"
          onClick={async () => {
            if (!confirm(`Merge ${fullName(candidate)} into ${fullName(other)}? Their applications, notes and interviews move over, and the newer resume is kept. This can't be undone.`)) return;
            if (!(await merge(candidate.id, other.id))) return;
            toast(`Merged into ${fullName(other)}`);
            navigate(`/candidates/${other.id}`);
          }}
        >
          Merge into {other.firstName}
        </Button>
      )}
      {canEdit && (
        <Button size="sm" variant="ghost" onClick={() => keepSeparate(candidate.id)}>
          Keep separate
        </Button>
      )}
    </div>
  );
}
