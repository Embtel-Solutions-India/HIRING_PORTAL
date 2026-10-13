import { CloudUpload, EyeOff, FileText, FolderOpen, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useStore } from "../data/store";
import { cn, timeAgo } from "../lib/utils";
import { AUTO_SOURCE, SourceBadge, SourcePicker } from "./SourcePicker";
import { Button, Checkbox, DriveMark, EmptyState, Field, Modal, Select, Tabs } from "./ui";

export function UploadResumeModal({ open, onClose, defaultJobId }: { open: boolean; onClose: () => void; defaultJobId?: string }) {
  const jobs = useStore((s) => s.jobs);
  const inbox = useStore((s) => s.driveInbox);
  const settings = useStore((s) => s.settings);
  const uploadResumes = useStore((s) => s.uploadResumes);
  const importFromDrive = useStore((s) => s.importFromDrive);
  const ignoreDriveFiles = useStore((s) => s.ignoreDriveFiles);
  const syncDrive = useStore((s) => s.syncDrive);
  const toast = useStore((s) => s.toast);

  const openJobs = jobs.filter((j) => j.status !== "closed");
  const connected = settings.google.connected;
  const [tab, setTab] = useState<"upload" | "drive">(connected ? "drive" : "upload");
  const [jobId, setJobId] = useState(defaultJobId ?? openJobs[0]?.id ?? "");
  const [sourceId, setSourceId] = useState("");
  const [driveSource, setDriveSource] = useState(AUTO_SOURCE);
  const [files, setFiles] = useState<File[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setFiles([]);
    setTab(connected && inbox.length ? "drive" : "upload");
    setPicked(inbox.map((f) => f.driveFileId));
    setJobId(defaultJobId ?? openJobs[0]?.id ?? "");
    setDriveSource(AUTO_SOURCE);
  }, [open]);

  const job = jobs.find((j) => j.id === jobId);

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const all = [...list];
    const accepted = all.filter((f) => /\.(pdf|docx)$/i.test(f.name) && f.size <= 10 * 1024 * 1024);
    if (accepted.length < all.length) toast("Only PDF and Word (.docx) files up to 10 MB are supported", "error");
    setFiles((prev) => [...prev, ...accepted]);
  };

  const submit = async () => {
    setBusy(true);
    if (tab === "upload") {
      const r = await uploadResumes(files, jobId, sourceId);
      setBusy(false);
      if (!r) return;
      toast(`${r.created.length} resume${r.created.length === 1 ? "" : "s"} added${connected ? " to Google Drive" : ""} · summaries generating`);
    } else {
      const n = await importFromDrive(picked, jobId, driveSource === AUTO_SOURCE ? undefined : driveSource);
      setBusy(false);
      if (n === null) return;
      toast(`${n} resume${n === 1 ? "" : "s"} imported from Drive · summaries generating`);
    }
    onClose();
  };

  const sync = async () => {
    setSyncing(true);
    const r = await syncDrive();
    setSyncing(false);
    if (r) toast(r.found ? `Found ${r.found} new file${r.found === 1 ? "" : "s"}${r.imported ? ` · ${r.imported} auto-imported` : ""}` : "No new files in Drive", "info");
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={620}
      title="Add candidates"
      description={connected ? "Resumes are stored in your Google Drive, then read and summarized automatically." : "Resumes are stored on the server and summarized automatically. Connect Google Drive in Settings to keep them in Drive."}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || (tab === "upload" ? !files.length || !jobId : !picked.length)}
            onClick={submit}
            icon={tab === "upload" ? <CloudUpload size={15} /> : <DriveMark size={14} />}
          >
            {busy ? "Working…" : tab === "upload" ? `Upload ${files.length || ""}` : `Import ${picked.length || ""} resume${picked.length === 1 ? "" : "s"}`}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {openJobs.length === 0 && <p className="rounded-lg bg-amber-50 p-3 text-[13px] text-amber-900">Create a job first (Jobs → New job) so resumes have somewhere to go.</p>}
        <Field
          label={tab === "drive" ? "Default job" : "Job"}
          hint={
            tab === "drive"
              ? "Files inside a job's Drive folder are matched to that job automatically; this is used for anything else."
              : job &&
                connected && (
                  <>
                    Files go to <span className="font-mono">Drive / {job.driveFolder || `${settings.google.driveRootFolder}/${job.title}`}</span>
                  </>
                )
          }
        >
          <Select ariaLabel="Job" value={jobId} onChange={setJobId} className="w-full" options={openJobs.map((j) => ({ value: j.id, label: j.title }))} />
        </Field>

        <Field
          label="Source — where did these resumes come from?"
          hint={
            tab === "drive"
              ? driveSource === AUTO_SOURCE
                ? "Each file gets the source of the Drive sub-folder it's in (e.g. Case Manager/LinkedIn/). Others stay untagged."
                : "Applies to every selected file."
              : "Applies to every file in this upload. You can change it per candidate later."
          }
        >
          {tab === "drive" ? <SourcePicker value={driveSource} onChange={setDriveSource} allowAuto /> : <SourcePicker value={sourceId} onChange={setSourceId} />}
        </Field>

        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[{ value: "upload" as const, label: "Upload files" }, ...(connected ? [{ value: "drive" as const, label: "From Drive folder", count: inbox.length }] : [])]}
        />

        {tab === "drive" ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-paper px-3 py-2 text-[12px] text-ink-2">
              <FolderOpen size={14} className="text-muted" />
              Watching <span className="font-mono font-semibold">{settings.google.driveRootFolder}/</span>
              <span className="text-muted">· checked {settings.google.lastSyncAt ? timeAgo(settings.google.lastSyncAt) : "never"}</span>
              <button onClick={sync} disabled={syncing} className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-semibold hover:bg-sunken">
                <RefreshCw size={12} className={cn(syncing && "animate-spin")} /> Check now
              </button>
            </div>
            {inbox.length === 0 ? (
              <EmptyState
                icon={<DriveMark size={20} />}
                title="No new resumes in Drive"
                body={`Drop PDF or Word resumes into ${settings.google.driveRootFolder}/<Job title>/ in Google Drive and they'll appear here.`}
              />
            ) : (
              <>
                <div className="divide-y divide-line rounded-xl border border-line">
                  {inbox.map((f) => {
                    const on = picked.includes(f.driveFileId);
                    return (
                      <label key={f.driveFileId} className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-paper">
                        <Checkbox checked={on} onChange={(v) => setPicked((p) => (v ? [...p, f.driveFileId] : p.filter((x) => x !== f.driveFileId)))} label={f.fileName} />
                        <FileText size={18} className={f.fileName.toLowerCase().endsWith(".pdf") ? "text-rose-600" : "text-sky-600"} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold">{f.fileName}</span>
                          <span className="block truncate text-xs text-muted">
                            {f.folder} · {f.sizeKb} KB · {timeAgo(f.modifiedAt)}
                          </span>
                        </span>
                        <SourceBadge sourceId={driveSource === AUTO_SOURCE ? (f.sourceId ?? "") : driveSource} className="shrink-0" />
                      </label>
                    );
                  })}
                </div>
                {picked.length > 0 && (
                  <button
                    onClick={async () => {
                      await ignoreDriveFiles(picked);
                      setPicked([]);
                    }}
                    className="inline-flex items-center gap-1 text-[12px] font-semibold text-muted hover:text-ink"
                  >
                    <EyeOff size={13} /> Ignore selected (not resumes)
                  </button>
                )}
              </>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <button
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                addFiles(e.dataTransfer.files);
              }}
              className={cn(
                "flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed px-6 py-9 text-center transition",
                dragging ? "border-brand-500 bg-brand-50" : "border-line-strong bg-paper hover:border-brand-500",
              )}
            >
              <CloudUpload size={26} className="text-brand-600" />
              <span className="text-sm font-bold">Drop resumes here or click to browse</span>
              <span className="text-xs text-muted">PDF or DOCX · up to 10 MB each · multiple files OK</span>
            </button>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept=".pdf,.docx"
              className="hidden"
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            {files.length > 0 && (
              <div className="divide-y divide-line rounded-xl border border-line">
                {files.map((f, i) => (
                  <div key={i} className="flex items-center gap-3 px-3 py-2">
                    <FileText size={16} className="text-muted" />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{f.name}</span>
                    <span className="text-xs text-muted">{Math.max(1, Math.round(f.size / 1024))} KB</span>
                    <button onClick={() => setFiles((x) => x.filter((_, j) => j !== i))} className="rounded p-1 text-muted hover:bg-sunken" aria-label={`Remove ${f.name}`}>
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
