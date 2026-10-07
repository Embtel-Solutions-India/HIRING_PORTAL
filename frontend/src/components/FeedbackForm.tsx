import { useState } from "react";
import { useStore } from "../data/store";
import { cn } from "../lib/utils";
import { Button } from "./ui";

type Rec = "strong_yes" | "yes" | "no" | "strong_no";

const LABEL: Record<Rec, string> = { strong_yes: "Strong yes", yes: "Yes", no: "No", strong_no: "Strong no" };

export function FeedbackForm({ interviewId, onDone }: { interviewId: string; onDone?: () => void }) {
  const addFeedback = useStore((s) => s.addFeedback);
  const toast = useStore((s) => s.toast);
  const [rec, setRec] = useState<Rec | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!rec || !comment.trim()) return;
        setBusy(true);
        const ok = await addFeedback(interviewId, { recommendation: rec, comment: comment.trim() });
        setBusy(false);
        if (ok) {
          toast("Feedback submitted");
          setComment("");
          setRec(null);
          onDone?.();
        }
      }}
    >
      <div>
        <p className="mb-1.5 text-[13px] font-semibold text-ink-2">Would you hire this person?</p>
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
          {(Object.keys(LABEL) as Rec[]).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRec(r)}
              aria-pressed={rec === r}
              className={cn(
                "rounded-lg border px-2.5 py-2 text-[13px] font-semibold transition",
                rec === r ? (r.endsWith("yes") ? "border-brand-700 bg-brand-700 text-white" : "border-danger bg-danger text-white") : "border-line hover:border-line-strong",
              )}
            >
              {LABEL[r]}
            </button>
          ))}
        </div>
      </div>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        rows={4}
        placeholder="What stood out? Strengths, concerns, and anything the next interviewer should dig into."
        className="field resize-none"
        aria-label="Feedback"
      />
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={!rec || !comment.trim() || busy}>
          {busy ? "Submitting…" : "Submit feedback"}
        </Button>
      </div>
    </form>
  );
}
