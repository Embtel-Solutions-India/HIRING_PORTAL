/** sync_jobs: the durable work queue. One worker (sync-jobs.ts) claims jobs one at a time. */
import { Prisma, prisma } from "./db.ts";
import { backoffMs, isPermanent, MAX_ATTEMPTS, type JobKind } from "./sync-rules.ts";

export type Db = Prisma.TransactionClient | typeof prisma;

export interface JobRow {
  id: string;
  resume_file_id: string;
  kind: JobKind;
  payload: Record<string, unknown>;
  attempts: number;
  last_error: string | null;
}

/** Adds a job, or merges into the one already queued for this resume and kind (never duplicates). */
export async function enqueue(resumeFileId: string, kind: JobKind, payload: Record<string, unknown> = {}, db: Db = prisma) {
  await db.$executeRaw`
    insert into sync_jobs (resume_file_id, kind, payload) values (${resumeFileId}::uuid, ${kind}, ${JSON.stringify(payload)}::jsonb)
    on conflict (resume_file_id, kind) where status = 'queued'
    do update set payload = sync_jobs.payload || excluded.payload, run_after = least(sync_jobs.run_after, now())`;
}

export async function claimNext(): Promise<JobRow | null> {
  const rows = await prisma.$queryRaw<JobRow[]>`
    update sync_jobs set status = 'running'
    where id = (select id from sync_jobs where status = 'queued' and run_after <= now() order by run_after, created_at limit 1 for update skip locked)
    returning id, resume_file_id, kind, payload, attempts, last_error`;
  return rows[0] ?? null;
}

export async function complete(jobId: string, db: Db = prisma, note?: string) {
  await db.sync_jobs.update({ where: { id: jobId }, data: { status: "done", finished_at: new Date(), last_error: note ?? null } });
}

export async function setPayload(jobId: string, payload: Record<string, unknown>) {
  await prisma.sync_jobs.update({ where: { id: jobId }, data: { payload: payload as Prisma.InputJsonValue } });
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

/** A job that won't run again passes its pre-generated Drive id to the queued twin, so the twin can't create a second file. */
async function handOverDriveId(job: JobRow) {
  if (!job.payload.newFileId) return;
  await prisma.$executeRaw`
    update sync_jobs set payload = payload || jsonb_build_object('newFileId', ${String(job.payload.newFileId)}::text)
    where resume_file_id = ${job.resume_file_id}::uuid and kind = ${job.kind} and status = 'queued' and payload->>'newFileId' is null`;
}

export async function fail(job: JobRow, err: unknown) {
  const message = errText(err);
  const attempts = job.attempts + 1;
  if (isPermanent(err, job.last_error) || attempts >= MAX_ATTEMPTS) {
    await handOverDriveId(job);
    await prisma.$transaction([
      prisma.sync_jobs.update({ where: { id: job.id }, data: { status: "failed", attempts, last_error: message, finished_at: new Date() } }),
      // Conflict / deletion states win over "failed": they need a person anyway.
      prisma.$executeRaw`update resume_files set last_error = ${message}, updated_at = now(),
        state = case when state in ('pending', 'synced') then 'failed' else state end where id = ${job.resume_file_id}::uuid`,
    ]);
    return;
  }
  const runAfter = new Date(Date.now() + backoffMs(attempts));
  const requeued = await prisma.$executeRaw`
    update sync_jobs set status = 'queued', attempts = ${attempts}, last_error = ${message}, run_after = ${runAfter}
    where id = ${job.id}::uuid and not exists (
      select 1 from sync_jobs q where q.resume_file_id = ${job.resume_file_id}::uuid and q.kind = ${job.kind} and q.status = 'queued')`;
  // A newer job of the same kind is already queued: it supersedes this one.
  if (!requeued) {
    await handOverDriveId(job);
    await complete(job.id, prisma, `superseded after: ${message}`);
  }
}

/** Admin "Retry": failed jobs go back to the queue with a fresh attempt count. */
export async function retryRow(resumeFileId: string) {
  const requeued = await prisma.$executeRaw`
    update sync_jobs j set status = 'queued', attempts = 0, run_after = now(), finished_at = null
    where j.resume_file_id = ${resumeFileId}::uuid and j.status = 'failed' and not exists (
      select 1 from sync_jobs q where q.resume_file_id = j.resume_file_id and q.kind = j.kind and q.status = 'queued')`;
  const queued = await prisma.sync_jobs.count({ where: { resume_file_id: resumeFileId, status: { in: ["queued", "running"] } } });
  if (!requeued && !queued) {
    // Failed without a job (e.g. lost Drive access): re-check from the source side.
    const row = await prisma.resume_files.findUnique({ where: { id: resumeFileId } });
    if (row) await enqueue(row.id, row.drive_file_id || !row.s3_key ? "to_s3" : "to_drive");
  }
  await prisma.resume_files.updateMany({ where: { id: resumeFileId, state: "failed" }, data: { state: "pending", last_error: null, updated_at: new Date() } });
}

/** After a crash, jobs left "running" go back to the queue (or are dropped if a twin is already queued). */
export async function resetRunning() {
  await prisma.$executeRaw`
    update sync_jobs q set payload = q.payload || jsonb_build_object('newFileId', j.payload->>'newFileId')
    from sync_jobs j
    where j.status = 'running' and j.payload->>'newFileId' is not null and q.status = 'queued'
      and q.resume_file_id = j.resume_file_id and q.kind = j.kind and q.payload->>'newFileId' is null`;
  await prisma.$executeRaw`
    update sync_jobs j set status = 'done', finished_at = now(), last_error = 'superseded after restart'
    where j.status = 'running' and exists (
      select 1 from sync_jobs q where q.resume_file_id = j.resume_file_id and q.kind = j.kind and q.status = 'queued')`;
  await prisma.$executeRaw`update sync_jobs set status = 'queued' where status = 'running'`;
}
