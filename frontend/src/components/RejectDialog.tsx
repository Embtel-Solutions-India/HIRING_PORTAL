import { useEffect, useState } from "react";
import { useStore } from "../data/store";
import { cn } from "../lib/utils";
import { Button, Modal } from "./ui";

/** Asks why, whenever cards are moved into a closed stage. Number keys 1–9 pick a reason; Enter confirms. */
export function RejectDialog() {
  const prompt = useStore((s) => s.rejectPrompt);
  const reasons = useStore((s) => s.rejectionReasons).filter((r) => r.active);
  const stage = useStore((s) => s.stages.find((st) => st.id === prompt?.stageId));
  const resolve = useStore((s) => s.resolveRejectPrompt);
  const [reasonId, setReasonId] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    setReasonId("");
    setNote("");
  }, [prompt]);

  useEffect(() => {
    if (!prompt) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "TEXTAREA") return;
      const n = Number(e.key);
      if (n >= 1 && n <= 9 && reasons[n - 1]) {
        e.preventDefault();
        setReasonId(reasons[n - 1]!.id);
      } else if (e.key === "Enter" && reasonId && (e.target as HTMLElement).tagName !== "BUTTON") {
        e.preventDefault();
        resolve({ reasonId, note });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prompt, reasons, reasonId, note, resolve]);

  const n = prompt?.applicationIds.length ?? 0;
  return (
    <Modal
      open={!!prompt}
      onClose={() => resolve(null)}
      title={`${stage?.name ?? "Not moving forward"} · ${n} candidate${n === 1 ? "" : "s"}`}
      description="Why? This is kept on the candidate's history."
      footer={
        <>
          <Button variant="ghost" onClick={() => resolve(null)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!reasonId} onClick={() => resolve({ reasonId, note })}>
            Confirm
          </Button>
        </>
      }
    >
      <div className="flex flex-wrap gap-2">
        {reasons.map((r, i) => (
          <button
            key={r.id}
            onClick={() => setReasonId(r.id)}
            aria-pressed={reasonId === r.id}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-semibold transition",
              reasonId === r.id ? "border-danger bg-danger/10 text-danger" : "border-line bg-surface text-ink-2 hover:border-line-strong",
            )}
          >
            {i < 9 && <span className="tabular text-[11px] text-faint">{i + 1}</span>}
            {r.label}
          </button>
        ))}
      </div>
      <textarea className="field mt-4 resize-y" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note (optional)" aria-label="Note" />
    </Modal>
  );
}
