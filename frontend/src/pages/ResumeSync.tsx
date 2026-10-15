import { AlertTriangle, CheckCircle2, Clock, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Tabs } from "../components/ui";
import { useStore } from "../data/store";
import { api, errorMessage } from "../lib/api";
import { timeAgo } from "../lib/utils";
import type { SyncStateName } from "../types";

interface SyncStatus {
  s3Configured: boolean;
  total: number;
  counts: Record<SyncStateName, number>;
  queuedJobs: number;
  review: number;
  migration: { verified: number; total: number; startedAt: string };
  lastDriveSyncAt: string;
  lastJobAt: string | null;
}

interface SyncItem {
  id: string;
  candidateId: string | null;
  candidateName: string;
  fileName: string;
  state: SyncStateName;
  lastError: string | null;
  conflict: { on?: "content" | "name" | "both"; drive?: { name?: string }; s3?: { name?: string } } | null;
  deleteAfter: string | null;
  deletedSide: "drive" | "portal" | null;
  reviewReason: string | null;
  updatedAt: string;
}

type ListTab = "conflict" | "failed" | "pending_deletion" | "review";

export default function ResumeSync() {
  const toast = useStore((s) => s.toast);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [tab, setTab] = useState<ListTab>("conflict");
  const [items, setItems] = useState<SyncItem[]>([]);
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const [s, list] = await Promise.all([api.get<SyncStatus>("/api/sync/status"), api.get<SyncItem[]>(`/api/sync/items?state=${tab}`)]);
      setStatus(s);
      setItems(list);
    } catch (e) {
      toast(`Couldn't load sync status: ${errorMessage(e)}`, "error");
    }
  }, [tab, toast]);

  useEffect(() => {
    void load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (key: string, url: string, done: string) => {
    setBusy(key);
    try {
      await api.post(url);
      toast(done);
      await load();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy("");
    }
  };

  if (!status) return <p className="text-sm text-muted">Loading…</p>;
  if (!status.s3Configured)
    return <p className="text-sm text-muted">S3 isn't configured. Set AWS_REGION, S3_BUCKET, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY on the server (see DEPLOY.md), then restart it.</p>;

  const tiles: [string, number | string][] = [
    ["Total resumes", status.total],
    ["Synchronized", status.counts.synced],
    ["Pending operations", status.queuedJobs],
    ["Conflicts", status.counts.conflict],
    ["Failures", status.counts.failed],
    ["Pending deletion", status.counts.pending_deletion],
    ["Migrated to S3", `${status.migration.verified} of ${status.migration.total}`],
    ["Last Drive sync", status.lastDriveSyncAt ? timeAgo(status.lastDriveSyncAt) : "never"],
  ];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {tiles.map(([label, value]) => (
          <div key={label} className="card p-3">
            <p className="text-xs text-muted">{label}</p>
            <p className="mt-1 text-lg font-semibold">{value}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button icon={<RefreshCw size={14} />} disabled={!!busy} onClick={() => act("migrate", "/api/sync/migrate", "Migration queued")}>
          {status.migration.startedAt ? "Re-run migration" : "Start migration"}
        </Button>
        <Button disabled={!!busy || !status.counts.failed} onClick={() => act("retry-all", "/api/sync/retry-failed", "Failed items re-queued")}>
          Retry all failed
        </Button>
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "conflict", label: "Conflicts", count: status.counts.conflict },
          { value: "failed", label: "Failures", count: status.counts.failed },
          { value: "pending_deletion", label: "Pending deletion", count: status.counts.pending_deletion },
          { value: "review", label: "Needs review", count: status.review },
        ]}
      />

      {items.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">
          <CheckCircle2 size={16} className="mr-1 inline" /> Nothing here
        </p>
      ) : (
        <ul className="card divide-y divide-line">
          {items.map((it) => (
            <li key={it.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
              <div className="min-w-[200px] flex-1">
                <p className="text-sm font-semibold">{it.fileName}</p>
                <p className="text-xs text-muted">
                  {it.candidateName} · updated {timeAgo(it.updatedAt)}
                </p>
                {it.state === "conflict" && it.conflict?.on !== "content" && (
                  <p className="mt-1 text-xs text-ink-2">
                    Portal name “{it.conflict?.s3?.name}” vs Drive name “{it.conflict?.drive?.name}”
                  </p>
                )}
                {it.state === "conflict" && it.conflict?.on !== "name" && <p className="mt-1 text-xs text-ink-2">Changed in both the portal and Drive. Both versions are kept.</p>}
                {it.lastError && (
                  <p className="mt-1 text-xs text-danger">
                    <AlertTriangle size={12} className="mr-1 inline" />
                    {it.lastError}
                  </p>
                )}
                {it.deleteAfter && (
                  <p className="mt-1 text-xs text-ink-2">
                    <Clock size={12} className="mr-1 inline" />
                    Deleted {it.deletedSide === "drive" ? "in Drive" : "in the portal"} · removed {new Date(it.deleteAfter).toLocaleDateString()}
                  </p>
                )}
                {it.reviewReason === "missing_filename" && <p className="mt-1 text-xs text-ink-2">Drive gave no filename, so a fallback name was used.</p>}
              </div>
              {it.state === "conflict" && (
                <>
                  <Button size="sm" disabled={!!busy} onClick={() => act(it.id, `/api/sync/items/${it.id}/keep-portal`, "Keeping the portal version")}>
                    Keep portal
                  </Button>
                  <Button size="sm" disabled={!!busy} onClick={() => act(it.id, `/api/sync/items/${it.id}/keep-drive`, "Keeping the Drive version")}>
                    Keep Drive
                  </Button>
                </>
              )}
              {it.state === "failed" && tab === "failed" && (
                <Button size="sm" disabled={!!busy} onClick={() => act(it.id, `/api/sync/items/${it.id}/retry`, "Re-queued")}>
                  Retry
                </Button>
              )}
              {tab === "pending_deletion" && (
                <>
                  <Button size="sm" disabled={!!busy} onClick={() => act(it.id, `/api/sync/items/${it.id}/restore`, "Restored")}>
                    Restore
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    icon={<Trash2 size={13} />}
                    disabled={!!busy}
                    onClick={() => confirm(`Delete ${it.fileName} from S3 and Drive now?`) && act(it.id, `/api/sync/items/${it.id}/delete-now`, "Deleting")}
                  >
                    Delete now
                  </Button>
                </>
              )}
              {tab === "review" && (
                <Button size="sm" disabled={!!busy} onClick={() => act(it.id, `/api/sync/items/${it.id}/reviewed`, "Marked reviewed")}>
                  Mark reviewed
                </Button>
              )}
              <Badge tone={it.state === "failed" ? "danger" : it.state === "synced" ? "brand" : "warn"}>{it.state.replace("_", " ")}</Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
