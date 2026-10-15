import { parseISO } from "date-fns";
import { ArrowLeft, CalendarPlus, ChevronLeft, ChevronRight, Mail, MapPin, MoreHorizontal, Phone, Star, Trash2, Video } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ContactRow, MoveStageMenu, ResumePreview, SummaryCard } from "../components/candidate";
import { ComposeEmailModal } from "../components/ComposeEmailModal";
import { ScheduleInterviewModal } from "../components/ScheduleInterviewModal";
import { Avatar, AvatarStack, Badge, Button, EmptyState, IconButton, Menu, MenuItem, StageBadge, Stars, Tabs } from "../components/ui";
import { SourceBadge, SourcePicker } from "../components/SourcePicker";
import { useCan, useJobMap, useSourceMap, useStageMap, useStore, useTeamMap } from "../data/store";
import { cn, daysSince, fmtDate, fmtDayLabel, fmtTime, fullName, timeAgo } from "../lib/utils";

export default function CandidateDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const candidates = useStore((s) => s.candidates);
  const stages = useStore((s) => s.stages);
  const interviews = useStore((s) => s.interviews);
  const campaigns = useStore((s) => s.campaigns);
  const activity = useStore((s) => s.activity);
  const addNote = useStore((s) => s.addNote);
  const setRating = useStore((s) => s.setRating);
  const toggleStar = useStore((s) => s.toggleStar);
  const moveStage = useStore((s) => s.moveStage);
  const deleteCandidates = useStore((s) => s.deleteCandidates);
  const toast = useStore((s) => s.toast);
  const stageMap = useStageMap();
  const sourceMap = useSourceMap();
  const setCandidateSource = useStore((s) => s.setCandidateSource);
  const canTag = useCan("candidates.tagSource");
  const jobMap = useJobMap();
  const teamMap = useTeamMap();
  const canNote = useCan("candidates.addNote");
  const canMove = useCan("candidates.moveStage");
  const canEmail = useCan("emails.sendSingle");
  const canDelete = useCan("candidates.delete");

  const [note, setNote] = useState("");
  const [tab, setTab] = useState<"notes" | "interviews" | "emails" | "activity">("notes");
  const [emailOpen, setEmailOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);

  const c = candidates.find((x) => x.id === id);
  const siblings = useMemo(() => (c ? candidates.filter((x) => x.jobId === c.jobId) : []), [candidates, c]);

  if (!c) {
    return <EmptyState icon={<ArrowLeft size={18} />} title="Candidate not found" action={<Button onClick={() => navigate("/candidates")}>Back to candidates</Button>} />;
  }

  const pos = siblings.findIndex((x) => x.id === c.id);
  const prev = siblings[pos - 1];
  const next = siblings[pos + 1];
  const myInterviews = interviews.filter((i) => i.candidateId === c.id);
  const myEmails = campaigns.filter((e) => e.recipientIds.includes(c.id));
  const myActivity = activity.filter((a) => a.candidateId === c.id);
  const stepStages = stages.filter((s) => s.kind !== "closed");
  const currentIdx = stepStages.findIndex((s) => s.id === c.stageId);
  const closed = stageMap[c.stageId]?.kind === "closed";

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-2">
        <Link to="/candidates" className="inline-flex items-center gap-1 text-[13px] font-semibold text-muted hover:text-ink">
          <ArrowLeft size={15} /> Candidates
        </Link>
        <div className="flex items-center gap-1 text-[12px] font-semibold text-muted">
          <span className="hidden sm:inline">
            {pos + 1} of {siblings.length} in {jobMap[c.jobId]?.title}
          </span>
          <IconButton label="Previous candidate" disabled={!prev} onClick={() => prev && navigate(`/candidates/${prev.id}`)}>
            <ChevronLeft size={18} />
          </IconButton>
          <IconButton label="Next candidate" disabled={!next} onClick={() => next && navigate(`/candidates/${next.id}`)}>
            <ChevronRight size={18} />
          </IconButton>
        </div>
      </div>

      {/* Header */}
      <section className="card p-5">
        <div className="flex flex-wrap items-start gap-4">
          <Avatar name={fullName(c)} size={56} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-[24px] leading-tight font-extrabold tracking-tight">{fullName(c)}</h1>
              <button onClick={() => toggleStar(c.id)} aria-label={c.starred ? "Unstar" : "Star"} className="rounded p-0.5">
                <Star size={18} className={c.starred ? "fill-amber-400 text-amber-400" : "text-line-strong hover:text-amber-400"} />
              </button>
              <StageBadge stage={stageMap[c.stageId]} />
              {canTag ? (
                <SourcePicker variant="badge" value={c.sourceId} onChange={async (id) => (await setCandidateSource([c.id], id)) && toast(id ? `Source set to ${sourceMap[id]?.name ?? "new source"}` : "Source cleared")} />
              ) : (
                <SourceBadge sourceId={c.sourceId} />
              )}
            </div>
            <p className="mt-0.5 text-sm text-muted">
              {[c.currentTitle && `${c.currentTitle}${c.currentCompany ? ` at ${c.currentCompany}` : ""}`, jobMap[c.jobId] ? `applied for ${jobMap[c.jobId]!.title}` : "", `added ${timeAgo(c.appliedAt)}`]
                .filter(Boolean)
                .join(" · ")}
            </p>
            <div className="mt-2.5">
              <ContactRow candidate={c} />
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <Stars value={c.rating} onChange={canNote ? (v) => setRating(c.id, v) : undefined} size={16} />
              {c.tags.map((t) => (
                <Badge key={t}>{t}</Badge>
              ))}
              {teamMap[c.ownerId] && <span className="text-xs text-muted">Owner: {teamMap[c.ownerId]!.name}</span>}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canEmail && (
              <Button icon={<Mail size={15} />} onClick={() => setEmailOpen(true)}>
                Email
              </Button>
            )}
            <Button icon={<CalendarPlus size={15} />} onClick={() => setScheduleOpen(true)}>
              Schedule
            </Button>
            <MoveStageMenu candidateIds={[c.id]} currentStageId={c.stageId} align="right" />
            {canDelete && (
              <Menu
                align="right"
                trigger={({ toggle }) => (
                  <IconButton label="More actions" onClick={toggle} className="border border-line bg-surface">
                    <MoreHorizontal size={16} />
                  </IconButton>
                )}
              >
                {(close) => (
                  <MenuItem
                    danger
                    icon={<Trash2 size={15} />}
                    onClick={() => {
                      close();
                      if (confirm(`Delete ${fullName(c)}? The resume stays in Google Drive.`)) {
                        deleteCandidates([c.id]);
                        toast("Candidate deleted");
                        navigate("/candidates");
                      }
                    }}
                  >
                    Delete candidate
                  </MenuItem>
                )}
              </Menu>
            )}
          </div>
        </div>

        {/* Stage stepper */}
        <ol className="scroll-slim mt-5 flex gap-1 overflow-x-auto pb-1">
          {stepStages.map((s, i) => {
            const reached = !closed && i <= currentIdx;
            const isCurrent = s.id === c.stageId;
            return (
              <li key={s.id} className="min-w-[110px] flex-1">
                <button
                  disabled={!canMove || isCurrent}
                  onClick={() => {
                    const from = c.stageId;
                    moveStage([c.id], s.id);
                    toast(`Moved to ${s.name}`, "success", { label: "Undo", onClick: () => moveStage([c.id], from) });
                  }}
                  className="group w-full text-left disabled:cursor-default"
                  title={isCurrent ? "Current stage" : `Move to ${s.name}`}
                >
                  <span className={cn("block h-1.5 rounded-full transition", reached ? "" : "bg-sunken group-hover:bg-line-strong")} style={reached ? { background: s.color } : undefined} />
                  <span className={cn("mt-1.5 block truncate text-[12px] font-semibold", isCurrent ? "text-ink" : reached ? "text-ink-2" : "text-faint")}>{s.name}</span>
                  {isCurrent && <span className="block text-[11px] text-muted">{daysSince(c.stageEnteredAt)} days in stage</span>}
                </button>
              </li>
            );
          })}
        </ol>
        {closed && <p className="mt-2 text-[13px] font-semibold text-danger">Marked “{stageMap[c.stageId]?.name}” {timeAgo(c.stageEnteredAt)}</p>}
      </section>

      <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-[1.2fr_1fr]">
        <section className="card overflow-hidden xl:sticky xl:top-20 xl:h-[calc(100dvh-7rem)]">
          <ResumePreview candidate={c} />
        </section>

        <div className="space-y-5">
          <SummaryCard candidate={c} />

          <section className="card">
            <Tabs
              className="px-3"
              value={tab}
              onChange={setTab}
              tabs={[
                { value: "notes", label: "Notes", count: c.notes.length },
                { value: "interviews", label: "Interviews", count: myInterviews.length },
                { value: "emails", label: "Emails", count: myEmails.length },
                { value: "activity", label: "Activity" },
              ]}
            />
            <div className="p-4">
              {tab === "notes" && (
                <div className="space-y-4">
                  {canNote && (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (!note.trim()) return;
                        addNote(c.id, note.trim());
                        setNote("");
                      }}
                    >
                      <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="Share feedback with the team… (visible to everyone with access)" className="field resize-none" aria-label="New note" />
                      <div className="mt-2 flex justify-end">
                        <Button type="submit" size="sm" variant="primary" disabled={!note.trim()}>
                          Add note
                        </Button>
                      </div>
                    </form>
                  )}
                  {c.notes.length === 0 && <p className="py-4 text-center text-sm text-muted">No notes yet</p>}
                  {c.notes.map((n) => {
                    const a = teamMap[n.authorId];
                    // No author = written on the booking page, or by a since-deleted member.
                    const fromBooking = !a && n.body.startsWith("Booking note from candidate:");
                    return (
                      <div key={n.id} className="flex gap-3">
                        <Avatar name={a?.name ?? (fromBooking ? "Booking page" : "Deleted user")} color={a?.avatarColor} size={28} />
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px]">
                            <b className="font-semibold">{a?.name ?? (fromBooking ? "From the booking page" : "Deleted user")}</b> <span className="text-xs text-faint">· {timeAgo(n.createdAt)}</span>
                          </p>
                          <p className="mt-0.5 text-[13.5px] leading-relaxed text-ink-2">{n.body}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {tab === "interviews" && (
                <div className="space-y-2.5">
                  {myInterviews.length === 0 && (
                    <EmptyState icon={<CalendarPlus size={18} />} title="No interviews yet" action={<Button size="sm" onClick={() => setScheduleOpen(true)}>Schedule one</Button>} />
                  )}
                  {myInterviews.map((iv) => (
                    <div key={iv.id} className="rounded-xl border border-line p-3">
                      <div className="flex items-center gap-3">
                        <span className="flex size-9 items-center justify-center rounded-lg bg-paper text-ink-2 ring-1 ring-line">
                          {iv.type === "video" ? <Video size={16} /> : iv.type === "phone" ? <Phone size={16} /> : <MapPin size={16} />}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold">{iv.title}</p>
                          <p className="text-xs text-muted">
                            {fmtDayLabel(iv.start)} · {fmtTime(iv.start)} · {iv.durationMin} min
                          </p>
                        </div>
                        <AvatarStack members={iv.interviewerIds.map((i) => teamMap[i]!).filter(Boolean)} />
                        <Badge tone={iv.status === "completed" ? "neutral" : iv.status === "scheduled" ? "info" : "danger"}>{iv.status}</Badge>
                      </div>
                      {iv.meetLink && iv.status === "scheduled" && parseISO(iv.start) > new Date() && (
                        <a href={iv.meetLink} target="_blank" rel="noreferrer" className="mt-2 inline-block text-[12px] font-semibold text-brand-700 hover:underline">
                          {iv.meetLink.replace("https://", "")}
                        </a>
                      )}
                      {iv.feedback?.map((f, i) => (
                        <p key={i} className="mt-2 rounded-lg bg-paper p-2 text-[12.5px] text-ink-2">
                          <b className="font-semibold">{teamMap[f.authorId]?.name.split(" ")[0]}:</b> {f.recommendation.replace("_", " ")} — {f.comment}
                        </p>
                      ))}
                    </div>
                  ))}
                </div>
              )}

              {tab === "emails" && (
                <ul className="divide-y divide-line">
                  {myEmails.length === 0 && <p className="py-4 text-center text-sm text-muted">No emails sent yet</p>}
                  {myEmails.map((e) => (
                    <li key={e.id} className="flex items-center gap-3 py-2.5">
                      <Mail size={15} className="text-muted" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold">{e.subject}</span>
                        <span className="block text-xs text-muted">
                          {e.status === "scheduled" ? "Scheduled for" : "Sent"} {fmtDate(e.sentAt, "MMM d, h:mm a")} by {teamMap[e.sentById]?.name ?? "automation"}
                          {e.recipientIds.length > 1 && ` · bulk (${e.recipientIds.length})`}
                        </span>
                      </span>
                      <Badge tone={e.status === "scheduled" ? "warn" : "brand"}>{e.status}</Badge>
                    </li>
                  ))}
                </ul>
              )}

              {tab === "activity" && (
                <ol className="relative space-y-3 border-l border-line pl-4">
                  {myActivity.map((a) => (
                    <li key={a.id} className="relative text-[13px] text-ink-2">
                      <span className="absolute top-1.5 -left-[21px] size-2.5 rounded-full border-2 border-surface bg-line-strong" />
                      <b className="font-semibold text-ink">{teamMap[a.actorId]?.name ?? "System"}</b> {a.message}
                      <span className="block text-[11px] text-faint">{timeAgo(a.createdAt)}</span>
                    </li>
                  ))}
                  <li className="relative text-[13px] text-ink-2">
                    <span className="absolute top-1.5 -left-[21px] size-2.5 rounded-full border-2 border-surface bg-brand-500" />
                    Added to the ATS{sourceMap[c.sourceId] ? ` · source: ${sourceMap[c.sourceId]!.name}` : ""}
                    <span className="block text-[11px] text-faint">{fmtDate(c.appliedAt)}</span>
                  </li>
                </ol>
              )}
            </div>
          </section>
        </div>
      </div>

      <ComposeEmailModal open={emailOpen} onClose={() => setEmailOpen(false)} recipientIds={[c.id]} />
      <ScheduleInterviewModal open={scheduleOpen} onClose={() => setScheduleOpen(false)} candidateId={c.id} />
    </>
  );
}
