import { FileText, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ResumePreview } from "../components/candidate";
import { Badge, Drawer, EmptyState, IconButton, PageHeader, Select, StageBadge } from "../components/ui";
import { useJobMap, useLatestAppMap, useStageMap, useStore } from "../data/store";
import type { SyncStateName } from "../types";
import { cn, fmtDate, fullName } from "../lib/utils";

const SYNC_LABEL: Record<SyncStateName, string> = {
  pending: "Syncing",
  synced: "Synced",
  conflict: "Sync conflict",
  failed: "Sync failed",
  pending_deletion: "Pending deletion",
  deleted: "Deleted",
};
const PARSE_LABEL = { pending: "Parsing…", ready: "Parsed", failed: "Couldn't parse" } as const;

/** Every resume on the platform, one per person (their current file). Read-only: opening one never creates candidates. */
export default function Resumes() {
  const candidates = useStore((s) => s.candidates);
  const jobs = useStore((s) => s.jobs);
  const latest = useLatestAppMap();
  const jobMap = useJobMap();
  const stageMap = useStageMap();
  const [q, setQ] = useState("");
  const [parse, setParse] = useState("all");
  const [sync, setSync] = useState("all");
  const [jobId, setJobId] = useState("all");
  const [openId, setOpenId] = useState<string | null>(null);

  const withResume = useMemo(() => candidates.filter((c) => c.resume.driveFileId || c.resume.resumeFileId), [candidates]);
  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return withResume
      .filter(
        (c) =>
          (parse === "all" || c.parseStatus === parse) &&
          (sync === "all" || c.resume.syncState === sync) &&
          (jobId === "all" || latest[c.id]?.jobId === jobId) &&
          (!term || [c.resume.fileName, fullName(c), c.email, ...c.skills].join(" ").toLowerCase().includes(term)),
      )
      .sort((a, b) => b.resume.uploadedAt.localeCompare(a.resume.uploadedAt));
  }, [withResume, q, parse, sync, jobId, latest]);
  const open = candidates.find((c) => c.id === openId);

  return (
    <>
      <PageHeader title="Resumes" subtitle={`${rows.length} of ${withResume.length} resumes · one current file per person`} />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="File name, person, email, skill…" className="field h-9 pl-9" aria-label="Search resumes" />
        </div>
        <Select ariaLabel="Job" value={jobId} onChange={setJobId} options={[{ value: "all", label: "All jobs" }, ...jobs.map((j) => ({ value: j.id, label: j.title }))]} />
        <Select ariaLabel="Parse status" value={parse} onChange={setParse} options={[{ value: "all", label: "Any parse status" }, ...Object.entries(PARSE_LABEL).map(([value, label]) => ({ value, label }))]} />
        <Select ariaLabel="Sync state" value={sync} onChange={setSync} options={[{ value: "all", label: "Any sync state" }, ...Object.entries(SYNC_LABEL).map(([value, label]) => ({ value, label }))]} />
      </div>

      {!rows.length ? (
        <EmptyState icon={<FileText size={18} />} title={withResume.length ? "No resumes match these filters" : "No resumes yet"} />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead className="border-b border-line text-[11px] font-semibold tracking-wide text-muted uppercase">
              <tr>
                <th className="px-4 py-2.5 text-left">File</th>
                <th className="px-3 py-2.5 text-left">Person</th>
                <th className="px-3 py-2.5 text-left">Latest job</th>
                <th className="px-3 py-2.5 text-left">Uploaded</th>
                <th className="px-3 py-2.5 text-left">Parsed</th>
                <th className="px-3 py-2.5 pr-4 text-left">Storage</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((c) => {
                const app = latest[c.id];
                const st = c.resume.syncState;
                return (
                  <tr key={c.id} onClick={() => setOpenId(c.id)} className={cn("cursor-pointer hover:bg-paper", openId === c.id && "bg-brand-50/60")}>
                    <td className="max-w-[260px] px-4 py-2.5">
                      <span className="flex items-center gap-2 font-semibold">
                        <FileText size={14} className="shrink-0 text-muted" />
                        <span className="truncate">{c.resume.fileName}</span>
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <Link to={`/candidates/${c.id}`} onClick={(e) => e.stopPropagation()} className="font-semibold text-brand-700 hover:underline">
                        {fullName(c)}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="flex items-center gap-2">
                        <span className="max-w-[160px] truncate text-ink-2">{jobMap[app?.jobId ?? ""]?.title ?? "—"}</span>
                        {app && <StageBadge stage={stageMap[app.stageId]} />}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap text-ink-2">{fmtDate(c.resume.uploadedAt)}</td>
                    <td className="px-3 py-2.5">
                      <Badge tone={c.parseStatus === "failed" ? "danger" : c.parseStatus === "pending" ? "warn" : "neutral"}>{PARSE_LABEL[c.parseStatus]}</Badge>
                    </td>
                    <td className="px-3 py-2.5 pr-4 whitespace-nowrap text-ink-2">
                      {c.resume.storage === "s3" ? "S3" : c.resume.storage === "drive" ? "Drive" : "Server"}
                      {st && <Badge className="ml-1.5" tone={st === "failed" ? "danger" : st === "conflict" || st === "pending_deletion" ? "warn" : "neutral"}>{SYNC_LABEL[st]}</Badge>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Drawer open={!!open} onClose={() => setOpenId(null)} label="Resume preview" width={760}>
        {open && (
          <>
            <header className="flex items-center gap-2 border-b border-line px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-bold">{fullName(open)}</p>
                <p className="truncate text-xs text-muted">{open.resume.fileName}</p>
              </div>
              <IconButton label="Close" onClick={() => setOpenId(null)}>
                <X size={18} />
              </IconButton>
            </header>
            <div className="min-h-0 flex-1">
              <ResumePreview candidate={open} />
            </div>
          </>
        )}
      </Drawer>
    </>
  );
}
