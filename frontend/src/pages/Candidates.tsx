import { ArrowDownUp, Download, Mail, Search, Star, Trash2, Upload, Users, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { MoveStageMenu } from "../components/candidate";
import { CandidateQuickView } from "../components/CandidateQuickView";
import { ComposeEmailModal } from "../components/ComposeEmailModal";
import { SourceBadge, SourcePicker } from "../components/SourcePicker";
import { UploadResumeModal } from "../components/UploadResumeModal";
import { Avatar, Button, Checkbox, DriveMark, EmptyState, MatchScore, PageHeader, Select, StageBadge, Stars } from "../components/ui";
import { useCan, useJobMap, useSourceMap, useStageMap, useStore, useTeamMap } from "../data/store";
import type { Candidate } from "../types";
import { cn, daysSince, fmtDate, fullName } from "../lib/utils";

type SortKey = "name" | "match" | "applied" | "inStage" | "rating";

export default function Candidates() {
  const candidates = useStore((s) => s.candidates);
  const jobs = useStore((s) => s.jobs);
  const stages = useStore((s) => s.stages);
  const team = useStore((s) => s.team);
  const deleteCandidates = useStore((s) => s.deleteCandidates);
  const toast = useStore((s) => s.toast);
  const stageMap = useStageMap();
  const jobMap = useJobMap();
  const teamMap = useTeamMap();
  const sourceMap = useSourceMap();
  const sources = useStore((s) => s.sources);
  const setCandidateSource = useStore((s) => s.setCandidateSource);
  const canTag = useCan("candidates.tagSource");
  const canUpload = useCan("resumes.upload");
  const canBulk = useCan("emails.sendBulk");
  const canEmail = useCan("emails.sendSingle");
  const canDelete = useCan("candidates.delete");

  const [q, setQ] = useState("");
  const [jobId, setJobId] = useState("all");
  const [stageId, setStageId] = useState("all");
  const [params, setParams] = useSearchParams();
  // "all", a source id, or "none" (not tagged yet). Linked from the dashboard as ?source=…
  const [source, setSource] = useState(params.get("source") ?? "all");
  useEffect(() => {
    const p = params.get("source");
    if (p) {
      setSource(p);
      params.delete("source");
      setParams(params, { replace: true });
    }
  }, [params, setParams]);
  const [owner, setOwner] = useState("all");
  const [starredOnly, setStarredOnly] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "applied", dir: -1 });
  const [selected, setSelected] = useState<string[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [emailOpen, setEmailOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    const list = candidates.filter(
      (c) =>
        (jobId === "all" || c.jobId === jobId) &&
        (stageId === "all" || c.stageId === stageId) &&
        (source === "all" || (source === "none" ? !sourceMap[c.sourceId] : c.sourceId === source)) &&
        (owner === "all" || c.ownerId === owner) &&
        (!starredOnly || c.starred) &&
        (!term || [fullName(c), c.email, c.currentTitle, c.currentCompany, c.location, sourceMap[c.sourceId]?.name ?? "", ...c.skills, ...c.tags].join(" ").toLowerCase().includes(term)),
    );
    const val = (c: Candidate): string | number =>
      sort.key === "name" ? fullName(c) : sort.key === "match" ? c.summary.matchScore : sort.key === "applied" ? c.appliedAt : sort.key === "inStage" ? -daysSince(c.stageEnteredAt) : c.rating;
    return list.sort((a, b) => (val(a) > val(b) ? 1 : val(a) < val(b) ? -1 : 0) * sort.dir);
  }, [candidates, q, jobId, stageId, source, owner, starredOnly, sort, sourceMap]);

  const allSelected = rows.length > 0 && rows.every((r) => selected.includes(r.id));
  const someSelected = selected.length > 0 && !allSelected;
  const toggleAll = () => setSelected(allSelected ? [] : rows.map((r) => r.id));
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const clearFilters = () => {
    setQ("");
    setJobId("all");
    setStageId("all");
    setSource("all");
    setOwner("all");
    setStarredOnly(false);
  };
  const filtersActive = q || jobId !== "all" || stageId !== "all" || source !== "all" || owner !== "all" || starredOnly;

  const exportCsv = () => {
    const pick = candidates.filter((c) => selected.includes(c.id));
    const header = ["Name", "Email", "Phone", "Job", "Stage", "Source", "Match", "Rating", "Applied", "Resume (Drive)"];
    const lines = pick.map((c) =>
      [fullName(c), c.email, c.phone, jobMap[c.jobId]?.title, stageMap[c.stageId]?.name, sourceMap[c.sourceId]?.name ?? "", c.summary.matchScore, c.rating, fmtDate(c.appliedAt), c.resume.driveUrl]
        .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`)
        .join(","),
    );
    const blob = new Blob([[header.join(","), ...lines].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `candidates-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const SortHead = ({ k, children, className }: { k: SortKey; children: React.ReactNode; className?: string }) => (
    <th className={cn("px-3 py-2.5 text-left", className)}>
      <button
        onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? (s.dir === 1 ? -1 : 1) : k === "name" ? 1 : -1 }))}
        className={cn("inline-flex items-center gap-1 hover:text-ink", sort.key === k && "text-ink")}
      >
        {children}
        <ArrowDownUp size={11} className={sort.key === k ? "opacity-100" : "opacity-30"} />
      </button>
    </th>
  );

  return (
    <>
      <PageHeader
        title="Candidates"
        subtitle={`${rows.length} of ${candidates.length} candidates`}
        actions={
          canUpload && (
            <>
              <Button icon={<DriveMark size={14} />} onClick={() => setUploadOpen(true)}>
                Import from Drive
              </Button>
              <Button variant="primary" icon={<Upload size={15} />} onClick={() => setUploadOpen(true)}>
                Upload resumes
              </Button>
            </>
          )
        }
      />

      {/* Filters */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, email, skill, tag…" className="field h-9 pl-9" aria-label="Search candidates" />
        </div>
        <Select ariaLabel="Job" value={jobId} onChange={setJobId} options={[{ value: "all", label: "All jobs" }, ...jobs.map((j) => ({ value: j.id, label: j.title }))]} />
        <Select ariaLabel="Stage" value={stageId} onChange={setStageId} options={[{ value: "all", label: "All stages" }, ...stages.map((s) => ({ value: s.id, label: s.name }))]} />
        <Select
          ariaLabel="Source"
          value={source}
          onChange={setSource}
          options={[{ value: "all", label: "All sources" }, ...sources.map((x) => ({ value: x.id, label: x.active ? x.name : `${x.name} (hidden)` })), { value: "none", label: "No source yet" }]}
        />
        <Select ariaLabel="Owner" value={owner} onChange={setOwner} options={[{ value: "all", label: "Any owner" }, ...team.filter((t) => t.status === "active").map((t) => ({ value: t.id, label: t.name }))]} />
        <button
          onClick={() => setStarredOnly((s) => !s)}
          className={cn("inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm font-semibold transition", starredOnly ? "border-amber-300 bg-amber-50 text-amber-700" : "border-line bg-surface text-ink-2 hover:bg-paper")}
        >
          <Star size={14} className={starredOnly ? "fill-amber-400 text-amber-400" : ""} /> Starred
        </button>
        {filtersActive && (
          <button onClick={clearFilters} className="inline-flex items-center gap-1 text-[13px] font-semibold text-muted hover:text-ink">
            <X size={14} /> Clear
          </button>
        )}
      </div>

      {/* Bulk bar */}
      {selected.length > 0 && (
        <div className="sticky top-16 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-xl bg-ink px-3 py-2 text-white shadow-pop">
          <span className="px-1 text-sm font-semibold">{selected.length} selected</span>
          <button onClick={() => setSelected([])} className="text-[13px] font-semibold text-white/60 hover:text-white">
            Clear
          </button>
          <span className="ml-auto flex flex-wrap items-center gap-2">
            <MoveStageMenu candidateIds={selected} align="right" size="sm" onMoved={() => setSelected([])} />
            {canTag && (
              <SourcePicker
                variant="button"
                placeholder="Set source"
                align="right"
                value=""
                onChange={async (id) => {
                  const n = selected.length;
                  if (await setCandidateSource(selected, id)) toast(id ? `${n} candidate${n === 1 ? "" : "s"} tagged as ${sourceMap[id]?.name ?? "new source"}` : `Source cleared on ${n} candidate${n === 1 ? "" : "s"}`);
                }}
              />
            )}
            {canEmail && (
              <Button
                size="sm"
                variant="lime"
                icon={<Mail size={14} />}
                disabled={selected.length > 1 && !canBulk}
                title={selected.length > 1 && !canBulk ? "Bulk email requires Admin" : undefined}
                onClick={() => setEmailOpen(true)}
              >
                Email {selected.length > 1 ? `${selected.length}` : ""}
              </Button>
            )}
            <Button size="sm" variant="ghost" className="text-white hover:bg-white/10 hover:text-white" icon={<Download size={14} />} onClick={exportCsv}>
              Export CSV
            </Button>
            {canDelete && (
              <Button
                size="sm"
                variant="ghost"
                className="text-rose-300 hover:bg-white/10 hover:text-rose-200"
                icon={<Trash2 size={14} />}
                onClick={() => {
                  if (confirm(`Delete ${selected.length} candidates? Their resumes are kept for 30 days and can be restored by an Admin.`)) {
                    deleteCandidates(selected);
                    toast(`${selected.length} candidates deleted`);
                    setSelected([]);
                  }
                }}
              >
                Delete
              </Button>
            )}
          </span>
        </div>
      )}

      <div className="card overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState icon={<Users size={18} />} title="No candidates match" body="Try clearing some filters." action={filtersActive && <Button onClick={clearFilters}>Clear filters</Button>} />
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead className="border-b border-line bg-paper/60 text-[12px] font-semibold text-muted">
                  <tr>
                    <th className="w-10 py-2.5 pl-4">
                      <Checkbox checked={allSelected} indeterminate={someSelected} onChange={toggleAll} label="Select all" />
                    </th>
                    <SortHead k="name">Candidate</SortHead>
                    <th className="px-3 py-2.5 text-left">Job</th>
                    <th className="px-3 py-2.5 text-left">Stage</th>
                    <th className="px-3 py-2.5 text-left">Source</th>
                    <SortHead k="match">Match</SortHead>
                    <SortHead k="rating" className="hidden 2xl:table-cell">
                      Rating
                    </SortHead>
                    <SortHead k="inStage">In stage</SortHead>
                    <SortHead k="applied">Applied</SortHead>
                    <th className="px-3 py-2.5 pr-4 text-left">Owner</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows.map((c) => {
                    const sel = selected.includes(c.id);
                    const owner = teamMap[c.ownerId];
                    const days = daysSince(c.stageEnteredAt);
                    return (
                      <tr key={c.id} onClick={() => setOpenId(c.id)} className={cn("cursor-pointer transition hover:bg-paper", sel && "bg-brand-50/60 hover:bg-brand-50")}>
                        <td className="py-2.5 pl-4" onClick={(e) => e.stopPropagation()}>
                          <Checkbox checked={sel} onChange={() => toggle(c.id)} label={`Select ${fullName(c)}`} />
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-2.5">
                            <Avatar name={fullName(c)} size={32} />
                            <div className="min-w-0">
                              <p className="flex items-center gap-1 font-semibold">
                                {fullName(c)}
                                {c.starred && <Star size={12} className="fill-amber-400 text-amber-400" />}
                              </p>
                              <p className="max-w-[220px] truncate text-xs text-muted">
                                {c.currentTitle}
                                {c.currentCompany && ` · ${c.currentCompany}`}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="max-w-[160px] truncate px-3 py-2.5 text-ink-2">{jobMap[c.jobId]?.title}</td>
                        <td className="px-3 py-2.5">
                          <StageBadge stage={stageMap[c.stageId]} />
                        </td>
                        <td className="max-w-[150px] px-3 py-2.5">
                          <SourceBadge sourceId={c.sourceId} />
                        </td>
                        <td className="px-3 py-2.5">{c.summary.status === "pending" ? <span className="text-xs text-muted">…</span> : <MatchScore score={c.summary.matchScore} size={30} />}</td>
                        <td className="hidden px-3 py-2.5 2xl:table-cell">
                          <Stars value={c.rating} size={12} />
                        </td>
                        <td className={cn("tabular px-3 py-2.5 font-semibold", days >= 7 ? "text-warn" : "text-ink-2")}>{days}d</td>
                        <td className="tabular px-3 py-2.5 text-ink-2">{fmtDate(c.appliedAt, "MMM d")}</td>
                        <td className="px-3 py-2.5 pr-4">{owner && <Avatar name={owner.name} color={owner.avatarColor} size={24} />}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile list */}
            <ul className="divide-y divide-line md:hidden">
              {rows.map((c) => (
                <li key={c.id} className={cn("flex items-center gap-3 px-3 py-3", selected.includes(c.id) && "bg-brand-50/60")}>
                  <Checkbox checked={selected.includes(c.id)} onChange={() => toggle(c.id)} label={`Select ${fullName(c)}`} />
                  <button onClick={() => setOpenId(c.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                    <Avatar name={fullName(c)} size={36} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{fullName(c)}</span>
                      <span className="block truncate text-xs text-muted">{jobMap[c.jobId]?.title}</span>
                      <span className="mt-1 flex flex-wrap gap-1">
                        <StageBadge stage={stageMap[c.stageId]} />
                        <SourceBadge sourceId={c.sourceId} muted={false} />
                      </span>
                    </span>
                    {c.summary.status !== "pending" && <MatchScore score={c.summary.matchScore} size={34} />}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <CandidateQuickView candidateId={openId} onClose={() => setOpenId(null)} />
      <ComposeEmailModal open={emailOpen} onClose={() => setEmailOpen(false)} recipientIds={selected} />
      <UploadResumeModal open={uploadOpen} onClose={() => setUploadOpen(false)} />
    </>
  );
}
