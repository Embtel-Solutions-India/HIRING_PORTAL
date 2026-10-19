import { ArrowUpRight, CalendarPlus, Mail, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useCan, useJobMap, useStageMap, useStore } from "../data/store";
import { daysSince, fullName } from "../lib/utils";
import { ContactRow, MoveStageMenu, ResumePreview, SummaryCard } from "./candidate";
import { ComposeEmailModal } from "./ComposeEmailModal";
import { ScheduleInterviewModal } from "./ScheduleInterviewModal";
import { SourceBadge, SourcePicker } from "./SourcePicker";
import { Avatar, Button, Drawer, IconButton, StageBadge, Stars, Tabs } from "./ui";

/** Quick look at one application (a card on the board) and the person behind it. */
export function CandidateQuickView({ applicationId, onClose }: { applicationId: string | null; onClose: () => void }) {
  const app = useStore((s) => s.applications.find((a) => a.id === applicationId));
  const candidate = useStore((s) => (app ? s.candidates.find((c) => c.id === app.candidateId) : undefined));
  const setRating = useStore((s) => s.setRating);
  const setCandidateSource = useStore((s) => s.setCandidateSource);
  const canTag = useCan("candidates.tagSource");
  const stageMap = useStageMap();
  const jobMap = useJobMap();
  const canNote = useCan("candidates.addNote");
  const canEmail = useCan("emails.sendSingle");
  const [tab, setTab] = useState<"summary" | "resume">("summary");
  const [emailOpen, setEmailOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);

  return (
    <>
      <Drawer open={!!candidate && !!app} onClose={onClose} label="Candidate quick view" width={760}>
        {candidate && app && (
          <>
            <header className="border-b border-line bg-surface px-5 pt-4">
              <div className="flex items-start gap-3">
                <Avatar name={fullName(candidate)} size={44} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-lg font-bold tracking-tight">{fullName(candidate)}</h2>
                    <StageBadge stage={stageMap[app.stageId]} />
                    <SourceBadge sourceId={candidate.sourceId} muted={false} />
                  </div>
                  <p className="text-sm text-muted">
                    {candidate.currentTitle}
                    {candidate.currentCompany && ` at ${candidate.currentCompany}`} · applied for <b className="font-semibold text-ink-2">{jobMap[app.jobId]?.title}</b>
                  </p>
                </div>
                <IconButton label="Close" onClick={onClose}>
                  <X size={18} />
                </IconButton>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <MoveStageMenu applicationIds={[app.id]} currentStageId={app.stageId} size="sm" />
                <Button size="sm" icon={<CalendarPlus size={14} />} onClick={() => setScheduleOpen(true)}>
                  Schedule
                </Button>
                {canEmail && (
                  <Button size="sm" icon={<Mail size={14} />} onClick={() => setEmailOpen(true)}>
                    Email
                  </Button>
                )}
                <span className="ml-auto flex items-center gap-3">
                  <Stars value={app.rating} onChange={canNote ? (v) => setRating(app.id, v) : undefined} />
                  <Link to={`/candidates/${candidate.id}`} onClick={onClose} className="inline-flex items-center gap-0.5 text-[13px] font-semibold text-brand-700 hover:underline">
                    Full profile <ArrowUpRight size={14} />
                  </Link>
                </span>
              </div>
              <Tabs
                className="mt-2 -mb-px border-b-0"
                value={tab}
                onChange={setTab}
                tabs={[
                  { value: "summary", label: "Summary" },
                  { value: "resume", label: "Resume" },
                ]}
              />
            </header>
            <div className="scroll-slim min-h-0 flex-1 overflow-y-auto">
              {tab === "summary" ? (
                <div className="space-y-4 p-5">
                  <ContactRow candidate={candidate} />
                  <SummaryCard candidate={candidate} app={app} />
                  <div className="card p-4 text-[13px] text-ink-2">
                    <p className="label mb-2">At a glance</p>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
                      <div>
                        <dt className="text-[11px] text-muted">Source</dt>
                        <dd className="mt-0.5">
                          {canTag ? <SourcePicker variant="badge" value={candidate.sourceId} onChange={(id) => setCandidateSource([candidate.id], id)} /> : <SourceBadge sourceId={candidate.sourceId} />}
                        </dd>
                      </div>
                      <Info k="In stage" v={`${daysSince(app.stageEnteredAt)} days`} />
                      <Info k="Applied" v={`${daysSince(app.appliedAt)} days ago`} />
                      <Info k="Notes" v={`${candidate.notes.length}`} />
                      <Info k="Tags" v={candidate.tags.join(", ") || "—"} />
                    </dl>
                  </div>
                </div>
              ) : (
                <div className="h-full">
                  <ResumePreview candidate={candidate} />
                </div>
              )}
            </div>
          </>
        )}
      </Drawer>
      {candidate && app && (
        <>
          <ComposeEmailModal open={emailOpen} onClose={() => setEmailOpen(false)} recipientIds={[candidate.id]} />
          <ScheduleInterviewModal open={scheduleOpen} onClose={() => setScheduleOpen(false)} candidateId={candidate.id} applicationId={app.id} />
        </>
      )}
    </>
  );
}

function Info({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-[11px] text-muted">{k}</dt>
      <dd className="font-semibold text-ink">{v}</dd>
    </div>
  );
}
