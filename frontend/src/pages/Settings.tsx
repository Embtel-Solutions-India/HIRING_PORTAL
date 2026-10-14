import { ArrowDown, ArrowUp, CircleAlert, CircleCheck, Copy, FolderOpen, Plus, RefreshCw, Send, Server, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { Avatar, Badge, Button, CalendarMark, DriveMark, Field, GoogleMark, PageHeader, Select, Tabs, Toggle } from "../components/ui";
import { SOURCE_COLORS } from "../components/SourcePicker";
import { useCan, useStore, useTeamMap } from "../data/store";
import type { ActivityEvent, Stage } from "../types";
import { cn, fmtDate, timeAgo, uid } from "../lib/utils";

const GOOGLE_RESULT: Record<string, [string, "success" | "error"]> = {
  connected: ["Google Workspace connected — Drive and Calendar are ready", "success"],
  no_refresh_token: ["Google didn't grant offline access. Disconnect the app at myaccount.google.com/permissions and try again.", "error"],
  missing_scopes: ["Please tick both Drive and Calendar on Google's consent screen and try again.", "error"],
  access_denied: ["Google connection was cancelled", "error"],
};

type SettingsTab = "integrations" | "email" | "pipeline" | "sources" | "audit";

export default function Settings() {
  const [params, setParams] = useSearchParams();
  const toast = useStore((s) => s.toast);
  const superAdmin = useCan("settings.integrations");
  const [tab, setTab] = useState<SettingsTab>(superAdmin ? "integrations" : "sources");

  useEffect(() => {
    const g = params.get("google");
    if (!g) return;
    const [msg, tone] = GOOGLE_RESULT[g] ?? [`Google connection failed (${g})`, "error"];
    toast(msg, tone);
    params.delete("google");
    setParams(params, { replace: true });
  }, [params, setParams, toast]);

  return (
    <>
      <PageHeader title="Settings" subtitle={superAdmin ? "Workspace-wide configuration" : "Admins can manage recruiting sources here"} />
      <Tabs
        className="mb-5"
        value={tab}
        onChange={setTab}
        tabs={[
          ...(superAdmin
            ? ([
                { value: "integrations", label: "Google & AI" },
                { value: "email", label: "Email domain" },
                { value: "pipeline", label: "Pipeline stages" },
              ] as const)
            : []),
          { value: "sources" as const, label: "Sources" },
          ...(superAdmin ? [{ value: "audit" as const, label: "Audit log" }] : []),
        ]}
      />
      {tab === "integrations" && <Integrations />}
      {tab === "sources" && <SourcesSettings />}
      {tab === "email" && <EmailDomain />}
      {tab === "pipeline" && <PipelineStages />}
      {tab === "audit" && <AuditLog />}
    </>
  );
}

function Section({ icon, title, description, children, aside }: { icon: ReactNode; title: string; description: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="card">
      <div className="flex flex-wrap items-start gap-3 border-b border-line px-5 py-4">
        <span className="flex size-10 items-center justify-center rounded-xl bg-paper ring-1 ring-line">{icon}</span>
        <div className="min-w-0 flex-1">
          <h2 className="font-bold">{title}</h2>
          <p className="text-[13px] text-muted">{description}</p>
        </div>
        {aside}
      </div>
      <div className="space-y-4 p-5">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-semibold">{label}</p>
        {hint && <p className="text-xs text-muted">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

function Status({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[13px] font-semibold", ok ? "text-brand-700" : "text-warn")}>
      {ok ? <CircleCheck size={14} /> : <CircleAlert size={14} />} {children}
    </span>
  );
}

function Integrations() {
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.updateSettings);
  const syncDrive = useStore((s) => s.syncDrive);
  const disconnectGoogle = useStore((s) => s.disconnectGoogle);
  const toast = useStore((s) => s.toast);
  const [syncing, setSyncing] = useState(false);
  const g = settings.google;
  const sys = settings.system;
  const [folder, setFolder] = useState(g.driveRootFolder);
  const [calendarId, setCalendarId] = useState(g.calendarId);
  useEffect(() => setFolder(g.driveRootFolder), [g.driveRootFolder]);
  useEffect(() => setCalendarId(g.calendarId), [g.calendarId]);

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
      <Section
        icon={<GoogleMark size={20} />}
        title="Google Workspace"
        description="One connection powers resume storage in Drive and interview events in Calendar."
        aside={
          g.connected ? (
            <Badge tone="brand">
              <CircleCheck size={12} /> Connected
            </Badge>
          ) : (
            <Badge tone="warn">Not connected</Badge>
          )
        }
      >
        {!sys?.googleOAuthConfigured && (
          <p className="rounded-lg bg-amber-50 p-3 text-[13px] text-amber-900">
            Set <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> on the server first (DEPLOY.md, step 3).
          </p>
        )}
        <Row label="Connected account" hint="Owns the resume folders and creates interview events">
          <span className="font-mono text-[13px]">{g.connected ? g.account : "—"}</span>
        </Row>
        <Row label="Access requested" hint="Shown on Google's consent screen">
          <span className="flex flex-wrap justify-end gap-1">
            {["Drive", "Calendar", "Email address"].map((s) => (
              <Badge key={s}>{s}</Badge>
            ))}
          </span>
        </Row>
        <div className="flex justify-end gap-2">
          {g.connected && (
            <Button
              variant="ghost"
              className="text-danger"
              onClick={async () => {
                if (!confirm("Disconnect Google? Resumes already in Drive stay there, but new uploads will be stored on the server.")) return;
                if (await disconnectGoogle()) toast("Google Workspace disconnected", "info");
              }}
            >
              Disconnect
            </Button>
          )}
          <Button variant={g.connected ? "secondary" : "primary"} disabled={!sys?.googleOAuthConfigured} icon={<GoogleMark size={14} />} onClick={() => (window.location.href = "/api/integrations/google/start")}>
            {g.connected ? "Reconnect" : "Connect Google"}
          </Button>
        </div>
      </Section>

      <Section icon={<DriveMark size={20} />} title="Google Drive · resumes" description="Each job gets a folder. Drop resumes into it and they're imported automatically.">
        <Field label="Root folder (in the connected account's My Drive)" hint="Created if it doesn't exist. Use / for sub-folders.">
          <div className="flex gap-2">
            <span className="relative flex-1">
              <FolderOpen size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
              <input className="field pl-9 font-mono text-[13px]" value={folder} onChange={(e) => setFolder(e.target.value)} />
            </span>
            <Button disabled={folder.trim() === g.driveRootFolder || !folder.trim()} onClick={async () => (await update({ google: { driveRootFolder: folder.trim() } })) && toast("Folder saved")}>
              Save
            </Button>
          </div>
        </Field>
        <div className="rounded-lg bg-paper p-3 font-mono text-[12px] leading-relaxed text-ink-2">
          {g.driveRootFolder}/
          <br />
          ├── Case Manager/ <span className="text-faint">← one folder per job (created when you add a job)</span>
          <br />
          ├── Paralegal/
          <br />
          └── loose-resume.pdf <span className="text-faint">← waits in the inbox for someone to pick a job</span>
        </div>
        <Row label="Auto-import files in job folders" hint={`Checks every few minutes. Off = new files wait in the Drive inbox.`}>
          <Toggle checked={g.driveSyncEnabled} onChange={(v) => update({ google: { driveSyncEnabled: v } })} label="Auto-import" />
        </Row>
        <Row label="Last checked" hint={g.lastSyncAt ? fmtDate(g.lastSyncAt, "MMM d, h:mm a") : "Never"}>
          <Button
            size="sm"
            disabled={!g.connected || syncing}
            icon={<RefreshCw size={13} className={cn(syncing && "animate-spin")} />}
            onClick={async () => {
              setSyncing(true);
              const r = await syncDrive();
              setSyncing(false);
              if (r) toast(r.found ? `Found ${r.found} new file${r.found === 1 ? "" : "s"}, imported ${r.imported}` : "No new files", "info");
            }}
          >
            Check now
          </Button>
        </Row>
      </Section>

      <Section icon={<CalendarMark size={20} />} title="Google Calendar · interviews" description="Interviews become Calendar events with interviewers (and optionally the candidate) as guests.">
        <Field label="Calendar" hint={`"primary" = the connected account's own calendar, or paste a shared calendar's ID (Calendar settings → Integrate calendar).`}>
          <div className="flex gap-2">
            <input className="field font-mono text-[13px]" value={calendarId} onChange={(e) => setCalendarId(e.target.value)} />
            <Button disabled={calendarId.trim() === g.calendarId || !calendarId.trim()} onClick={async () => (await update({ google: { calendarId: calendarId.trim() } })) && toast("Calendar saved")}>
              Save
            </Button>
          </div>
        </Field>
        <Row label="Add Google Meet links automatically" hint="For video interviews and booking links">
          <Toggle checked={g.autoMeetLinks} onChange={(v) => update({ google: { autoMeetLinks: v } })} label="Auto Meet links" />
        </Row>
      </Section>

      <Section icon={<Sparkles size={18} className="text-brand-600" />} title="AI resume summaries" description="Each new resume is read by Claude and summarized against the job.">
        <Row label="API key" hint="ANTHROPIC_API_KEY on the server">
          <Status ok={!!sys?.aiConfigured}>{sys?.aiConfigured ? "Configured" : "Not set"}</Status>
        </Row>
        <Row label="Generate summaries automatically" hint="Strengths, watch-outs and a match score for every candidate">
          <Toggle checked={settings.aiSummariesEnabled} onChange={(v) => update({ aiSummariesEnabled: v })} label="AI summaries" />
        </Row>
        <p className="rounded-lg bg-paper p-3 text-xs leading-relaxed text-muted">
          Summaries are suggestions for reviewers, not decisions. The model is told to judge only job-relevant qualifications and to ignore protected characteristics. Match scores never move candidates — a person always makes the stage change.
        </p>
      </Section>

      <Section icon={<Server size={18} className="text-muted" />} title="Server" description="Read-only. Change these in the server's .env file and restart.">
        <Row label="Public URL" hint="APP_URL">
          <span className="font-mono text-[13px]">{sys?.appUrl}</span>
        </Row>
        <Row label="Email delivery" hint="EMAIL_TRANSPORT">
          <Status ok={sys?.emailTransport === "smtp"}>{sys?.emailTransport === "smtp" ? `SMTP (${sys.smtpHost})` : "Log only (not sent)"}</Status>
        </Row>
        <Row label="Time zone for booking links" hint="ORG_TIMEZONE">
          <span className="font-mono text-[13px]">{sys?.timezone}</span>
        </Row>
      </Section>
    </div>
  );
}

function EmailDomain() {
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.updateSettings);
  const verify = useStore((s) => s.verifyEmailDomain);
  const sendTest = useStore((s) => s.sendTestEmail);
  const toast = useStore((s) => s.toast);
  const [draft, setDraft] = useState({
    emailDomain: settings.emailDomain,
    senderName: settings.senderName,
    senderAddress: settings.senderAddress,
    replyTo: settings.replyTo,
    emailSignature: settings.emailSignature,
    orgName: settings.orgName,
  });
  const [verifying, setVerifying] = useState(false);
  const [testing, setTesting] = useState(false);
  const smtp = settings.system?.emailTransport === "smtp";
  const records = settings.dnsRecords;
  const allVerified = records.length > 0 && records.every((r) => r.verified);

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_1.1fr]">
      <Section icon={<span className="text-sm font-bold">@</span>} title="Sender identity" description="Every candidate email is sent from your own domain.">
        {!smtp && (
          <p className="rounded-lg bg-amber-50 p-3 text-[13px] text-amber-900">
            Emails are currently only printed to the server log. Set <code>EMAIL_TRANSPORT=smtp</code> plus your SMTP provider's settings to send for real (DEPLOY.md, step 4).
          </p>
        )}
        <Field label="Company name" hint="Used in {{company}} and the booking page">
          <input className="field" value={draft.orgName} onChange={(e) => setDraft({ ...draft, orgName: e.target.value })} />
        </Field>
        <Field label="Domain">
          <input className="field font-mono" value={draft.emailDomain} onChange={(e) => setDraft({ ...draft, emailDomain: e.target.value })} placeholder="yourcompany.com" />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="From name">
            <input className="field" value={draft.senderName} onChange={(e) => setDraft({ ...draft, senderName: e.target.value })} />
          </Field>
          <Field label="From address">
            <input className="field" value={draft.senderAddress} onChange={(e) => setDraft({ ...draft, senderAddress: e.target.value })} placeholder={`careers@${draft.emailDomain || "yourcompany.com"}`} />
          </Field>
        </div>
        <Field label="Reply-to" hint="Candidate replies land here (e.g. a shared inbox or Google Group)">
          <input className="field" value={draft.replyTo} onChange={(e) => setDraft({ ...draft, replyTo: e.target.value })} />
        </Field>
        <Field label="Signature">
          <textarea className="field resize-none" rows={3} value={draft.emailSignature} onChange={(e) => setDraft({ ...draft, emailSignature: e.target.value })} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button
            icon={<Send size={14} />}
            disabled={testing}
            onClick={async () => {
              setTesting(true);
              const ok = await sendTest();
              setTesting(false);
              if (ok) toast(smtp ? "Test email sent to your inbox" : "Test email printed to the server log (EMAIL_TRANSPORT=log)", "info");
            }}
          >
            Send test email
          </Button>
          <Button variant="primary" onClick={async () => (await update(draft)) && toast("Sender settings saved")}>
            Save
          </Button>
        </div>
      </Section>

      <Section
        icon={allVerified ? <CircleCheck size={18} className="text-brand-600" /> : <CircleAlert size={18} className="text-warn" />}
        title="DNS records"
        description="Add these at your domain registrar so email lands in inboxes, not spam. Then press Verify."
        aside={
          <Button
            size="sm"
            disabled={verifying}
            icon={<RefreshCw size={13} className={cn(verifying && "animate-spin")} />}
            onClick={async () => {
              setVerifying(true);
              if (await verify()) toast("DNS status refreshed", "info");
              setVerifying(false);
            }}
          >
            {records.length ? "Verify" : "Get records"}
          </Button>
        }
      >
        {records.length === 0 ? (
          <p className="text-sm text-muted">
            Press “Get records” to check your domain's SPF and DMARC records. Add the DKIM records from your SMTP provider's dashboard.
          </p>
        ) : (
          <div className="space-y-2">
            {records.map((r) => (
              <div key={r.host} className="rounded-xl border border-line p-3">
                <div className="flex items-center gap-2">
                  <Badge tone="neutral" className="font-mono">
                    {r.type === "DKIM" ? "CNAME" : "TXT"}
                  </Badge>
                  <span className="min-w-0 truncate font-mono text-[12px] text-ink-2">{r.host}</span>
                  <span className="ml-auto shrink-0">
                    {r.verified ? (
                      <Badge tone="brand">
                        <CircleCheck size={11} /> Verified
                      </Badge>
                    ) : (
                      <Badge tone="warn">
                        <CircleAlert size={11} /> Pending
                      </Badge>
                    )}
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-2 rounded-lg bg-paper py-1 pr-1 pl-2.5">
                  <code className="min-w-0 flex-1 truncate text-[12px]">{r.value}</code>
                  <button onClick={() => (navigator.clipboard?.writeText(r.value), toast("Copied", "info"))} className="rounded-md p-1.5 text-muted hover:bg-sunken hover:text-ink" aria-label={`Copy ${r.type} value`}>
                    <Copy size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="text-xs leading-relaxed text-muted">DNS changes can take up to a few hours to show as verified. The three CNAME records sign your email (DKIM); the TXT record is your DMARC policy.</p>
      </Section>
    </div>
  );
}

function PipelineStages() {
  const stages = useStore((s) => s.stages);
  const templates = useStore((s) => s.templates);
  const candidates = useStore((s) => s.candidates);
  const setStages = useStore((s) => s.setStages);
  const toast = useStore((s) => s.toast);
  const [draft, setDraftRaw] = useState<Stage[]>(stages);
  const [edited, setEdited] = useState(false);
  const setDraft = (next: Stage[] | ((d: Stage[]) => Stage[])) => {
    setEdited(true);
    setDraftRaw(next);
  };
  // Pick up changes from the server (polling) unless the person is mid-edit.
  const serverKey = JSON.stringify(stages);
  useEffect(() => {
    if (!edited) setDraftRaw(stages);
  }, [serverKey]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(stages);
  const PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#4a3aa7", "#008300", "#e34948", "#e87ba4"];

  const move = (i: number, d: -1 | 1) => {
    const next = [...draft];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x!);
    setDraft(next);
  };
  const set = (i: number, patch: Partial<Stage>) => setDraft((d) => d.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  return (
    <section className="card">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4">
        <div className="flex-1">
          <h2 className="font-bold">Pipeline stages</h2>
          <p className="text-[13px] text-muted">Order, names, colors and the email each candidate gets when they enter a stage.</p>
        </div>
        <Button icon={<Plus size={15} />} onClick={() => setDraft([...draft.slice(0, -1), { id: uid("st"), name: "New stage", color: PALETTE[7]!, kind: "active" }, ...draft.slice(-1)])}>
          Add stage
        </Button>
        <Button variant="primary" disabled={!dirty} onClick={async () => {
            if (await setStages(draft)) {
              setEdited(false);
              toast("Pipeline updated");
            }
          }}>
          Save changes
        </Button>
      </div>
      <ul className="divide-y divide-line">
        {draft.map((s, i) => {
          const count = candidates.filter((c) => c.stageId === s.id).length;
          return (
            <li key={s.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <span className="flex flex-col">
                <button disabled={i === 0} onClick={() => move(i, -1)} className="rounded p-0.5 text-muted hover:bg-sunken disabled:opacity-25" aria-label="Move up">
                  <ArrowUp size={13} />
                </button>
                <button disabled={i === draft.length - 1} onClick={() => move(i, 1)} className="rounded p-0.5 text-muted hover:bg-sunken disabled:opacity-25" aria-label="Move down">
                  <ArrowDown size={13} />
                </button>
              </span>
              <span className="tabular w-5 text-xs font-bold text-faint">{i + 1}</span>
              <span className="flex gap-1">
                {PALETTE.map((c) => (
                  <button
                    key={c}
                    onClick={() => set(i, { color: c })}
                    className={cn("size-4 rounded-full ring-offset-2 transition", s.color === c ? "ring-2 ring-ink" : "hover:scale-110")}
                    style={{ background: c }}
                    aria-label={`Color ${c}`}
                  />
                ))}
              </span>
              <input className="field h-9 w-48" value={s.name} onChange={(e) => set(i, { name: e.target.value })} aria-label="Stage name" />
              <Select
                ariaLabel="Stage type"
                value={s.kind}
                onChange={(v) => set(i, { kind: v as Stage["kind"] })}
                options={[
                  { value: "active", label: "In progress" },
                  { value: "hired", label: "Hired" },
                  { value: "closed", label: "Closed / rejected" },
                ]}
              />
              <Select
                ariaLabel="Auto email"
                className="min-w-[200px] flex-1"
                value={s.autoEmailTemplateId ?? ""}
                onChange={(v) => set(i, { autoEmailTemplateId: v || undefined })}
                options={[{ value: "", label: "No automatic email" }, ...templates.map((t) => ({ value: t.id, label: `Email: ${t.name}` }))]}
              />
              <span className="tabular w-24 text-right text-xs text-muted">{count} candidates</span>
              <button
                disabled={count > 0}
                title={count > 0 ? "Move candidates out of this stage first" : "Delete stage"}
                onClick={() => setDraft(draft.filter((_, j) => j !== i))}
                className="rounded-lg p-1.5 text-muted hover:bg-rose-50 hover:text-danger disabled:opacity-25 disabled:hover:bg-transparent"
                aria-label="Delete stage"
              >
                <Trash2 size={15} />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function SourcesSettings() {
  const sources = useStore((s) => s.sources);
  const candidates = useStore((s) => s.candidates);
  const settings = useStore((s) => s.settings);
  const createSource = useStore((s) => s.createSource);
  const updateSource = useStore((s) => s.updateSource);
  const deleteSource = useStore((s) => s.deleteSource);
  const reorderSources = useStore((s) => s.reorderSources);
  const createSourceFolders = useStore((s) => s.createSourceFolders);
  const toast = useStore((s) => s.toast);
  const [name, setName] = useState("");
  const [color, setColor] = useState(SOURCE_COLORS[sources.length % SOURCE_COLORS.length]!);
  const [creatingFolders, setCreatingFolders] = useState(false);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    candidates.forEach((c) => c.sourceId && m.set(c.sourceId, (m.get(c.sourceId) ?? 0) + 1));
    return m;
  }, [candidates]);
  const untagged = candidates.filter((c) => !sources.some((s) => s.id === c.sourceId)).length;

  const move = (i: number, d: -1 | 1) => {
    const ids = sources.map((s) => s.id);
    const [x] = ids.splice(i, 1);
    ids.splice(i + d, 0, x!);
    void reorderSources(ids);
  };

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.4fr_1fr]">
      <section className="card">
        <div className="border-b border-line px-5 py-4">
          <h2 className="font-bold">Recruiting sources</h2>
          <p className="text-[13px] text-muted">
            The platforms candidates come from. Everyone picks from this list when adding resumes and can re-tag any candidate. Google Drive is only where files are stored, so it isn't a source.
          </p>
        </div>
        <form
          className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!name.trim()) return;
            const created = await createSource(name.trim(), color);
            if (created) {
              toast(`Added ${created.name}`);
              setName("");
              setColor(SOURCE_COLORS[(sources.length + 1) % SOURCE_COLORS.length]!);
            }
          }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="New source, e.g. Naukri, Glassdoor, Job fair" className="field h-9 min-w-[220px] flex-1" aria-label="New source name" />
          <ColorDots value={color} onChange={setColor} />
          <Button type="submit" variant="primary" icon={<Plus size={15} />} disabled={!name.trim()}>
            Add source
          </Button>
        </form>
        <ul className="divide-y divide-line">
          {sources.map((s, i) => {
            const n = counts.get(s.id) ?? 0;
            return (
              <li key={s.id} className={cn("flex flex-wrap items-center gap-3 px-5 py-2.5", !s.active && "bg-paper/60")}>
                <span className="flex flex-col">
                  <button disabled={i === 0} onClick={() => move(i, -1)} className="rounded p-0.5 text-muted hover:bg-sunken disabled:opacity-25" aria-label={`Move ${s.name} up`}>
                    <ArrowUp size={13} />
                  </button>
                  <button disabled={i === sources.length - 1} onClick={() => move(i, 1)} className="rounded p-0.5 text-muted hover:bg-sunken disabled:opacity-25" aria-label={`Move ${s.name} down`}>
                    <ArrowDown size={13} />
                  </button>
                </span>
                <ColorDots value={s.color} onChange={(c) => updateSource(s.id, { color: c })} compact />
                <SourceName source={s} onSave={async (v) => (await updateSource(s.id, { name: v })) && toast("Source renamed")} />
                <span className="tabular w-24 text-right text-[12px] text-muted">
                  {n} candidate{n === 1 ? "" : "s"}
                </span>
                <span className="flex items-center gap-2 text-[12px] text-muted" title="Hidden sources stay on existing candidates but can't be picked for new ones">
                  <Toggle checked={s.active} onChange={(v) => updateSource(s.id, { active: v })} label={`Show ${s.name}`} />
                  <span className="w-12">{s.active ? "Shown" : "Hidden"}</span>
                </span>
                <button
                  disabled={n > 0}
                  title={n > 0 ? "Tagged on candidates — hide it instead" : `Delete ${s.name}`}
                  onClick={async () => confirm(`Delete “${s.name}”?`) && (await deleteSource(s.id)) && toast("Source deleted")}
                  className="rounded-lg p-1.5 text-muted hover:bg-rose-50 hover:text-danger disabled:opacity-25 disabled:hover:bg-transparent"
                  aria-label={`Delete ${s.name}`}
                >
                  <Trash2 size={15} />
                </button>
              </li>
            );
          })}
        </ul>
        {untagged > 0 && (
          <p className="border-t border-line px-5 py-3 text-[12px] text-muted">
            {untagged} candidate{untagged === 1 ? " has" : "s have"} no source yet — filter Candidates by “No source yet” and use <b>Set source</b> to tag them in bulk.
          </p>
        )}
      </section>

      <Section icon={<DriveMark size={20} />} title="Auto-tag from Google Drive" description="Drop resumes into a sub-folder named after the platform and they're tagged automatically.">
        <div className="rounded-lg bg-paper p-3 font-mono text-[12px] leading-relaxed text-ink-2">
          {settings.google.driveRootFolder}/
          <br />
          └── Case Manager/
          <br />
          {"    "}├── LinkedIn/ <span className="text-faint">← tagged LinkedIn</span>
          <br />
          {"    "}├── Internshala/ <span className="text-faint">← tagged Internshala</span>
          <br />
          {"    "}└── resume.pdf <span className="text-faint">← job set, source left blank</span>
        </div>
        <p className="text-[13px] text-muted">Folder names are matched to source names (not case-sensitive). When importing by hand you can also pick one source for the whole batch.</p>
        <div className="flex justify-end">
          <Button
            disabled={!settings.google.connected || creatingFolders}
            icon={<FolderOpen size={14} />}
            onClick={async () => {
              setCreatingFolders(true);
              const r = await createSourceFolders();
              setCreatingFolders(false);
              if (r) toast(`Created source folders in ${r.jobs} job folder${r.jobs === 1 ? "" : "s"}`);
            }}
          >
            {creatingFolders ? "Creating…" : "Create source folders for every job"}
          </Button>
        </div>
        {!settings.google.connected && <p className="text-xs text-muted">Connect Google in “Google & AI” first.</p>}
      </Section>
    </div>
  );
}

function SourceName({ source, onSave }: { source: { name: string }; onSave: (v: string) => void }) {
  const [v, setV] = useState(source.name);
  useEffect(() => setV(source.name), [source.name]);
  const commit = () => v.trim() && v.trim() !== source.name && onSave(v.trim());
  return (
    <input
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
      maxLength={40}
      className="field h-8 min-w-[140px] flex-1 font-semibold"
      aria-label="Source name"
    />
  );
}

function ColorDots({ value, onChange, compact }: { value: string; onChange: (c: string) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  if (compact && !open) {
    return <button onClick={() => setOpen(true)} className="size-5 rounded-full ring-2 ring-surface ring-offset-1 ring-offset-line transition hover:scale-110" style={{ background: value }} aria-label="Change color" />;
  }
  return (
    <span className="flex flex-wrap gap-1" onMouseLeave={() => compact && setOpen(false)}>
      {SOURCE_COLORS.slice(0, compact ? 16 : 10).map((c) => (
        <button
          type="button"
          key={c}
          onClick={() => {
            onChange(c);
            setOpen(false);
          }}
          className={cn("size-4 rounded-full ring-offset-2 transition", value === c ? "ring-2 ring-ink" : "hover:scale-110")}
          style={{ background: c }}
          aria-label={`Color ${c}`}
        />
      ))}
    </span>
  );
}

const AUDIT_TYPES: { value: ActivityEvent["type"] | "all"; label: string }[] = [
  { value: "all", label: "All events" },
  { value: "stage_change", label: "Stage changes" },
  { value: "email_sent", label: "Emails" },
  { value: "interview_scheduled", label: "Interviews" },
  { value: "resume_upload", label: "Resumes" },
  { value: "user_invited", label: "Invites" },
  { value: "role_changed", label: "Role changes" },
  { value: "source_changed", label: "Source tags" },
  { value: "settings_changed", label: "Settings" },
];

function AuditLog() {
  const activity = useStore((s) => s.activity);
  const teamMap = useTeamMap();
  const [type, setType] = useState<string>("all");
  const list = activity.filter((a) => type === "all" || a.type === type);
  return (
    <section className="card">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3">
        <h2 className="flex-1 font-bold">Audit log</h2>
        <Select ariaLabel="Event type" value={type} onChange={setType} options={AUDIT_TYPES.map((t) => ({ value: t.value, label: t.label }))} />
      </div>
      <ul className="divide-y divide-line">
        {list.slice(0, 100).map((a) => {
          const actor = teamMap[a.actorId];
          return (
            <li key={a.id} className="flex items-center gap-3 px-5 py-2.5 text-[13px]">
              <Avatar name={actor?.name ?? "System"} color={actor?.avatarColor} size={26} />
              <p className="min-w-0 flex-1 text-ink-2">
                <b className="font-semibold text-ink">{actor?.name ?? "System"}</b> {a.message}
              </p>
              <Badge>{a.type.replace("_", " ")}</Badge>
              <span className="hidden w-36 text-right text-xs text-muted sm:block" title={fmtDate(a.createdAt, "MMM d, yyyy h:mm a")}>
                {timeAgo(a.createdAt)}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
