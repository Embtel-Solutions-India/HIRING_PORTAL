/** Google Drive Changes API: the persistent checkpoint and incremental sync of tracked resumes. */
import * as google from "./google.ts";
import { getSetting, setSetting } from "./settings.ts";

/** Takes the change-feed bookmark before anything is migrated, so no change made during migration is missed. */
export async function ensureChangesCheckpoint() {
  if (!(await google.isConnected())) return;
  const st = await getSetting("driveChanges");
  if (st.pageToken) return;
  const root = await google.getFileMeta(await google.ensureRootFolder());
  const driveId = root.driveId ?? "";
  await setSetting("driveChanges", { pageToken: await google.getStartPageToken(driveId), driveId, lastSuccessAt: new Date().toISOString() });
}

export async function pollDriveChanges(): Promise<{ applied: number }> {
  await ensureChangesCheckpoint();
  return { applied: 0 };
}
