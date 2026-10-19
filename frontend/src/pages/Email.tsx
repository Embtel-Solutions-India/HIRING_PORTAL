import { Clock, FileText, Mail, Pencil, Plus, Send, ShieldCheck, Trash2, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { ComposeEmailModal } from "../components/ComposeEmailModal";
import { Badge, Button, Checkbox, EmptyState, Field, Modal, PageHeader, Select, Tabs } from "../components/ui";
import { useCan, useCards, useStageMap, useStore, useTeamMap } from "../data/store";
import type { EmailTemplate } from "../types";
import { fmtDate, MERGE_FIELDS, uid } from "../lib/utils";

const CATEGORY_LABEL: Record<EmailTemplate["category"], string> = {
  stage_update: "Stage update",
  interview: "Interview",
  rejection: "Rejection",
  offer: "Offer",
  general: "General",
};

export default function Email() {
  const campaigns = useStore((s) => s.campaigns);
  const settings = useStore((s) => s.settings);
  const canBulk = useCan("emails.sendBulk");
  const [tab, setTab] = useState<"sent" | "templates" | "audience">(canBulk ? "audience" : "sent");
  const sent = campaigns.filter((c) => c.status === "sent");
  const totals = sent.reduce((acc, c) => ({ delivered: acc.delivered + c.stats.delivered, opened: acc.opened + c.stats.opened, clicked: acc.clicked + c.stats.clicked }), { delivered: 0, opened: 0, clicked: 0 });

  return (
    <>
      <PageHeader
        title="Email"
        subtitle={
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck size={14} className="text-brand-600" /> Sending as {settings.senderName} &lt;{settings.senderAddress}&gt;
          </span>
        }
      />
      <div className="mb-5 grid grid-cols-3 gap-3">
        <Stat label="Delivered (30d)" value={totals.delivered} />
        <Stat label="Open rate" value={totals.delivered ? `${Math.round((totals.opened / totals.delivered) * 100)}%` : "—"} />
        <Stat label="Click rate" value={totals.delivered ? `${Math.round((totals.clicked / totals.delivered) * 100)}%` : "—"} />
      </div>
      <Tabs
        className="mb-4"
        value={tab}
        onChange={setTab}
        tabs={[
          ...(canBulk ? [{ value: "audience" as const, label: "Bulk send" }] : []),
          { value: "sent", label: "Sent & scheduled", count: campaigns.length },
          { value: "templates", label: "Templates" },
        ]}
      />
      {tab === "audience" && <BulkAudience />}
      {tab === "sent" && <SentList />}
      {tab === "templates" && <Templates />}
    </>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="card p-4">
      <p className="text-[13px] font-semibold text-muted">{label}</p>
      <p className="mt-1 text-2xl font-bold tracking-tight">{value}</p>
    </div>
  );
}

/** Build an audience by job + stage, then compose. */
function BulkAudience() {
  const cards = useCards();
  const jobs = useStore((s) => s.jobs);
  const stages = useStore((s) => s.stages);
  const [jobId, setJobId] = useState("all");
  const [stageIds, setStageIds] = useState<string[]>(["screening"]);
  const [templateId, setTemplateId] = useState("t_checkin");
  const [open, setOpen] = useState(false);
  const templates = useStore((s) => s.templates);

  const audience = useMemo(() => {
    const people = cards.filter(({ app }) => (jobId === "all" || app.jobId === jobId) && stageIds.includes(app.stageId)).map(({ candidate }) => candidate);
    return [...new Map(people.map((c) => [c.id, c])).values()];
  }, [cards, jobId, stageIds]);

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_320px]">
      <div className="card p-5">
        <h2 className="font-bold">Who should get this update?</h2>
        <p className="mt-0.5 text-sm text-muted">Pick a job and one or more stages. Each candidate gets a personal email using merge fields.</p>
        <div className="mt-4 space-y-4">
          <Field label="Job">
            <Select ariaLabel="Job" className="w-full sm:w-72" value={jobId} onChange={setJobId} options={[{ value: "all", label: "All jobs" }, ...jobs.map((j) => ({ value: j.id, label: j.title }))]} />
          </Field>
          <div>
            <span className="mb-1.5 block text-[13px] font-semibold text-ink-2">Stages</span>
            <div className="flex flex-wrap gap-2">
              {stages.map((s) => {
                const on = stageIds.includes(s.id);
                const n = cards.filter(({ app }) => app.stageId === s.id && (jobId === "all" || app.jobId === jobId)).length;
                return (
                  <label key={s.id} className="flex cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px] font-semibold">
                    <Checkbox checked={on} onChange={(v) => setStageIds((x) => (v ? [...x, s.id] : x.filter((i) => i !== s.id)))} label={s.name} />
                    <span className="size-2 rounded-full" style={{ background: s.color }} />
                    {s.name}
                    <span className="tabular text-muted">{n}</span>
                  </label>
                );
              })}
            </div>
          </div>
          <Field label="Start from template">
            <Select ariaLabel="Template" className="w-full sm:w-72" value={templateId} onChange={setTemplateId} options={templates.map((t) => ({ value: t.id, label: t.name }))} />
          </Field>
        </div>
      </div>
      <div className="card flex flex-col p-5">
        <p className="label">Audience</p>
        <p className="mt-1 text-4xl font-bold tracking-tight">{audience.length}</p>
        <p className="text-sm text-muted">candidates will receive an individual email</p>
        <ul className="scroll-slim mt-4 max-h-48 flex-1 space-y-1 overflow-y-auto text-[13px] text-ink-2">
          {audience.slice(0, 30).map((c) => (
            <li key={c.id} className="truncate">
              {c.firstName} {c.lastName} <span className="text-faint">· {c.email}</span>
            </li>
          ))}
          {audience.length > 30 && <li className="text-muted">+{audience.length - 30} more</li>}
        </ul>
        <Button variant="primary" className="mt-4 w-full" disabled={!audience.length} onClick={() => setOpen(true)} icon={<Send size={15} />}>
          Compose email
        </Button>
      </div>
      <ComposeEmailModal open={open} onClose={() => setOpen(false)} recipientIds={audience.map((c) => c.id)} defaultTemplateId={templateId} />
    </div>
  );
}

function SentList() {
  const campaigns = useStore((s) => s.campaigns);
  const teamMap = useTeamMap();
  if (!campaigns.length) return <EmptyState icon={<Mail size={18} />} title="No emails yet" />;
  return (
    <div className="card overflow-hidden">
      <ul className="divide-y divide-line">
        {campaigns.map((c) => {
          const rate = c.stats.delivered ? Math.round((c.stats.opened / c.stats.delivered) * 100) : 0;
          return (
            <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
              <span className="flex size-9 items-center justify-center rounded-lg bg-paper text-muted ring-1 ring-line">{c.status === "scheduled" ? <Clock size={16} /> : <Mail size={16} />}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{c.subject}</p>
                <p className="text-xs text-muted">
                  {c.status === "scheduled" ? "Scheduled for" : "Sent"} {fmtDate(c.sentAt, "MMM d, h:mm a")} · by {teamMap[c.sentById]?.name ?? "automation"} · {c.fromAddress}
                </p>
              </div>
              <span className="flex items-center gap-1 text-[13px] font-semibold text-ink-2">
                <Users size={14} className="text-muted" /> {c.recipientIds.length}
              </span>
              {c.status === "sent" ? (
                <div className="w-36">
                  <div className="flex justify-between text-[11px] font-semibold text-muted">
                    <span>Opened</span>
                    <span className="tabular text-ink-2">{rate}%</span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-brand-100">
                    <div className="h-full rounded-full bg-brand-600" style={{ width: `${rate}%` }} />
                  </div>
                </div>
              ) : (
                <Badge tone="warn">Scheduled</Badge>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Templates() {
  const templates = useStore((s) => s.templates);
  const stages = useStore((s) => s.stages);
  const upsert = useStore((s) => s.upsertTemplate);
  const remove = useStore((s) => s.deleteTemplate);
  const toast = useStore((s) => s.toast);
  const stageMap = useStageMap();
  const canEdit = useCan("emails.manageTemplates");
  const [editing, setEditing] = useState<EmailTemplate | null>(null);

  return (
    <>
      {canEdit && (
        <div className="mb-3 flex justify-end">
          <Button icon={<Plus size={15} />} onClick={() => setEditing({ id: uid("t"), name: "New template", subject: "", body: "Hi {{first_name}},\n\n\n\n{{sender_name}}", category: "general", updatedAt: new Date().toISOString() })}>
            New template
          </Button>
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {templates.map((t) => {
          const autoFor = stages.filter((s) => s.autoEmailTemplateId === t.id);
          return (
            <div key={t.id} className="card flex flex-col p-4">
              <div className="flex items-start gap-3">
                <FileText size={18} className="mt-0.5 text-muted" />
                <div className="min-w-0 flex-1">
                  <p className="font-bold">{t.name}</p>
                  <p className="truncate text-xs text-muted">{t.subject}</p>
                </div>
                <Badge tone={t.category === "rejection" ? "danger" : t.category === "offer" ? "lime" : t.category === "interview" ? "info" : "neutral"}>{CATEGORY_LABEL[t.category]}</Badge>
              </div>
              <p className="mt-3 line-clamp-3 flex-1 text-[13px] leading-relaxed whitespace-pre-line text-ink-2">{t.body}</p>
              <div className="mt-3 flex items-center gap-2">
                {autoFor.map((s) => (
                  <span key={s.id} className="inline-flex items-center gap-1 text-[11px] font-semibold text-muted">
                    <span className="size-1.5 rounded-full" style={{ background: stageMap[s.id]?.color }} /> Auto on {s.name}
                  </span>
                ))}
                {canEdit && (
                  <span className="ml-auto flex gap-1">
                    <Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={() => setEditing(t)}>
                      Edit
                    </Button>
                    {!autoFor.length && (
                      <Button size="sm" variant="ghost" className="text-danger" icon={<Trash2 size={13} />} onClick={() => (remove(t.id), toast("Template deleted"))} aria-label="Delete template" />
                    )}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <TemplateEditor
        key={editing?.id ?? "closed"}
        template={editing}
        onClose={() => setEditing(null)}
        onSave={async (t) => {
          if (!(await upsert(t))) return;
          setEditing(null);
          toast("Template saved");
        }}
      />
    </>
  );
}

function TemplateEditor({ template, onClose, onSave }: { template: EmailTemplate | null; onClose: () => void; onSave: (t: EmailTemplate) => void }) {
  const [draft, setDraft] = useState(template);
  const set = (p: Partial<EmailTemplate>) => setDraft((d) => (d ? { ...d, ...p } : d));
  return (
    <Modal
      open={!!template}
      onClose={onClose}
      width={640}
      title="Email template"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!draft?.name || !draft.subject} onClick={() => draft && onSave(draft)}>
            Save template
          </Button>
        </>
      }
    >
      {draft && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_180px]">
            <Field label="Name">
              <input className="field" value={draft.name} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field label="Category">
              <Select ariaLabel="Category" className="w-full" value={draft.category} onChange={(v) => set({ category: v as EmailTemplate["category"] })} options={Object.entries(CATEGORY_LABEL).map(([value, label]) => ({ value, label }))} />
            </Field>
          </div>
          <Field label="Subject">
            <input className="field" value={draft.subject} onChange={(e) => set({ subject: e.target.value })} />
          </Field>
          <Field label="Body" hint={<>Merge fields: {MERGE_FIELDS.map((f) => `{{${f}}}`).join(" ")}</>}>
            <textarea className="field resize-y leading-relaxed" rows={10} value={draft.body} onChange={(e) => set({ body: e.target.value })} />
          </Field>
        </div>
      )}
    </Modal>
  );
}
