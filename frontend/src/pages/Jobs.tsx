import { Briefcase, FolderOpen, MapPin, Pencil, Plus, Trash2, Users } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Avatar, Badge, Button, Field, Modal, PageHeader, Segmented, Select } from "../components/ui";
import { useCan, useStore, useTeamMap } from "../data/store";
import type { Job } from "../types";
import { cn, timeAgo, uid } from "../lib/utils";

export default function Jobs() {
  const jobs = useStore((s) => s.jobs);
  const applications = useStore((s) => s.applications);
  const stages = useStore((s) => s.stages);
  const upsert = useStore((s) => s.upsertJob);
  const deleteJob = useStore((s) => s.deleteJob);
  const toast = useStore((s) => s.toast);
  const settings = useStore((s) => s.settings);
  const teamMap = useTeamMap();
  const canManage = useCan("jobs.manage");
  const [status, setStatus] = useState<"open" | "all">("open");
  const [editing, setEditing] = useState<Job | null>(null);
  const [hover, setHover] = useState<{ job: string; stage: string } | null>(null);

  const list = jobs.filter((j) => status === "all" || j.status === "open");

  return (
    <>
      <PageHeader
        title="Jobs"
        subtitle={`${jobs.filter((j) => j.status === "open").length} open roles · each job has its own resume folder in Google Drive`}
        actions={
          <>
            <Segmented
              value={status}
              onChange={setStatus}
              options={[
                { value: "open", label: "Open" },
                { value: "all", label: "All" },
              ]}
            />
            {canManage && (
              <Button
                variant="primary"
                icon={<Plus size={15} />}
                onClick={() =>
                  setEditing({ id: uid("j"), title: "", department: "", location: "", type: "Full-time", status: "open", hiringManagerId: "", openings: 1, createdAt: new Date().toISOString(), driveFolder: "" })
                }
              >
                New job
              </Button>
            )}
          </>
        }
      />

      {/* Shared legend for the stacked pipeline bars */}
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[12px] font-medium text-ink-2">
        {stages.map((s) => (
          <span key={s.id} className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ background: s.color }} /> {s.name}
          </span>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {list.map((j) => {
          const jc = applications.filter((a) => a.jobId === j.id);
          const hm = teamMap[j.hiringManagerId];
          const segments = stages.map((s) => ({ s, n: jc.filter((c) => c.stageId === s.id).length })).filter((x) => x.n > 0);
          const hovered = hover?.job === j.id ? segments.find((x) => x.s.id === hover?.stage) : undefined;
          return (
            <div key={j.id} className={cn("card p-5", j.status !== "open" && "opacity-70")}>
              <div className="flex items-start gap-3">
                <span className="flex size-10 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
                  <Briefcase size={18} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-bold">{j.title}</h2>
                    <Badge tone={j.status === "open" ? "brand" : j.status === "paused" ? "warn" : "neutral"}>{j.status}</Badge>
                  </div>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
                    <span>{j.department}</span>
                    <span className="inline-flex items-center gap-1">
                      <MapPin size={11} /> {j.location}
                    </span>
                    <span>{j.type}</span>
                    <span>Posted {timeAgo(j.createdAt)}</span>
                  </p>
                </div>
                {canManage && (
                  <Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={() => setEditing(j)}>
                    Edit
                  </Button>
                )}
              </div>

              <div className="mt-4">
                <div className="mb-1.5 flex items-center justify-between text-[12px]">
                  <span className="font-semibold text-ink-2">
                    {jc.length} candidates · {j.openings} opening{j.openings > 1 ? "s" : ""}
                  </span>
                  <span className="text-muted">{hovered ? `${hovered.s.name}: ${hovered.n}` : ""}</span>
                </div>
                <div className="flex h-3 gap-[2px] overflow-hidden rounded-[4px] bg-sunken" onMouseLeave={() => setHover(null)}>
                  {segments.map(({ s, n }) => (
                    <span
                      key={s.id}
                      onMouseEnter={() => setHover({ job: j.id, stage: s.id })}
                      title={`${s.name}: ${n}`}
                      className="h-full transition-opacity"
                      style={{ flexGrow: n, background: s.color, opacity: hover?.job === j.id && hover.stage !== s.id ? 0.4 : 1 }}
                    />
                  ))}
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-3 text-[12px]">
                {hm && (
                  <span className="inline-flex items-center gap-1.5 font-medium text-ink-2">
                    <Avatar name={hm.name} color={hm.avatarColor} size={20} /> {hm.name}
                  </span>
                )}
                {settings.google.connected && (
                  <span className="inline-flex min-w-0 items-center gap-1 truncate font-mono text-muted">
                    <FolderOpen size={12} /> {j.driveFolder || `${settings.google.driveRootFolder}/${j.title}`}
                  </span>
                )}
                <Link to={`/pipeline?job=${j.id}`} className="ml-auto inline-flex items-center gap-1 font-semibold text-brand-700 hover:underline">
                  <Users size={13} /> View pipeline
                </Link>
              </div>
            </div>
          );
        })}
      </div>

      <JobEditor
        key={editing?.id ?? "closed"}
        job={editing}
        candidateCount={editing ? applications.filter((a) => a.jobId === editing.id).length : 0}
        canDelete={!!editing && jobs.some((x) => x.id === editing.id)}
        onDelete={async () => {
          if (!editing || !confirm(`Delete the job "${editing.title}"? This can't be undone. Its Drive folder stays in Drive.`)) return;
          if (!(await deleteJob(editing.id))) return;
          setEditing(null);
          toast("Job deleted", "info");
        }}
        onClose={() => setEditing(null)}
        onSave={async (j) => {
          if (!(await upsert(j))) return;
          setEditing(null);
          toast(settings.google.connected ? "Job saved · Drive folder ready" : "Job saved");
        }}
      />
    </>
  );
}

function JobEditor({
  job,
  candidateCount,
  canDelete,
  onDelete,
  onClose,
  onSave,
}: {
  job: Job | null;
  candidateCount: number;
  canDelete: boolean;
  onDelete: () => void;
  onClose: () => void;
  onSave: (j: Job) => void;
}) {
  const team = useStore((s) => s.team);
  const settings = useStore((s) => s.settings);
  const [d, setD] = useState(job);
  const set = (p: Partial<Job>) => setD((x) => (x ? { ...x, ...p } : x));
  return (
    <Modal
      open={!!job}
      onClose={onClose}
      title={job?.title ? "Edit job" : "New job"}
      footer={
        <>
          {canDelete && (
            <Button
              variant="ghost"
              className="mr-auto text-danger"
              icon={<Trash2 size={14} />}
              disabled={candidateCount > 0}
              title={candidateCount > 0 ? `Move or delete its ${candidateCount} candidate(s) first, or set the job to Closed` : undefined}
              onClick={onDelete}
            >
              Delete
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!d?.title} onClick={() => d && onSave(d)}>
            Save job
          </Button>
        </>
      }
    >
      {d && (
        <div className="space-y-4">
          <Field label="Job title">
            <input className="field" value={d.title} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. Case Manager" />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Department">
              <input className="field" value={d.department} onChange={(e) => set({ department: e.target.value })} />
            </Field>
            <Field label="Location">
              <input className="field" value={d.location} onChange={(e) => set({ location: e.target.value })} />
            </Field>
            <Field label="Type">
              <Select ariaLabel="Type" className="w-full" value={d.type} onChange={(v) => set({ type: v as Job["type"] })} options={["Full-time", "Part-time", "Contract", "Internship"].map((v) => ({ value: v, label: v }))} />
            </Field>
            <Field label="Openings">
              <input type="number" min={1} className="field" value={d.openings} onChange={(e) => set({ openings: Math.max(1, Number(e.target.value)) })} />
            </Field>
            <Field label="Hiring manager">
              <Select
                ariaLabel="Hiring manager"
                className="w-full"
                value={d.hiringManagerId}
                onChange={(v) => set({ hiringManagerId: v })}
                options={[{ value: "", label: "None" }, ...team.filter((t) => t.status === "active").map((t) => ({ value: t.id, label: t.name }))]}
              />
            </Field>
            <Field label="Status">
              <Select
                ariaLabel="Status"
                className="w-full"
                value={d.status}
                onChange={(v) => set({ status: v as Job["status"] })}
                options={[
                  { value: "open", label: "Open" },
                  { value: "paused", label: "Paused" },
                  { value: "closed", label: "Closed" },
                ]}
              />
            </Field>
          </div>
          <Field label="Job description" hint="Paste the requirements. The AI compares each resume against this to write the summary and match score.">
            <textarea className="field resize-y" rows={6} value={d.description ?? ""} onChange={(e) => set({ description: e.target.value })} placeholder="Responsibilities, must-have skills, nice-to-haves, languages, location…" />
          </Field>
          {settings.google.connected && (
            <p className="text-xs text-muted">
              Resumes for this job go to <span className="font-mono">{d.driveFolder || `${settings.google.driveRootFolder}/${d.title || "Job title"}`}</span> in Google Drive (created automatically).
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
