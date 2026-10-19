import { ArrowRight, Download, ExternalLink, FileText, Loader2, Mail, MapPin, Phone, RefreshCw, Sparkles, ThumbsDown, ThumbsUp } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { DocxViewer } from "./DocxViewer";
import { PdfViewer } from "./PdfViewer";
import { useCan, useStore } from "../data/store";
import type { Candidate } from "../types";
import { cn, fmtDate, fullName } from "../lib/utils";
import { Badge, Button, Checkbox, DriveMark, MatchScore, Menu, MenuItem } from "./ui";

export const resumeUrl = (candidateId: string, kind: "preview" | "download", version?: string) =>
  `/api/candidates/${candidateId}/resume/${kind}${version ? `?v=${encodeURIComponent(version)}` : ""}`;

/**
 * Resume viewer: the actual file (PDF rendered with pdf.js, Word shown as HTML), streamed through the API so
 * people don't need access to the Drive folder. "Parsed" shows the AI-extracted version.
 */
export function ResumePreview({ candidate, compact }: { candidate: Candidate; compact?: boolean }) {
  const canDownload = useCan("resumes.download");
  const hasFile = !!(candidate.resume.driveFileId || candidate.resume.resumeFileId);
  const isPdf = candidate.resume.mimeType === "application/pdf" || candidate.resume.mimeType === "application/vnd.google-apps.document";
  const isDocx = candidate.resume.mimeType.includes("wordprocessingml");
  const [mode, setMode] = useState<"file" | "parsed">(hasFile && (isPdf || isDocx) ? "file" : "parsed");
  const [fileError, setFileError] = useState("");
  const onError = useCallback((m: string) => setFileError(m), []);
  const canEdit = useCan("candidates.edit");
  const replaceResume = useStore((s) => s.replaceResume);
  const renameResume = useStore((s) => s.renameResume);
  const toast = useStore((s) => s.toast);
  const fileInput = useRef<HTMLInputElement>(null);
  const sync = candidate.resume.syncState;
  const editable = canEdit && candidate.resume.storage === "s3" && sync !== "conflict" && sync !== "pending_deletion";

  useEffect(() => {
    setFileError("");
    setMode(hasFile && (isPdf || isDocx) ? "file" : "parsed");
  }, [candidate.id, hasFile, isPdf, isDocx]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line bg-surface px-3 py-2">
        {candidate.resume.storage === "drive" ? <DriveMark size={15} /> : <FileText size={15} className="text-muted" />}
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{candidate.resume.fileName}</span>
        {(sync === "conflict" || sync === "failed" || sync === "pending_deletion") && (
          <Badge tone={sync === "failed" ? "danger" : "warn"}>{sync === "conflict" ? "sync conflict" : sync === "failed" ? "sync failed" : "pending deletion"}</Badge>
        )}
        {editable && (
          <>
            <input
              ref={fileInput}
              type="file"
              accept=".pdf,.docx"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f && (await replaceResume(candidate.id, f))) toast("Resume replaced");
              }}
            />
            <button onClick={() => fileInput.current?.click()} className="h-7 rounded-md px-2 text-[12px] font-semibold text-ink-2 hover:bg-sunken" title="Replace with a new file">
              Replace
            </button>
            <button
              onClick={async () => {
                const name = window.prompt("Rename resume", candidate.resume.fileName)?.trim();
                if (name && name !== candidate.resume.fileName && (await renameResume(candidate.id, name))) toast("Resume renamed");
              }}
              className="h-7 rounded-md px-2 text-[12px] font-semibold text-ink-2 hover:bg-sunken"
            >
              Rename
            </button>
          </>
        )}
        {hasFile && (isPdf || isDocx) && (
          <span className="flex rounded-md bg-sunken p-0.5 text-[11px] font-semibold">
            {(["file", "parsed"] as const).map((m) => (
              <button key={m} onClick={() => setMode(m)} className={cn("rounded px-2 py-0.5", mode === m ? "bg-surface text-ink shadow-card" : "text-muted hover:text-ink")}>
                {m === "file" ? "Original" : "Parsed"}
              </button>
            ))}
          </span>
        )}
        {candidate.resume.driveUrl && (
          <a href={candidate.resume.driveUrl} target="_blank" rel="noreferrer" className="hidden h-7 items-center gap-1 rounded-md px-2 text-[12px] font-semibold text-ink-2 hover:bg-sunken sm:inline-flex" title="Open in Google Drive (needs folder access)">
            <ExternalLink size={13} /> Drive
          </a>
        )}
        {hasFile && canDownload && (
          <a href={resumeUrl(candidate.id, "download", candidate.resume.version)} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-semibold text-ink-2 hover:bg-sunken" title="Download">
            <Download size={13} /> <span className="hidden sm:inline">Download</span>
          </a>
        )}
      </div>
      <div className={cn("scroll-slim flex-1 overflow-y-auto bg-sunken", compact ? "p-3" : "p-4 sm:p-6")}>
        {mode === "file" && !fileError ? (
          isPdf ? (
            <PdfViewer key={candidate.id} url={resumeUrl(candidate.id, "preview", candidate.resume.version)} onError={onError} />
          ) : (
            <DocxViewer key={candidate.id} url={resumeUrl(candidate.id, "preview", candidate.resume.version)} onError={onError} />
          )
        ) : (
          <ParsedResume candidate={candidate} compact={compact} notice={fileError} />
        )}
      </div>
    </div>
  );
}

function ParsedResume({ candidate, compact, notice }: { candidate: Candidate; compact?: boolean; notice?: string }) {
  const pending = candidate.summary.status === "pending";
  return (
    <article className={cn("resume-paper mx-auto max-w-[680px] rounded-sm text-[#222]", compact ? "px-5 py-6" : "px-7 py-8 sm:px-10 sm:py-10")}>
      {notice && <p className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-[12px] text-amber-900">{notice} — showing the parsed version.</p>}
      {pending ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center text-sm text-muted">
          <Loader2 className="animate-spin" />
          Reading the resume…
        </div>
      ) : (
        <>
          <header className="border-b border-[#ddd] pb-4">
            <h2 className="font-serif text-[26px] leading-tight font-bold tracking-tight">{fullName(candidate)}</h2>
            <p className="mt-0.5 text-[14px] text-[#555]">
              {candidate.currentTitle}
              {candidate.currentCompany && ` · ${candidate.currentCompany}`}
            </p>
            <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-[#666]">
              <span>{candidate.email}</span>
              <span>{candidate.phone}</span>
              <span>{candidate.location}</span>
            </p>
          </header>
          {candidate.experience.length === 0 && candidate.education.length === 0 && (
            <p className="mt-5 text-[13px] text-[#777]">No structured details yet. Switch to “Original” to read the resume.</p>
          )}
          {candidate.experience.length > 0 && (
            <section className="mt-5">
              <h3 className="text-[11px] font-bold tracking-[0.14em] text-[#888] uppercase">Experience</h3>
              <div className="mt-3 space-y-4">
                {candidate.experience.map((e, i) => (
                  <div key={i}>
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-[14px] font-bold">
                        {e.title} <span className="font-normal text-[#666]">— {e.company}</span>
                      </p>
                      <p className="text-[12px] text-[#888]">
                        {e.start} – {e.end}
                      </p>
                    </div>
                    <ul className="mt-1.5 list-disc space-y-1 pl-4 text-[13px] leading-relaxed text-[#333]">
                      {e.highlights.map((h, j) => (
                        <li key={j}>{h}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </section>
          )}
          {candidate.education.length > 0 && (
            <section className="mt-5">
              <h3 className="text-[11px] font-bold tracking-[0.14em] text-[#888] uppercase">Education</h3>
              {candidate.education.map((ed, i) => (
                <p key={i} className="mt-2 text-[13px]">
                  <span className="font-semibold">{ed.degree}</span> · {ed.school} <span className="text-[#888]">({ed.year})</span>
                </p>
              ))}
            </section>
          )}
          {candidate.skills.length > 0 && (
            <section className="mt-5">
              <h3 className="text-[11px] font-bold tracking-[0.14em] text-[#888] uppercase">Skills</h3>
              <p className="mt-2 text-[13px] leading-relaxed">{candidate.skills.join(" · ")}</p>
            </section>
          )}
        </>
      )}
    </article>
  );
}

export function SummaryCard({ candidate, className }: { candidate: Candidate; className?: string }) {
  const s = candidate.summary;
  const pending = s.status === "pending";
  const canRetry = useCan("candidates.edit");
  const resummarize = useStore((st) => st.resummarize);
  if (s.status === "failed") {
    return (
      <section className={cn("card p-4", className)}>
        <div className="flex items-start gap-3">
          <Sparkles size={16} className="mt-0.5 text-muted" />
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-bold">{s.headline}</p>
            <p className="mt-0.5 text-[13px] leading-snug text-muted">{s.overview}</p>
          </div>
          {canRetry && (
            <Button size="sm" icon={<RefreshCw size={13} />} onClick={() => resummarize(candidate.id)}>
              Retry
            </Button>
          )}
        </div>
        {candidate.skills.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {candidate.skills.map((sk) => (
              <Badge key={sk}>{sk}</Badge>
            ))}
          </div>
        )}
      </section>
    );
  }
  return (
    <section className={cn("card overflow-hidden", className)}>
      <div className="flex items-center gap-2 border-b border-line bg-gradient-to-r from-lime-soft/70 to-transparent px-4 py-2.5">
        <Sparkles size={15} className="text-brand-600" />
        <h3 className="text-[13px] font-bold">AI summary</h3>
        <span className="ml-auto text-[11px] text-muted">{pending ? "Generating…" : `Generated ${fmtDate(s.generatedAt, "MMM d")}`}</span>
      </div>
      {pending ? (
        <div className="space-y-2 p-4">
          {[90, 75, 82, 60].map((w, i) => (
            <div key={i} className="h-3 animate-pulse rounded bg-sunken" style={{ width: `${w}%` }} />
          ))}
        </div>
      ) : (
        <div className="space-y-4 p-4">
          <div className="flex items-start gap-3">
            <MatchScore score={s.matchScore} />
            <div className="min-w-0">
              <p className="text-[15px] leading-snug font-bold">{s.headline}</p>
              <p className="mt-0.5 text-xs text-muted">Match score vs. job requirements · {s.yearsExperience} yr{s.yearsExperience === 1 ? "" : "s"} experience</p>
            </div>
          </div>
          <p className="text-[13.5px] leading-relaxed text-ink-2">{s.overview}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <p className="label mb-1.5 flex items-center gap-1">
                <ThumbsUp size={12} /> Strengths
              </p>
              <ul className="space-y-1.5">
                {s.strengths.map((x) => (
                  <li key={x} className="flex gap-2 text-[13px] leading-snug">
                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-brand-500" />
                    {x}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="label mb-1.5 flex items-center gap-1">
                <ThumbsDown size={12} /> Watch-outs
              </p>
              <ul className="space-y-1.5">
                {s.concerns.map((x) => (
                  <li key={x} className="flex gap-2 text-[13px] leading-snug">
                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-amber-500" />
                    {x}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {candidate.skills.map((sk) => (
              <Badge key={sk}>{sk}</Badge>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

export function ContactRow({ candidate }: { candidate: Candidate }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-ink-2">
      {candidate.email && (
        <a href={`mailto:${candidate.email}`} className="inline-flex items-center gap-1.5 hover:text-brand-700">
          <Mail size={13} className="text-muted" /> {candidate.email}
        </a>
      )}
      {candidate.phone && (
        <a href={`tel:${candidate.phone.replace(/[^\d+]/g, "")}`} className="inline-flex items-center gap-1.5 hover:text-brand-700">
          <Phone size={13} className="text-muted" /> {candidate.phone}
        </a>
      )}
      {candidate.location && (
        <span className="inline-flex items-center gap-1.5">
          <MapPin size={13} className="text-muted" /> {candidate.location}
        </span>
      )}
      {!candidate.email && !candidate.phone && !candidate.location && <span className="text-muted">No contact details found in the resume</span>}
    </div>
  );
}

/** Stage picker used on detail pages, swipe review and bulk actions. */
export function MoveStageMenu({
  candidateIds,
  currentStageId,
  align = "left",
  label = "Move stage",
  size = "md",
  onMoved,
}: {
  candidateIds: string[];
  currentStageId?: string;
  align?: "left" | "right";
  label?: string;
  size?: "sm" | "md";
  onMoved?: (stageId: string) => void;
}) {
  const stages = useStore((s) => s.stages);
  const moveStage = useStore((s) => s.moveStage);
  const toast = useStore((s) => s.toast);
  const allowed = useCan("candidates.moveStage");
  const canEmail = useCan("emails.sendSingle");
  const [notify, setNotify] = useState(true);
  return (
    <Menu
      align={align}
      width={260}
      trigger={({ toggle }) => (
        <Button size={size} variant="primary" onClick={toggle} disabled={!allowed || candidateIds.length === 0} icon={<ArrowRight size={15} />}>
          {label}
        </Button>
      )}
    >
      {(close) => (
        <>
          {stages.map((st) => (
            <MenuItem
              key={st.id}
              active={st.id === currentStageId}
              onClick={() => {
                const prev = currentStageId;
                moveStage(candidateIds, st.id, { notify: notify && canEmail });
                toast(
                  `${candidateIds.length > 1 ? `${candidateIds.length} candidates` : "Candidate"} moved to ${st.name}${notify && canEmail && st.autoEmailTemplateId ? " · email sent" : ""}`,
                  "success",
                  prev && candidateIds.length === 1 ? { label: "Undo", onClick: () => moveStage(candidateIds, prev) } : undefined,
                );
                onMoved?.(st.id);
                close();
              }}
              icon={<span className="size-2.5 rounded-full" style={{ background: st.color }} />}
            >
              {st.name}
            </MenuItem>
          ))}
          {canEmail && (
            <label className="mt-1 flex cursor-pointer items-center gap-2 border-t border-line px-2.5 pt-2.5 pb-1.5 text-[12px] font-medium text-ink-2">
              <Checkbox checked={notify} onChange={setNotify} label="Notify candidate" />
              Email candidate the stage update
            </label>
          )}
        </>
      )}
    </Menu>
  );
}
