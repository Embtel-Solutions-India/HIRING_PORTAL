# Applications, Stage History and Resume Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split candidates into person + per-job applications with a permanent stage history, required rejection reasons, recent-first boards, a candidate pool, a Resume Library, reapply and duplicate merge.

**Architecture:**
- One SQL migration adds all new tables and columns, copies today's data across (one application per candidate), and drops the moved candidate columns.
- Backend application rules live in one new module, `backend/src/applications.ts`. Routes stay thin.
- The frontend keeps a `Candidate` (the person) and adds an `Application`. Board-style pages iterate applications and look up the person.

**Tech Stack:** Fastify 5, Prisma 7 (`prisma-client`, raw SQL migrations), Postgres, React 19 + zustand, Tailwind 4, Node ≥24 running `.ts` directly.

**Spec:** `docs/superpowers/specs/2026-10-19-applications-history-design.md`

## Global Constraints

- **Migrations:** hand-written SQL in `backend/prisma/migrations/<name>/migration.sql`, applied by `migrate()` (`backend/src/db.ts:13`) at startup. Update `backend/prisma/schema.prisma` to match, then run `npx prisma generate`.
- **Tests:** backend checks are `node:assert/strict` scripts against a local DB. They follow the style of `backend/scripts/check-sync-db.ts`: refuse a non-localhost `DATABASE_URL`, prefix test data, clean up at the end. No test framework is added. The frontend has no test runner; it is verified by `npm run typecheck`, `npm run build` and the manual steps.
- **Local DB:** `npm run dev:db` in `backend/` (embedded Postgres on 5433). Checks run with `DATABASE_URL=postgres://postgres:postgres@localhost:5433/hirely`.
- **Open application:** an application whose stage has `kind = 'active'`. Hired and closed applications are not open.
- **Commits:** every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Prod is live with S3 as primary** (memory: `s3-resume-sync-live`). Never remove AWS settings. `check:sync` and `check:sync-db` must still pass after every backend task.
- **Phase 1 (Tasks 1–4) lands together.** The app does not run between Task 1 and Task 4, because the migration drops candidate columns the old code reads. Phases 2–4 each ship on their own.

## Review Focus

1. **Undo of a rejection.** A move from a closed stage back to an active one needs no reason and keeps both history rows. Test in Task 2.
2. **Bulk move where some cards are already in the target stage.** Those are skipped with no history row, no touch and no email. Test in Task 2.
3. **Duplicate matching on messy input.** `" Aman@X.com "` matches `aman@x.com`, and `+91 98765-43210` matches `9876543210`. Empty email or phone never matches another empty one. Test in Task 11.
4. **A reason edited or retired after use.** Old history still shows the label as it was (snapshot). A retired reason can't be picked but its history survives. Test in Task 5.
5. **Reapplying to a job where the person was rejected before.** Allowed: closed applications repeat. An *open* application for the same job blocks it. Test in Task 10.

---

## Phase 1: Split

### Task 1: Migration 005 and schema

**Files:**
- Create: `backend/prisma/migrations/005_applications/migration.sql`
- Modify: `backend/prisma/schema.prisma` (models `candidates`, `interviews`, `notes`, `email_messages`, `activity`, `jobs`, `stages`, `users`, `sync_jobs`, plus new models)
- Create: `backend/scripts/check-applications-db.ts`
- Modify: `backend/package.json` (script `"check:applications-db": "node scripts/check-applications-db.ts"`)

**Interfaces:**
- Produces: tables `applications`, `stage_transitions`, `rejection_reasons`. Columns `interviews.application_id` (NOT NULL), `notes.application_id`, `email_messages.application_id`, `candidates.possible_duplicate_of`. Sync job kind `move_drive`. Prisma models of the same names.

- [ ] **Step 1: Write the invariant check `backend/scripts/check-applications-db.ts`**

Start with the localhost guard from `check-sync-db.ts`. Then add the first block, which later tasks append to:
```ts
// B1: backfill invariants
const orphans = await prisma.$queryRaw<{ n: number }[]>`select count(*)::int n from candidates c where not exists (select 1 from applications a where a.candidate_id = c.id)`;
assert.equal(orphans[0]!.n, 0, "B1: every candidate has an application");
const noHistory = await prisma.$queryRaw<{ n: number }[]>`select count(*)::int n from applications a where not exists (select 1 from stage_transitions t where t.application_id = a.id)`;
assert.equal(noHistory[0]!.n, 0, "B1: every application has at least one transition");
assert.equal(await prisma.interviews.count({ where: { application_id: null as never } }), 0, "B1: interviews linked");
assert.ok((await prisma.rejection_reasons.count()) >= 7, "B1: reasons seeded");
console.log("B1 ok");
```
End the file with `console.log("check-applications-db: all assertions passed"); await prisma.$disconnect();`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run check:applications-db` (in `backend/`, dev DB up)
Expected: FAIL, because `relation "applications" does not exist` / prisma has no `rejection_reasons`.

- [ ] **Step 3: Write the migration**

Everything runs in one transaction. Create these tables exactly:
```sql
create table rejection_reasons (id text primary key, label text not null, position int not null default 0, active boolean not null default true);
insert into rejection_reasons (id, label, position) values
  ('experience','Not enough experience',0),('skills','Skills mismatch',1),('salary','Salary expectations',2),
  ('withdrew','Candidate withdrew',3),('no_response','No response',4),('filled','Position filled',5),('other','Other',6);

create table applications (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references candidates(id) on delete cascade,
  job_id uuid references jobs(id) on delete set null,
  stage_id text not null references stages(id),
  owner_id uuid references users(id) on delete set null,
  applied_at timestamptz not null default now(),
  stage_entered_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  rating int not null default 0,
  starred boolean not null default false,
  summary jsonb,
  created_at timestamptz not null default now());
create index applications_candidate_idx on applications(candidate_id);
create index applications_board_idx on applications(stage_id, last_activity_at desc);
create index applications_job_idx on applications(job_id);

create table stage_transitions (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  from_stage_id text, to_stage_id text not null,
  actor_id uuid references users(id) on delete set null,
  reason_id text references rejection_reasons(id), reason_label text, note text,
  created_at timestamptz not null default now());
create index stage_transitions_app_idx on stage_transitions(application_id, created_at);
```

Then the data copy, in this order:
1. Insert one `applications` row per candidate, reusing **the candidate's id as the application id**, so existing URLs and email `?c=` links keep resolving during rollout. Copy `job_id, stage_id, owner_id, applied_at, stage_entered_at, rating, starred, summary, created_at`. Set `last_activity_at = greatest(stage_entered_at, max(notes.created_at), max(activity.created_at))` for that candidate.
2. Insert one transition per application: `from null` → `stage_id` at `stage_entered_at`, `actor_id null`.
3. `alter table interviews add application_id uuid references applications(id) on delete cascade`, then `update interviews set application_id = candidate_id`, then `set not null`.
4. Add `notes.application_id uuid references applications(id) on delete set null`, backfilled the same way.
5. Add `email_messages.application_id uuid references applications(id) on delete set null`, left null.
6. `alter table candidates add possible_duplicate_of uuid references candidates(id) on delete set null`, then drop the columns `job_id, stage_id, applied_at, stage_entered_at, owner_id, rating, starred, summary`.
7. `create index activity_candidate_idx on activity(candidate_id, created_at desc)`.
8. Replace the `sync_jobs` kind check constraint so it also allows `'move_drive'`.

Before step 6, find the dropped columns' foreign keys and indexes in `001_init`/`003_sources`. `drop column` removes them, but confirm nothing else (views, other checks) depends on them.

- [ ] **Step 4: Update `schema.prisma` and run `npx prisma generate`**

Add the models `applications`, `stage_transitions` and `rejection_reasons` with the relations above. Move the dropped fields off `candidates`. Add the back-relations on `jobs`, `stages`, `users`, `interviews`, `notes` and `email_messages`. Run `npx prisma validate`. Expected: no errors.

- [ ] **Step 5: Restart the dev backend (or `node -e "import('./src/db.ts').then(m=>m.migrate())"`), then run the check**

Run: `npm run check:applications-db`
Expected: `B1 ok` … `all assertions passed`.

- [ ] **Step 6: Commit**

`git add backend/prisma backend/scripts/check-applications-db.ts backend/package.json && git commit -m "feat(db): applications, stage history and rejection reasons"`

### Task 2: `applications.ts` core rules

**Files:**
- Create: `backend/src/applications.ts`
- Modify: `backend/src/activity.ts` (add `touch`, `touchCandidate`)
- Test: `backend/scripts/check-applications-db.ts` (append)

**Interfaces:**
- Consumes: `prisma` (`db.ts`), `type Db` (`sync-queue.ts:5`), `HttpError` (`http.ts`), `logActivity` (`activity.ts`).
- Produces:
  - `touch(applicationIds: string[], db?: Db): Promise<void>`: sets `last_activity_at = now()`.
  - `touchCandidate(candidateId: string, db?: Db): Promise<void>`: touches all of the person's **open** applications.
  - `createApplication(input: { candidateId: string; jobId: string | null; actorId: string | null; ownerId?: string | null }, db?: Db): Promise<string>`:
    - creates at the first active stage (by `position`) and writes a transition from `null`,
    - **409 `"<Name> already has an open application for this job"`** if an open one exists for the same non-null `jobId`.
  - `moveApplications(input: { ids: string[]; stageId: string; actorId: string | null; reasonId?: string | null; note?: string | null }): Promise<{ id: string; candidateId: string }[]>`:
    - moves only applications not already in `stageId`,
    - for each moved application: updates `stage_id`, `stage_entered_at`, `last_activity_at`, inserts a transition with `reason_label` copied from the reason, and logs `stage_change` with the candidate id and the message `moved <Name> to <Stage>` plus `` · <reason label>`` when rejected,
    - **400 `"Unknown stage"`**, **400 `"Pick a reason for not moving forward"`** when the target is `kind='closed'` and `reasonId` is missing or not an `active` reason,
    - returns the moved rows.
  - `latestApplicationIds(candidateIds: string[]): Promise<Map<string, string>>`: candidate id → their most recently touched application id.
  - `newestOpenApplication(candidateId: string): Promise<{ id: string; jobId: string | null } | null>`: the most recently **created** open application.

- [ ] **Step 1: Append failing checks**

Create a test person with `prisma.candidates.create({ data: { first_name: "CHK", last_name: "App" } })` and an application via `createApplication`. Keep stage ids by looking up the first `active` and the first `closed` stage.
```ts
// A1: move writes history + touches
const before = (await prisma.applications.findUniqueOrThrow({ where: { id: appId } })).last_activity_at;
await moveApplications({ ids: [appId], stageId: active2, actorId: null });
const t = await prisma.stage_transitions.findMany({ where: { application_id: appId }, orderBy: { created_at: "asc" } });
assert.equal(t.length, 2, "A1: entry + move");
assert.equal(t[1]!.to_stage_id, active2);
assert.ok((await prisma.applications.findUniqueOrThrow({ where: { id: appId } })).last_activity_at > before, "A1: touched");
// A2: closed needs a reason
await assert.rejects(moveApplications({ ids: [appId], stageId: closed, actorId: null }), /Pick a reason/, "A2");
await moveApplications({ ids: [appId], stageId: closed, actorId: null, reasonId: "skills", note: "no React" });
const last = (await prisma.stage_transitions.findFirst({ where: { application_id: appId }, orderBy: { created_at: "desc" } }))!;
assert.deepEqual([last.from_stage_id, last.reason_label, last.note], [active2, "Skills mismatch", "no React"], "A2: recorded");
// A3 (Review Focus 1): undo out of closed needs no reason, history keeps both
await moveApplications({ ids: [appId], stageId: active2, actorId: null });
assert.equal(await prisma.stage_transitions.count({ where: { application_id: appId } }), 4, "A3");
// A4 (Review Focus 2): already-in-stage is skipped silently
const moved = await moveApplications({ ids: [appId], stageId: active2, actorId: null });
assert.equal(moved.length, 0, "A4: nothing moved");
assert.equal(await prisma.stage_transitions.count({ where: { application_id: appId } }), 4, "A4: no new row");
```
`actorId` is `string | null`, because system actions such as bookings have no actor.

- [ ] **Step 2: Run, expect FAIL** with `Cannot find module '../src/applications.ts'`.
- [ ] **Step 3: Implement `applications.ts` and the two touch helpers** to the interfaces above. Do the per-application transition inserts and the update in one `prisma.$transaction`.
- [ ] **Step 4: Run `npm run check:applications-db`.** Expected: `A1 ok` … `A4 ok`.
- [ ] **Step 5: Commit** `feat(applications): move, history, required reason, touch`

### Task 3: Backend switched to applications

**Files:**
- Modify:
  - `backend/src/serialize.ts` (split `candidate()`, add `application()`)
  - `backend/src/routes/bootstrap.ts`
  - `backend/src/routes/candidates.ts`
  - `backend/src/pipeline.ts`
  - `backend/src/drive.ts`
  - `backend/src/resume-files.ts:76-84` (restore)
  - `backend/src/sync-jobs.ts:76-79` (`folderForRow`)
  - `backend/src/scheduling.ts:24-75`
  - `backend/src/routes/interviews.ts`
  - `backend/src/routes/public.ts:96-120`
  - `backend/src/email.ts:84-135`
  - `backend/src/routes/sources.ts` (nothing to change: `source_id` stays on the person)
  - `backend/src/routes/admin.ts` (stage-delete check `:310` and job-delete check now query `applications`)
  - `backend/src/http.ts` (nothing to change: `assertCandidateAccess` stays person-level)
- Create: `backend/src/routes/applications.ts`. Register it in `backend/src/index.ts` next to the candidates routes.
- Test: `backend/scripts/check-applications-db.ts` (append), plus the existing `check:sync-db`.

**Interfaces:**
- Consumes: Task 2 functions.
- Produces (HTTP):
  - `POST /api/applications/move` with body `{ ids: uuid[] (1–500), stageId, notify?, reasonId?, note? (≤1000) }`, returning `{ moved, emailed }`.
    - permission `candidates.moveStage`,
    - the auto email logic from `candidates.ts:50-56`, with `recipients` built from the moved rows.
  - `PATCH /api/applications/:id` with body `{ rating?, starred?, ownerId?: uuid|null, jobId?: uuid|null }`.
    - permission: `candidates.edit` for owner/job, `candidates.addNote` for rating/starred,
    - access via `assertCandidateAccess(user, app.candidate_id)`.
  - `POST /api/applications/:id/resummarize` replaces the candidate route.
  - `PATCH /api/candidates/:id` keeps only `tags, firstName, lastName, email, phone, location`.
  - `POST /api/candidates/:id/notes` accepts an optional `applicationId`.
  - `POST /api/interviews` takes `applicationId` instead of `candidateId`.
- Produces (serializers):
  - `s.application(a: Row, outcome: Row | null): Application`
  - `s.candidate(c: Row, notes: Row[]): Candidate`, without the moved fields, plus `possibleDuplicateOf: string`.
  - The bootstrap response gains `applications: Application[]` and `rejectionReasons: RejectionReason[]`.
- Produces (functions):
  - `createCandidate(...)` in `pipeline.ts` keeps its signature, creates the person **and** calls `createApplication`, and returns the **candidate** id.
  - `createCampaign(input: { recipients: { candidateId: string; applicationId: string | null }[]; subject; body; templateId?; scheduledAt?; actorId })`. `recipientIds` is gone; a manual compose maps through `latestApplicationIds`.
  - `createInterview(input: { applicationId: string; … })`, which reads the candidate and job from the application.

Rules the code doesn't spell out:
- **Bootstrap.** Applications are scoped like candidates: everything for `candidates.viewAll`, otherwise only those whose person the user interviews. `outcome` = the latest transition **into a closed stage** for each application (one `distinct on (application_id)` query), serialized as `{ reasonId, reasonLabel, fromStageId, actorId, note, at }`. Replace the candidate query's `include` with a `select` that leaves out `resume_text`.
- **Parse queue (`pipeline.ts:72`).** Parsing is per person. The AI summary is per **open** application. After parsing, loop over the person's open applications and call `analyzeResume(text, job)`. The first call also supplies the profile fields; store each `summary` on its application. `ponytail:` one AI call per open application. Skip the profile fields after the first call if cost matters.
- **Public booking (`public.ts:96`).** The `c` query param may be a candidate id or (old links) an application id. Both resolve, thanks to Task 1's id reuse. Book on `newestOpenApplication(candidateId)`, or else the latest application.
- **Email `sendCampaign`.** Job and stage merge fields come from `email_messages.application_id`, joined to `applications → jobs/stages`.
- **`folderForRow`.** Uses `newestOpenApplication(row.candidate_id)?.jobId`.

- [ ] **Step 1: Append failing checks**
```ts
// S1: createCandidate makes person + one open application with an entry transition
const cid = await createCandidate({ resume: { storage: "local", driveFileId: "", fileName: "CHK.pdf", mimeType: "application/pdf", sizeKb: 1, uploadedAt: new Date().toISOString(), uploadedById: "", driveUrl: "" }, jobId: null, sourceId: null, intake: "upload", actorId: null });
const apps = await prisma.applications.findMany({ where: { candidate_id: cid } });
assert.equal(apps.length, 1, "S1");
assert.equal(await prisma.stage_transitions.count({ where: { application_id: apps[0]!.id } }), 1, "S1: entry row");
```
(The parse queue will try to read the missing file and mark it `failed`, which is fine for this check.)

- [ ] **Step 2: Run, expect FAIL** (Prisma type errors, or the old `job_id` column missing at runtime).
- [ ] **Step 3: Update every file in the list to the interfaces above.**
- [ ] **Step 4: Verify.** Run `npm run typecheck`, then `npm run check:sync`, `npm run check:sync-db`, `npm run check:applications-db`. Expected: all pass. `grep -rn "job_id\|stage_id" src --include=*.ts | grep candidates` shows nothing outside `generated/`.
- [ ] **Step 5: Commit** `feat(api): serve and mutate applications`

### Task 4: Frontend switched to applications

**Files:**
- Modify:
  - `frontend/src/types.ts`
  - `frontend/src/data/store.ts`
  - `frontend/src/pages/{Pipeline,Review,Candidates,CandidateDetail,Dashboard,Email,Interviews,Jobs}.tsx`
  - `frontend/src/components/{candidate,CandidateQuickView,ComposeEmailModal,ScheduleInterviewModal,UploadResumeModal,AppShell}.tsx`
  - `frontend/src/data/seed.ts` and `backend/scripts/seed-demo.ts` (the seeder now inserts applications)

**Interfaces:**
- Produces (`types.ts`):
  ```ts
  export interface Application { id: string; candidateId: string; jobId: string; stageId: string; appliedAt: string; stageEnteredAt: string; lastActivityAt: string; ownerId: string; rating: number; starred: boolean; summary: AiSummary; outcome: Outcome | null; }
  export interface Outcome { reasonId: string; reasonLabel: string; fromStageId: string; actorId: string; note: string; at: string; }
  export interface RejectionReason { id: string; label: string; position: number; active: boolean; }
  export interface Note { id: string; authorId: string; body: string; createdAt: string; applicationId: string; }
  ```
  `Candidate` loses `jobId, stageId, appliedAt, stageEnteredAt, ownerId, rating, starred, summary` and gains `possibleDuplicateOf: string`. `Interview` gains `applicationId`.
- Produces (store):
  - `Data` gains `applications: Application[]` and `rejectionReasons: RejectionReason[]`.
  - `moveStage(applicationIds, stageId, opts?: { notify?; reasonId?; note? })` posts to `/api/applications/move`, optimistically setting `stageId`, `stageEnteredAt` and `lastActivityAt`.
  - `setRating(applicationId, …)`, `toggleStar(applicationId)` and `resummarize(applicationId)` all hit `/api/applications/:id`.
  - `addNote(candidateId, body, applicationId?)`.
- Produces (hooks in `store.ts`):
  - `useCandidateMap(): Record<string, Candidate>`,
  - `useCards(): { app: Application; candidate: Candidate }[]` (memoized join, skipping apps whose candidate isn't loaded),
  - `useApplicationsOf(candidateId): Application[]` (newest `createdAt`/`appliedAt` first).
- `MoveStageMenu` props: `candidateIds` becomes `applicationIds`. `SummaryCard` takes `summary: AiSummary` in place of reading `candidate.summary`.

Pattern for each page: anything that was a card or row per candidate with job/stage becomes per `useCards()` entry (Pipeline, Review, Dashboard funnels, Jobs counts). `card.app.stageId` replaces `c.stageId`, and person fields come from `card.candidate`. Candidate-level pages (Candidates list, CandidateDetail) show the **latest** application for job/stage, `useApplicationsOf(id)[0]`, until Task 8 expands them. Email recipients stay candidate ids.

- [ ] **Step 1: Update `types.ts` and the store, then run `npm run typecheck`.** Expected: errors in every page listed. That compiler output is the to-do list.
- [ ] **Step 2: Fix each file until `npm run typecheck` passes**, then `npm run build`. Expected: `✓ built`.
- [ ] **Step 3: Manual check** at `localhost:5173` against the migrated dev DB:
  - the board looks as it did before, and drag-drop still works,
  - the profile shows job and stage,
  - Review swipe advances,
  - scheduling an interview works,
  - compose an email with `{{job_title}}` and confirm the server log shows the right job (`EMAIL_TRANSPORT=log`).
- [ ] **Step 4: Commit** `feat(ui): pipeline, review and profile read applications`

## Phase 2: History, required reasons, recent-first

### Task 5: Rejection reasons and the reject dialog

**Files:**
- Modify: `backend/src/routes/admin.ts` (routes), `frontend/src/data/store.ts`, `frontend/src/pages/Settings.tsx` (Pipeline tab), `frontend/src/components/AppShell.tsx` (mount the dialog), the callers in `Pipeline.tsx:85-98`, `Review.tsx:130-172`, `components/candidate.tsx` (`MoveStageMenu`), `CandidateDetail.tsx`
- Create: `frontend/src/components/RejectDialog.tsx`
- Test: `backend/scripts/check-applications-db.ts` (append)

**Interfaces:**
- Produces (HTTP), permission `settings.pipeline`:
  - `PUT /api/settings/rejection-reasons` with body `{ id?: string; label: string (1–60); active: boolean }[]` (order = position).
  - New labels get a slug id. A reason used by any transition is never deleted, only set `active=false`.
  - Reasons are read through bootstrap (`rejectionReasons`).
- Produces (store), the single entry point for every move in the UI:
  - `requestMove(applicationIds: string[], stageId: string, opts?: { notify?: boolean }): Promise<boolean>`. If the target stage is `closed`, it sets `rejectPrompt: { applicationIds, stageId, notify, resolve }` and waits. Otherwise it calls `moveStage`.
  - `resolveRejectPrompt(choice: { reasonId: string; note: string } | null)`.
- `RejectDialog`:
  - reads `rejectPrompt` and shows the **active** reasons as chips, numbered 1–9 with key shortcuts, plus an optional note (≤1000) and Confirm (disabled until a reason is picked),
  - title: `Not moving forward · N candidate(s)`,
  - Esc or Cancel resolves `null`, so no move happens and the dragged card snaps back.

- [ ] **Step 1: Append a failing check (Review Focus 4)**

Call the route handler's helper. Put the reason-save logic in `saveRejectionReasons(list)` in `applications.ts` so it can be tested.
```ts
await moveApplications({ ids: [appId], stageId: closed, actorId: null, reasonId: "salary" });
await saveRejectionReasons((await prisma.rejection_reasons.findMany({ orderBy: { position: "asc" } })).filter((r) => r.id !== "salary").map((r) => ({ id: r.id, label: r.label, active: r.active })));
const salary = await prisma.rejection_reasons.findUnique({ where: { id: "salary" } });
assert.equal(salary?.active, false, "R1: used reason retired, not deleted");
assert.ok(await prisma.stage_transitions.findFirst({ where: { application_id: appId, reason_label: "Salary expectations" } }), "R1: label snapshot kept");
await assert.rejects(moveApplications({ ids: [appId], stageId: active2, actorId: null }).then(() => moveApplications({ ids: [appId], stageId: closed, actorId: null, reasonId: "salary" })), /Pick a reason/, "R1: retired reason can't be picked");
```
Restore the seed reasons at the end of the block.

- [ ] **Step 2: Run, expect FAIL** with `saveRejectionReasons` not exported.
- [ ] **Step 3: Implement** `saveRejectionReasons(list: { id?: string; label: string; active: boolean }[]): Promise<void>` in `applications.ts`, the route, the store prompt, `RejectDialog` and the Settings editor. Switch every caller from `moveStage` to `requestMove`:
  - the Pipeline drop,
  - the Review R key / "Not a fit",
  - `MoveStageMenu` (bulk),
  - a new **Reject** button next to the stepper in `CandidateDetail`, scoped to the shown application.

  The Undo toast calls `moveStage` directly (moving out of closed needs no reason).
- [ ] **Step 4: Verify.** Run `npm run check:applications-db` and both typechecks. Then manually:
  - drag to "Not moving forward" → the dialog appears,
  - Esc → the card snaps back,
  - pick "2" → the card moves and the toast offers Undo,
  - the Review R key → the dialog appears, and 1–9 works.
- [ ] **Step 5: Commit** `feat: required rejection reasons on every path into a closed stage`

### Task 6: Touch on meaningful activity, recent-first board

**Files:**
- Modify:
  - `backend/src/routes/candidates.ts` (notes, profile PATCH, resume replace/rename)
  - `backend/src/routes/applications.ts` (owner/job PATCH)
  - `backend/src/routes/interviews.ts` (schedule via `scheduling.ts`, cancel, feedback)
  - `backend/src/routes/sources.ts:69-86`
  - `frontend/src/pages/Pipeline.tsx:190`
  - `frontend/src/data/store.ts` (optimistic `lastActivityAt` on note, move)
- Test: `backend/scripts/check-applications-db.ts` (append)

**Interfaces:**
- Consumes: `touch`, `touchCandidate` (Task 2).

Touch map, exactly:

| Event | Touches |
|---|---|
| note added with `applicationId` | that application |
| note added without one | `touchCandidate` |
| interview scheduled / cancelled / feedback | the interview's `application_id` |
| resume replaced / renamed | `touchCandidate` |
| profile PATCH (name, email, phone, location) | `touchCandidate` |
| application PATCH owner/job | that application |
| source tagged | `touchCandidate` for each tagged person |

- Rating, starred and tags never touch.
- The profile PATCH also logs an activity: type `"candidate_updated"` (add it to `ActivityType`), message `updated <field list> on <Name>`.
- Interview feedback logs type `"interview_feedback"` instead of `"note"` (add it too).

Board sort in `Pipeline.tsx`: `items.sort((a, b) => b.app.lastActivityAt.localeCompare(a.app.lastActivityAt))`. Remove the starred/score ordering; the badges stay.

- [ ] **Step 1: Append failing checks**
```ts
// T1: note on an application touches only that one; starring touches nothing
const t0 = (await prisma.applications.findUniqueOrThrow({ where: { id: appId } })).last_activity_at;
await addNote({ candidateId: personId, applicationId: appId, body: "x", actorId: null }); // helper extracted from the route
assert.ok((await prisma.applications.findUniqueOrThrow({ where: { id: appId } })).last_activity_at > t0, "T1: note touches");
const t1 = (await prisma.applications.findUniqueOrThrow({ where: { id: appId } })).last_activity_at;
await updateApplication(appId, { starred: true }, null);
assert.equal((await prisma.applications.findUniqueOrThrow({ where: { id: appId } })).last_activity_at.getTime(), t1.getTime(), "T1: star doesn't touch");
await updateApplication(appId, { ownerId: null }, null);
assert.ok((await prisma.applications.findUniqueOrThrow({ where: { id: appId } })).last_activity_at > t1, "T1: owner change touches");
```
Both helpers live in `applications.ts`, and the routes call them:
- `addNote(input: { candidateId: string; applicationId?: string | null; body: string; actorId: string | null }): Promise<void>`
- `updateApplication(id: string, patch: { rating?: number; starred?: boolean; ownerId?: string | null; jobId?: string | null }, actorId: string | null): Promise<void>`

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement the touch map and the board sort.**
- [ ] **Step 4: Verify.** Run the checks and typechecks. Then manually:
  - add a note on the third card in a column → it jumps to the top,
  - open the board in a second browser → the same order within 20 s,
  - star a card → it does not move.
- [ ] **Step 5: Commit** `feat: recently touched cards first`

## Phase 3: Pool and library

### Task 7: Profile applications and full history

**Files:**
- Modify: `backend/src/routes/candidates.ts` (new GET), `frontend/src/pages/CandidateDetail.tsx`, `frontend/src/data/store.ts`
- Create: `frontend/src/components/ApplicationCard.tsx`

**Interfaces:**
- Produces:
  - `GET /api/candidates/:id/history` returns `{ transitions: { id, applicationId, fromStageId, toStageId, actorId, reasonLabel, note, createdAt }[]; activity: ActivityEvent[] }`.
    - access: `candidates.view` plus `assertCandidateAccess`,
    - ordered oldest → newest for transitions and newest → oldest for activity, with no cap.
  - Store: `fetchHistory(candidateId): Promise<CandidateHistory | null>`, not cached in global state. The page loads it on mount and after its own mutations.
- `ApplicationCard({ app, transitions })`:
  - job title, the stepper (moved from `CandidateDetail.tsx:152-176`, now per application), the outcome badge (reason, who, when), and the transition timeline (`From → To · who · when · reason · note`),
  - the newest application is expanded; older ones are collapsed.
- Notes list: each note shows a job label when `applicationId` is set. The note composer has a job picker defaulting to the newest application.
- Interviews tab: grouped by application.
- Activity tab: reads `history.activity` instead of the global `store.activity` filter (`CandidateDetail.tsx:56`).

- [ ] **Step 1: Implement the route and the UI.** No backend logic beyond two queries; covered by the typecheck.
- [ ] **Step 2: Verify.** Run both typechecks and the build. Then manually: a person moved and rejected in Task 5 shows every transition with reason and note, and the Activity tab shows events older than the latest 300.
- [ ] **Step 3: Commit** `feat(profile): applications with full stage history`

### Task 8: Candidate pool

**Files:**
- Modify: `frontend/src/pages/Candidates.tsx`
- Create: `frontend/src/lib/pool.ts`
- Test: `frontend/src/lib/pool.check.ts`, run with `node frontend/src/lib/pool.check.ts`. Node ≥24 strips the types, so no framework is needed.

**Interfaces:**
- Produces:
  ```ts
  export interface PoolFilter { q: string; jobId: string; outcome: "" | "active" | "hired" | "rejected"; rejectedFromStageId: string; reasonId: string; includeClosed: boolean }
  export function matchesPool(candidate: Candidate, apps: Application[], stages: Record<string, Stage>, f: PoolFilter): boolean
  ```
- Rules:
  - A person matches if **any** application matches all of the application filters (`jobId`, `outcome`, `rejectedFromStageId`, `reasonId`).
  - With `jobId` set, only that job's applications are considered.
  - `outcome` comes from the application's stage kind: `active` / `hired` / `closed` → `"rejected"`.
  - `includeClosed=false` hides people whose applications are **all** closed.
  - The text search is today's (`Candidates.tsx:58-72`) on the person.
- Rows are one per person: name, the latest application's job and stage, `N applications`, last activity.

- [ ] **Step 1: Write `pool.check.ts`** with asserts:
  - a person rejected for A and active for B matches `outcome: "rejected"` and `outcome: "active"`,
  - with `jobId: B` they match `active` but not `rejected`,
  - `rejectedFromStageId` and `reasonId` read `app.outcome`,
  - `includeClosed: false` hides an all-closed person and keeps the A-rejected / B-active one.
- [ ] **Step 2: Run, expect FAIL** (no module).
- [ ] **Step 3: Implement `pool.ts` and the filters UI.** Add selects for outcome, job, rejected-from stage and reason, plus a toggle "Include past candidates" that defaults on, all next to the existing filters.
- [ ] **Step 4: Verify.** Run `node frontend/src/lib/pool.check.ts` and `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(candidates): searchable pool with outcome, job, stage and reason filters`

### Task 9: Resume Library

**Files:**
- Create: `frontend/src/pages/Resumes.tsx`
- Modify: `frontend/src/App.tsx` (route `resumes`), `frontend/src/components/AppShell.tsx` (nav item "Resumes", icon `FileText`, `permission: "resumes.download"`)

**Interfaces:**
- Consumes: `ResumePreview` (`components/candidate.tsx:17`) for the side panel, `resumeUrl()` for download, and `useApplicationsOf`.
- Rows: one per candidate with `resume.fileName !== "No resume"`. Columns: file name, person (link `/candidates/:id`), the latest job and stage, uploaded (`fmtDate`), parse status (from the latest application's `summary.status`), storage plus `syncState` badge.
- Search covers file name, person name, email and skills. Filters: parse status (`pending|failed|ready`), sync state (`SyncStateName`) and job.
- Clicking a row opens the preview panel. Nothing on this page creates or changes candidates.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Verify.** Run the typecheck and build. Then manually: the list matches the candidate count, a PDF and a DOCX both preview, download works, and an Interviewer role (no `resumes.download`) doesn't see the nav item.
- [ ] **Step 3: Commit** `feat: resume library`

## Phase 4: Reapply and duplicates

### Task 10: Consider for another job

**Files:**
- Modify: `backend/src/routes/candidates.ts`, `backend/src/sync-jobs.ts` (new `move_drive` kind), `backend/src/sync-queue.ts` (`JobKind`), `frontend/src/pages/CandidateDetail.tsx`, `frontend/src/data/store.ts`
- Test: `backend/scripts/check-applications-db.ts` (append)

**Interfaces:**
- Consumes: `createApplication` (Task 2), `newestOpenApplication`, `google.moveFile` (`google.ts`), `driveFolderFor` (`storage.ts:39`).
- Produces:
  - `POST /api/candidates/:id/applications` with body `{ jobId: uuid }`, returning `{ id }`.
    - permission `candidates.moveStage`, access check,
    - logs `stage_change` `considered <Name> for <Job>`,
    - then enqueues `move_drive` on the person's `resume_files` row if there is one and Google is connected.
  - Sync job `move_drive`: moves `row.drive_file_id` into `folderForRow(row)` (same retry and backoff as the other kinds), and does nothing if there is no Drive file yet.
  - Store: `considerForJob(candidateId, jobId): Promise<boolean>`.
- UI: a **Consider for another job** button on the profile opens a job picker (open jobs only). Jobs where the person has an open application are disabled, labelled "already in process".

- [ ] **Step 1: Append failing checks (Review Focus 5)**
```ts
// RA1: a closed application for job J doesn't block; an open one does
const j = await prisma.jobs.create({ data: { title: "CHK Job" } });
const first = await createApplication({ candidateId: personId, jobId: j.id, actorId: null });
await moveApplications({ ids: [first], stageId: closed, actorId: null, reasonId: "skills" });
const second = await createApplication({ candidateId: personId, jobId: j.id, actorId: null });
assert.notEqual(first, second, "RA1: reapply after rejection allowed");
assert.equal((await prisma.applications.findUniqueOrThrow({ where: { id: first } })).stage_id, closed, "RA1: old outcome untouched");
await assert.rejects(createApplication({ candidateId: personId, jobId: j.id, actorId: null }), /already has an open application/, "RA1: open one blocks");
// RA2: move_drive job with no Drive file is a no-op
const rf = await prisma.resume_files.create({ data: { candidate_id: personId, file_name: "cv.pdf", mime_type: "application/pdf", state: "synced" } });
await enqueue(rf.id, "move_drive");
await runJob((await claimNext())!);
assert.equal((await prisma.sync_jobs.findFirstOrThrow({ where: { resume_file_id: rf.id, kind: "move_drive" } })).status, "done", "RA2");
```
- [ ] **Step 2: Run, expect FAIL** (`move_drive` not handled / not a valid kind before Task 1's constraint is used).
- [ ] **Step 3: Implement** the route, the `move_drive` case in the `runJob` switch (`sync-jobs.ts:235`), the `JobKind` union, the store action and the UI.
- [ ] **Step 4: Verify.** Run `check:applications-db`, `check:sync-db` and both typechecks. Then manually, with Drive connected: consider a rejected person for Job B → two application cards, the old one still rejected; within a sync cycle the Drive file sits in Job B's folder.
- [ ] **Step 5: Commit** `feat: consider an existing candidate for another job`

### Task 11: Duplicate detection

**Files:**
- Modify: `backend/src/applications.ts` (`findDuplicate`), `backend/src/pipeline.ts` (call after a successful parse), `backend/src/routes/candidates.ts` (`POST /api/candidates/:id/keep-separate`), `frontend/src/pages/{CandidateDetail,Review}.tsx`
- Create: `frontend/src/components/DuplicateBanner.tsx`
- Test: `backend/scripts/check-applications-db.ts` (append)

**Interfaces:**
- Produces:
  - `findDuplicate(candidateId: string): Promise<string | null>`. It returns the **oldest** other candidate where:
    - `lower(trim(email))` equals this person's (both non-empty), **or**
    - the last 10 digits of `regexp_replace(phone, '\D', '', 'g')` are equal and at least 10 digits long.

    It never returns the person themselves. Matches with someone this person was already kept separate from are skipped: record that as `candidates.tags` containing `"kept-separate:<otherId>"`. *Decision: no extra table.*
  - After the parse transaction (`pipeline.ts:113`), set `possible_duplicate_of = await findDuplicate(id)`.
  - `POST /api/candidates/:id/keep-separate` (permission `candidates.edit`) clears the flag and adds the tag.
  - `DuplicateBanner({ candidate })`: "Looks like **<Name>** (<n> applications)" with **Merge into <Name>** (Task 12) and **Keep separate**. It shows on the profile header and on the Review card when `possibleDuplicateOf` is set.

- [ ] **Step 1: Append failing checks (Review Focus 3)**
```ts
const a = await prisma.candidates.create({ data: { first_name: "CHK", last_name: "A", email: "aman@x.com", phone: "9876543210" } });
const b = await prisma.candidates.create({ data: { first_name: "CHK", last_name: "B", email: " Aman@X.com ", phone: "" } });
const c = await prisma.candidates.create({ data: { first_name: "CHK", last_name: "C", email: "", phone: "+91 98765-43210" } });
const d = await prisma.candidates.create({ data: { first_name: "CHK", last_name: "D", email: "", phone: "" } });
const e = await prisma.candidates.create({ data: { first_name: "CHK", last_name: "E", email: "", phone: "" } });
assert.equal(await findDuplicate(b.id), a.id, "D1: email case/space");
assert.equal(await findDuplicate(c.id), a.id, "D1: phone formatting");
assert.equal(await findDuplicate(d.id), null, "D1: empty never matches empty");
assert.equal(await findDuplicate(a.id), null, "D1: oldest has no older duplicate");
```
"Oldest" is by `created_at`. `findDuplicate(a)` returns null because b and c are newer: a duplicate always points at the older record. Clean up a–e at the end.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** with a raw SQL query in `findDuplicate`, plus the hook, the route and the banner.
- [ ] **Step 4: Verify.** Run the checks and typechecks. Then manually: upload the same resume twice → after parsing, the second shows the banner; Keep separate removes it and it stays gone after a re-parse.
- [ ] **Step 5: Commit** `feat: flag possible duplicate candidates`

### Task 12: Merge

**Files:**
- Modify: `backend/src/applications.ts` (`mergeCandidate`), `backend/src/routes/candidates.ts`, `frontend/src/components/DuplicateBanner.tsx`, `frontend/src/data/store.ts`
- Test: `backend/scripts/check-applications-db.ts` (append)

**Interfaces:**
- Consumes: the replace-resume logic in `candidates.ts:204-236`. Extract it to `replaceResumeFile(candidateId: string, file: { fileName: string; data: Buffer }, actorId: string | null): Promise<void>` in `backend/src/resume-files.ts`, so the route and merge share it. Also `markCandidatesDeleted` (`resume-files.ts:47`) and `newestOpenApplication`.
- Produces:
  - `mergeCandidate(dupId: string, targetId: string, actorId: string | null): Promise<void>`
  - `POST /api/candidates/:id/merge-into/:targetId` (permission `candidates.moveStage`, access to both), returning `{ ok: true }`
  - store `mergeCandidate(dupId, targetId): Promise<boolean>`, which navigates to the target's profile.

`mergeCandidate` order (the spec's merge steps 1–4):
1. **File first (outside the transaction).** If the duplicate has a readable resume, `readResume` it and `replaceResumeFile(targetId, …)`. On failure, throw before touching any rows.
2. **One transaction:**
   - for each duplicate application: if the target has an **open** application for the same non-null job, re-point the duplicate's interviews and notes to the target's application and delete the duplicate's application; otherwise set `candidate_id = targetId`,
   - re-point the remaining duplicate notes (`candidate_id`),
   - re-point `activity.candidate_id` and `email_messages.candidate_id` to the target,
   - clear the target's `possible_duplicate_of`.
3. If any application moved to the target in step 2, enqueue `move_drive` for the target's resume row.
4. `markCandidatesDeleted([dupId])`. The duplicate's own resume file goes into the normal grace period.
5. `logActivity(actorId, "stage_change", "merged <Dup> into <Target>", targetId)`.

- [ ] **Step 1: Append failing checks**
```ts
// M1: different job moves over; same open job folds in; one person remains
const target = /* person with open app on job J1 */, dup = /* person with open app on J1 + open app on J2, one note, one interview on the J1 app */;
await mergeCandidate(dup.id, target.id, null);
assert.equal(await prisma.candidates.count({ where: { id: dup.id } }), 0, "M1: dup gone");
const tApps = await prisma.applications.findMany({ where: { candidate_id: target.id } });
assert.equal(tApps.length, 2, "M1: J1 folded, J2 moved");
assert.equal(await prisma.interviews.count({ where: { application_id: targetJ1App } }), 1, "M1: interview re-pointed to target's J1 app");
assert.equal(await prisma.notes.count({ where: { candidate_id: target.id } }), 1, "M1: note moved");
```
Build the fixtures with `createApplication` and direct `prisma` inserts. Give neither person a resume, so step 1 is skipped.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `replaceResumeFile` (move the code, and have the route call it), `mergeCandidate`, the route and the banner's Merge button (with a confirm: "Merge <Dup> into <Target>? Their applications, notes and interviews move over; this can't be undone.").
- [ ] **Step 4: Verify.** Run `check:applications-db`, `check:sync-db` and both typechecks. Then manually: upload the same person to two jobs → Merge → one person with two applications, the newest resume on the profile, and the Drive file in the newest job's folder.
- [ ] **Step 5: Commit** `feat: merge duplicate candidates`

---

## Final verification (after Task 12)

- `backend/`: `npm run typecheck && npm run check:sync && npm run check:sync-db && npm run check:applications-db`
- `frontend/`: `npm run typecheck && npm run build && node src/lib/pool.check.ts`
- Run the spec's manual list (`docs/superpowers/specs/2026-10-19-applications-history-design.md`, Verification) end to end as Super Admin on `localhost:5173`.
