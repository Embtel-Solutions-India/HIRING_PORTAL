import { parseISO } from "date-fns";
import { ArrowLeft, CalendarPlus, ChevronLeft, ChevronRight, Mail, MapPin, MoreHorizontal, Phone, Star, Trash2, Video, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApplicationCard } from "../components/ApplicationCard";
import { ContactRow, MoveStageMenu, ResumePreview, SummaryCard } from "../components/candidate";
import { ComposeEmailModal } from "../components/ComposeEmailModal";
import { ScheduleInterviewModal } from "../components/ScheduleInterviewModal";
import { Avatar, AvatarStack, Badge, Button, EmptyState, IconButton, Menu, MenuItem, Select, StageBadge, Stars, Tabs } from "../components/ui";
import { SourceBadge, SourcePicker } from "../components/SourcePicker";
import { useApplicationsOf, useCan, useJobMap, useSourceMap, useStageMap, useStore, useTeamMap } from "../data/store";
import type { CandidateHistory } from "../types";
import { fmtDate, fmtDayLabel, fmtTime, fullName, timeAgo, resumeKeptNote } from "../lib/utils";

export default function CandidateDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const candidates = useStore((s) => s.candidates);
  const applications = useStore((s) => s.applications);
  const stages = useStore((s) => s.stages);
  const interviews = useStore((s) => s.interviews);
  const campaigns = useStore((s) => s.campaigns);
  const activity = useStore((s) => s.activity);
  const addNote = useStore((s) => s.addNote);
  const setRating = useStore((s) => s.setRating);
  const toggleStar = useStore((s) => s.toggleStar);
  const moveStage = useStore((s) => s.moveStage);
  const requestMove = useStore((s) => s.requestMove);
  const deleteCandidates = useStore((s) => s.deleteCandidates);
  const settings = useStore((s) => s.settings);
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
  const [noteAppId, setNoteAppId] = useState("");
  const [tab, setTab] = useState<"notes" | "interviews" | "emails" | "activity">("notes");
  const [emailOpen, setEmailOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);

  const fetchHistory = useStore((s) => s.fetchHistory);
  const c = candidates.find((x) => x.id === id);
  const apps = useApplicationsOf(id);
  // The header (stage menu, reject, rating, star) and the AI summary act on the selected application; the newest by default.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const app = apps.find((a) => a.id === selectedId) ?? apps[0];
  const [history, setHistory] = useState<CandidateHistory | null>(null);
  // Reload the full history whenever something about this person changes.
  const version = `${id}|${c?.notes.length}|${apps.map((a) => `${a.id}:${a.stageId}:${a.lastActivityAt}`).join(",")}`;
  useEffect(() => {
    let live = true;
    if (id) void fetchHistory(id).then((h) => live && h && setHistory(h));
    return () => {
      live = false;
    };
  }, [version, id, fetchHistory]);
  const siblings = useMemo(() => (app ? applications.filter((a) => a.jobId === app.jobId).map((a) => a.candidateId) : []), [applications, app]);

  if (!c || !app) {
    return <EmptyState icon={<ArrowLeft size={18} />} title="Candidate not found" action={<Button onClick={() => navigate("/candidates")}>Back to candidates</Button>} />;
  }

  const pos = siblings.indexOf(c.id);
  const prev = siblings[pos - 1];
  const next = siblings[pos + 1];
  const myInterviews = interviews.filter((i) => i.candidateId === c.id).sort((a, b) => apps.findIndex((x) => x.id === a.applicationId) - apps.findIndex((x) => x.id === b.applicationId) || a.start.localeCompare(b.start));
  const myEmails = campaigns.filter((e) => e.recipientIds.includes(c.id));
  const myActivity = history?.activity ?? activity.filter((a) => a.candidateId === c.id);
  const closed = stageMap[app.stageId]?.kind === "closed";
  const isExpanded = (appId: string) => expanded[appId] ?? appId === apps[0]?.id;
  const jobOf = (appId: string) => jobMap[apps.find((a) => a.id === appId)?.jobId ?? ""]?.title;
  const closedStage = stages.find((s) => s.kind === "closed");

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-2">
        <Link to="/candidates" className="inline-flex items-center gap-1 text-[13px] font-semibold text-muted hover:text-ink">
          <ArrowLeft size={15} /> Candidates
        </Link>
        <div className="flex items-center gap-1 text-[12px] font-semibold text-muted">
          <span className="hidden sm:inline">
            {pos + 1} of {siblings.length} in {jobMap[app.jobId]?.title}
          </span>
          <IconButton label="Previous candidate" disabled={!prev} onClick={() => prev && navigate(`/candidates/${prev}`)}>
            <ChevronLeft size={18} />
          </IconButton>
          <IconButton label="Next candidate" disabled={!next} onClick={() => next && navigate(`/candidates/${next}`)}>
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
              <button onClick={() => toggleStar(app.id)} aria-label={app.starred ? "Unstar" : "Star"} className="rounded p-0.5">
                <Star size={18} className={app.starred ? "fill-amber-400 text-amber-400" : "text-line-strong hover:text-amber-400"} />
              </button>
              <StageBadge stage={stageMap[app.stageId]} />
              {canTag ? (
                <SourcePicker variant="badge" value={c.sourceId} onChange={async (id) => (await setCandidateSource([c.id], id)) && toast(id ? `Source set to ${sourceMap[id]?.name ?? "new source"}` : "Source cleared")} />
              ) : (
                <SourceBadge sourceId={c.sourceId} />
              )}
            </div>
            <p className="mt-0.5 text-sm text-muted">
              {[c.currentTitle && `${c.currentTitle}${c.currentCompany ? ` at ${c.currentCompany}` : ""}`, jobMap[app.jobId] ? `applied for ${jobMap[app.jobId]!.title}` : "", `added ${timeAgo(app.appliedAt)}`]
                .filter(Boolean)
                .join(" · ")}
            </p>
            <div className="mt-2.5">
              <ContactRow candidate={c} />
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <Stars value={app.rating} onChange={canNote ? (v) => setRating(app.id, v) : undefined} size={16} />
              {c.tags.map((t) => (
                <Badge key={t}>{t}</Badge>
              ))}
              {teamMap[app.ownerId] && <span className="text-xs text-muted">Owner: {teamMap[app.ownerId]!.name}</span>}
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
            {canMove && !closed && closedStage && (
              <Button
                className="text-danger"
                icon={<XCircle size={15} />}
                onClick={async () => (await requestMove([app.id], closedStage.id)) && toast(`Marked “${closedStage.name}”`, "info", { label: "Undo", onClick: () => moveStage([app.id], app.stageId) })}
              >
                Reject
              </Button>
            )}
            <MoveStageMenu applicationIds={[app.id]} currentStageId={app.stageId} align="right" />
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
                      if (confirm(`Delete ${fullName(c)}? ${resumeKeptNote(settings.system, false)}`)) {
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

        {/* Applications: one per job, newest first */}
        <div className="mt-5 space-y-2">
          {apps.length > 1 && <p className="label">{apps.length} applications</p>}
          {apps.map((a) => (
            <ApplicationCard
              key={a.id}
              app={a}
              transitions={(history?.transitions ?? []).filter((t) => t.applicationId === a.id)}
              expanded={isExpanded(a.id)}
              selected={a.id === app.id}
              onToggle={() => setExpanded((e) => ({ ...e, [a.id]: !isExpanded(a.id) }))}
              onSelect={() => {
                setSelectedId(a.id);
                setExpanded((e) => ({ ...e, [a.id]: true }));
              }}
            />
          ))}
        </div>
      </section>

      <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-[1.2fr_1fr]">
        <section className="card overflow-hidden xl:sticky xl:top-20 xl:h-[calc(100dvh-7rem)]">
          <ResumePreview candidate={c} />
        </section>

        <div className="space-y-5">
          <SummaryCard candidate={c} app={app} />

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
                        addNote(c.id, note.trim(), noteAppId || app.id);
                        setNote("");
                      }}
                    >
                      <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="Share feedback with the team… (visible to everyone with access)" className="field resize-none" aria-label="New note" />
                      <div className="mt-2 flex items-center justify-end gap-2">
                        {apps.length > 1 && (
                          <Select
                            ariaLabel="Job this note is about"
                            value={noteAppId || app.id}
                            onChange={setNoteAppId}
                            options={apps.map((a) => ({ value: a.id, label: jobMap[a.jobId]?.title ?? "No job" }))}
                          />
                        )}
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
                            {n.applicationId && jobOf(n.applicationId) && <Badge className="ml-1.5">{jobOf(n.applicationId)}</Badge>}
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
                  {myInterviews.map((iv, i) => (
                    <div key={iv.id}>
                    {apps.length > 1 && myInterviews[i - 1]?.applicationId !== iv.applicationId && <p className="label mt-2 mb-1.5">{jobOf(iv.applicationId) ?? "No job"}</p>}
                    <div className="rounded-xl border border-line p-3">
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
                    <span className="block text-[11px] text-faint">{fmtDate(c.createdAt)}</span>
                  </li>
                </ol>
              )}
            </div>
          </section>
        </div>
      </div>

      <ComposeEmailModal open={emailOpen} onClose={() => setEmailOpen(false)} recipientIds={[c.id]} />
      <ScheduleInterviewModal open={scheduleOpen} onClose={() => setScheduleOpen(false)} candidateId={c.id} applicationId={app.id} />
    </>
  );
}
