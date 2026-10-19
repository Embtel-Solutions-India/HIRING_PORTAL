import { ChevronLeft, ChevronRight, Clock, Eye, PenLine, Send, ShieldCheck, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useCan, useJobMap, useLatestAppMap, useStageMap, useStore } from "../data/store";
import { cn, fullName, MERGE_FIELDS, renderTemplate } from "../lib/utils";
import { Badge, Button, Field, Modal, Segmented, Select } from "./ui";

export function ComposeEmailModal({
  open,
  onClose,
  recipientIds,
  defaultTemplateId,
}: {
  open: boolean;
  onClose: () => void;
  recipientIds: string[];
  defaultTemplateId?: string;
}) {
  const candidates = useStore((s) => s.candidates);
  const latest = useLatestAppMap();
  const templates = useStore((s) => s.templates);
  const settings = useStore((s) => s.settings);
  const sendEmail = useStore((s) => s.sendEmail);
  const toast = useStore((s) => s.toast);
  const jobMap = useJobMap();
  const stageMap = useStageMap();
  const canBulk = useCan("emails.sendBulk");

  const [ids, setIds] = useState<string[]>(recipientIds);
  const [templateId, setTemplateId] = useState(defaultTemplateId ?? "");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [mode, setMode] = useState<"write" | "preview">("write");
  const [previewIdx, setPreviewIdx] = useState(0);
  const [when, setWhen] = useState<"now" | "later">("now");
  const [scheduledAt, setScheduledAt] = useState("");
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    setIds(recipientIds);
    setMode("write");
    setPreviewIdx(0);
    setWhen("now");
    const t = templates.find((x) => x.id === defaultTemplateId);
    setTemplateId(t?.id ?? "");
    setSubject(t?.subject ?? "");
    setBody(t?.body ?? "");
  }, [open]);

  const recipients = useMemo(() => candidates.filter((c) => ids.includes(c.id)), [candidates, ids]);
  const preview = recipients[Math.min(previewIdx, recipients.length - 1)];
  const isBulk = recipients.length > 1;
  const blocked = isBulk && !canBulk;

  const applyTemplate = (id: string) => {
    setTemplateId(id);
    const t = templates.find((x) => x.id === id);
    if (t) {
      setSubject(t.subject);
      setBody(t.body);
    }
  };

  const insertField = (f: string) => {
    const el = bodyRef.current;
    const token = `{{${f}}}`;
    if (!el) return setBody((b) => b + token);
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const next = body.slice(0, start) + token + body.slice(end);
    setBody(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const [sending, setSending] = useState(false);
  const send = async () => {
    setSending(true);
    const ok = await sendEmail({
      recipientIds: ids,
      subject,
      body,
      templateId: templateId || undefined,
      scheduledAt: when === "later" && scheduledAt ? new Date(scheduledAt).toISOString() : undefined,
    });
    setSending(false);
    if (!ok) return;
    toast(when === "later" ? `Email scheduled for ${recipients.length} candidate${isBulk ? "s" : ""}` : `Email sent to ${recipients.length} candidate${isBulk ? "s" : ""}`);
    onClose();
  };

  const ctx = (c: (typeof recipients)[number]) => ({
    candidate: c,
    job: jobMap[latest[c.id]?.jobId ?? ""],
    stage: stageMap[latest[c.id]?.stageId ?? ""],
    orgName: settings.orgName,
    senderName: settings.senderName,
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={720}
      title={isBulk ? `Bulk email · ${recipients.length} candidates` : "Email candidate"}
      description={
        <span className="inline-flex items-center gap-1.5">
          <ShieldCheck size={14} className="text-brand-600" /> Sent from <b className="text-ink-2">@{settings.emailDomain}</b> · each candidate receives an individual email
        </span>
      }
      footer={
        <>
          {blocked && <span className="mr-auto text-xs font-semibold text-danger">Bulk email requires Admin access</span>}
          <Segmented
            value={when}
            onChange={setWhen}
            options={[
              { value: "now", label: "Send now", icon: <Send size={13} /> },
              { value: "later", label: "Schedule", icon: <Clock size={13} /> },
            ]}
          />
          {when === "later" && (
            <input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} className="field h-9 w-auto py-0" aria-label="Send at" />
          )}
          <Button variant="primary" onClick={send} disabled={sending || blocked || !recipients.length || !subject.trim() || (when === "later" && !scheduledAt)} icon={<Send size={15} />}>
            {when === "later" ? "Schedule" : `Send${isBulk ? ` to ${recipients.length}` : ""}`}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
          <div>
            <span className="mb-1.5 block text-[13px] font-semibold text-ink-2">From</span>
            <div className="field flex h-9 items-center bg-paper">
              {settings.senderName} &lt;{settings.senderAddress}&gt;
            </div>
          </div>
          <div>
            <span className="mb-1.5 block text-[13px] font-semibold text-ink-2">Template</span>
            <Select
              ariaLabel="Template"
              value={templateId}
              onChange={applyTemplate}
              className="w-full sm:w-56"
              options={[{ value: "", label: "Blank email" }, ...templates.map((t) => ({ value: t.id, label: t.name }))]}
            />
          </div>
        </div>

        <div>
          <span className="mb-1.5 block text-[13px] font-semibold text-ink-2">To</span>
          <div className="scroll-slim flex max-h-24 flex-wrap gap-1.5 overflow-y-auto rounded-lg border border-line bg-surface p-2">
            {recipients.map((c) => (
              <span key={c.id} className="inline-flex items-center gap-1 rounded-md bg-sunken py-0.5 pr-1 pl-2 text-[12px] font-semibold">
                {fullName(c)}
                <button onClick={() => setIds((x) => x.filter((i) => i !== c.id))} className="rounded p-0.5 text-muted hover:bg-line hover:text-ink" aria-label={`Remove ${fullName(c)}`}>
                  <X size={12} />
                </button>
              </span>
            ))}
            {!recipients.length && <span className="px-1 text-sm text-muted">No recipients</span>}
          </div>
        </div>

        <div className="flex items-center justify-between">
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { value: "write", label: "Write", icon: <PenLine size={13} /> },
              { value: "preview", label: "Preview", icon: <Eye size={13} /> },
            ]}
          />
          {mode === "preview" && preview && (
            <span className="flex items-center gap-1 text-[12px] font-semibold text-ink-2">
              <button className="rounded p-1 hover:bg-sunken disabled:opacity-30" disabled={previewIdx === 0} onClick={() => setPreviewIdx((i) => i - 1)} aria-label="Previous recipient">
                <ChevronLeft size={15} />
              </button>
              {fullName(preview)} ({previewIdx + 1}/{recipients.length})
              <button className="rounded p-1 hover:bg-sunken disabled:opacity-30" disabled={previewIdx >= recipients.length - 1} onClick={() => setPreviewIdx((i) => i + 1)} aria-label="Next recipient">
                <ChevronRight size={15} />
              </button>
            </span>
          )}
        </div>

        {mode === "write" ? (
          <>
            <Field label="Subject">
              <input value={subject} onChange={(e) => setSubject(e.target.value)} className="field" placeholder="Subject" />
            </Field>
            <div>
              <textarea ref={bodyRef} value={body} onChange={(e) => setBody(e.target.value)} rows={9} className="field resize-y leading-relaxed" placeholder="Write your message…" aria-label="Body" />
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] font-semibold text-muted">Insert:</span>
                {MERGE_FIELDS.map((f) => (
                  <button key={f} onClick={() => insertField(f)} className="rounded-md border border-line bg-paper px-1.5 py-0.5 font-mono text-[11px] text-ink-2 hover:border-brand-500 hover:text-brand-700">
                    {`{{${f}}}`}
                  </button>
                ))}
              </div>
            </div>
          </>
        ) : preview ? (
          <div className="rounded-xl border border-line bg-paper p-4">
            <p className="text-[12px] text-muted">
              To: {fullName(preview)} &lt;{preview.email}&gt;
            </p>
            <p className="mt-1 text-[15px] font-bold">{renderTemplate(subject, ctx(preview))}</p>
            <div className="mt-3 rounded-lg bg-surface p-4 text-[13.5px] leading-relaxed whitespace-pre-wrap shadow-card">
              {renderTemplate(body, ctx(preview))}
              {"\n\n"}
              <span className="text-muted">{settings.emailSignature}</span>
            </div>
          </div>
        ) : null}
        {isBulk && (
          <p className={cn("flex items-center gap-2 text-xs text-muted")}>
            <Badge tone="info">Bulk</Badge> Sent individually (no shared To: line). Opens, clicks and bounces are tracked per candidate.
          </p>
        )}
      </div>
    </Modal>
  );
}
