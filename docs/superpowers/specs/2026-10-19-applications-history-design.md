# Resume Library + Candidate History: design and plan

## Context

Recruiters lose people and history today. Three problems:
1. **Duplicates on re-apply.** The same person uploaded or imported again becomes a second candidate. There is no email/phone check (`backend/src/pipeline.ts:11`). A new job also means a new record, so their old history is cut off.
2. **Can't find old people.** There is no pool of past or rejected people with their old outcomes and resumes to pick from for a new role.
3. **Lost track of changes.** Rejection is just a move to "Not moving forward", with no reason and no record of who did it. Stage history exists only as free-text activity, capped at the latest 300 rows app-wide. Profile edits are never logged. The board sorts by starred, then match score (`Pipeline.tsx:190`), not by what was worked on recently.

Goal: one record per person for life, many independent applications per person, and a history of every stage move and rejection that is never edited. The board always shows the most recently worked card first, the same for everyone. Add a Resume Library page and a searchable candidate pool.

## Decisions the user made

- **Full split.** Candidate = person and profile. Application = one person × one job, with its own stage and history. The board, Review page and stage emails work on applications.
- **Rejection reason is required.** A quick pick from a reason list managed in Settings, plus an optional note. It is asked on every path into a closed stage: drag, Review "Not a fit", bulk move, and the profile page.
- **Duplicates: ask the recruiter.** A resume matching an existing person by email or phone is flagged as a possible match. A person chooses "merge into existing" or "keep separate".
- **Interviews belong to an application (job). Notes belong to the person**, labelled with the job they were written under.
- **One current resume per person.** A new resume replaces the current one. The old version is kept only as S3/Drive version history. The `resume_files.candidate_id` unique constraint and the live S3 sync model stay unchanged.
- **The Drive file follows the latest job.** The person's one Drive file lives in the folder of their newest application. When a new application is created (reapply or merge), the file moves there.
  - `folderForRow` (`sync-jobs.ts:76-79`, which reads `candidates.job_id` today) uses the job of the person's most recently *created* open application. *My call:* created, not touched, so the file doesn't hop between folders on every edit.
  - The move reuses `google.moveFile`, enqueued as a sync job so it retries like the other Drive writes.
- **Interviewers see everything about the person.** `assertCandidateAccess` (`http.ts:85-93`) stays person-level. An interviewer scheduled on any of the person's applications sees all applications, past outcomes, reasons and notes.

## Data model (migration `backend/prisma/migrations/005_applications/migration.sql`)

Migrations are hand-written SQL, applied at startup by `migrate()` (`backend/src/db.ts:13`). One migration both creates the new tables and copies the existing data, inside a transaction.

- **`applications`**: `id`, `candidate_id` (FK cascade), `job_id` (FK set null), `stage_id` (FK), `applied_at`, `stage_entered_at`, `last_activity_at` (indexed with stage_id), `owner_id`, `rating`, `starred`, `summary` (Json: the AI match against *this* job), `created_at`.
  - Backfill: one application per existing candidate, copying those columns. `last_activity_at` = the latest of `stage_entered_at`, latest note, latest activity.
- **`stage_transitions`** (insert-only, never updated): `id`, `application_id` (FK cascade), `from_stage_id` (null = entered pipeline), `to_stage_id`, `actor_id`, `reason_id`, `reason_label` (snapshot of the label), `note`, `created_at`.
  - Backfill: one row per application (from null to the current stage, at `stage_entered_at`). Moves before the migration can't be rebuilt reliably from free-text activity. *My call.*
- **`rejection_reasons`**: `id`, `label`, `position`, `active`. Seeded with: Not enough experience, Skills mismatch, Salary expectations, Candidate withdrew, No response, Position filled, Other. "Withdrawn" is a reason, not a stage. *My call.*
- **`candidates`**: drop `job_id`, `stage_id`, `applied_at`, `stage_entered_at`, `owner_id`, `rating`, `starred` and `summary` after the copy. Add `possible_duplicate_of uuid null`. Keep the profile fields, `resume`, `resume_text`, `parse_status`, `source_id`, `tags` and `skills`.
- **`interviews`**: add `application_id` (FK cascade), backfilled from the candidate's single application. Keep `candidate_id`.
- **`notes`**: add `application_id` (nullable, FK set null). It records which job the note was written under.
- **`activity`**: add an index on `candidate_id` so a person's full timeline can be fetched without the global cap.
- `prisma/schema.prisma` is updated to match, then `prisma generate`.

## Behaviour

### Stage moves and rejection
- `POST /api/candidates/move` becomes `POST /api/applications/move` with `{ ids: applicationIds, stageId, notify, reasonId?, note? }`. Same logic as `candidates.ts:38-58`. It also:
  - inserts a `stage_transitions` row per moved application,
  - sets `last_activity_at = now()`,
  - returns **400 if the target stage is `kind="closed"` and there is no valid `reasonId`**. This is the single enforcement point for the required reason.
- Undo (toast in `Pipeline.tsx:85-98`) is a normal move back. History keeps both rows.
- The auto stage email stays server-side as it is now (`candidates.ts:50-56`), sent to the person behind each application.
- New `RejectDialog` component: reason chips (number keys 1–9 pick one quickly for Review), an optional note, and Confirm. It is used by:
  - Pipeline drop onto a closed column,
  - Review "Not a fit" (the R key opens the dialog),
  - bulk move (`components/candidate.tsx:336`), with one dialog for all,
  - a new "Reject" button on the profile page.
- Settings → Pipeline: a small reason-list editor, permission `settings.pipeline`, routes `GET/PUT /api/settings/rejection-reasons`.

### Recently touched first
- One helper, `touch(applicationIds)` in `backend/src/activity.ts` next to `logActivity`, sets `last_activity_at = now()`. Called from:
  - stage move,
  - note added (touches the application it was written under, or else all the person's open applications),
  - interview scheduled, cancelled, or feedback submitted (`routes/interviews.ts`),
  - resume replaced or renamed (`candidates.ts:204-250`),
  - profile edits: name, email, phone, location (person PATCH, which also starts logging an activity). These touch all of the person's open applications,
  - application edits: owner, job (new `PATCH /api/applications/:id`; owner is per application, *my call*). Rating and starred also move to this route but don't touch,
  - source tagged.
- Does **not** count: opening a profile, starring, rating, tag changes, emails sent outside a stage move. *My call on starring, rating and tags.*
- Board column sort is `lastActivityAt` descending only. Starred and score badges stay visible. The store's optimistic move also sets `lastActivityAt = now`, so the card jumps to the top of the target column instantly. Bootstrap polling keeps every user's order in step.

### Candidate pool (upgrade of `pages/Candidates.tsx`, not a new page)
- One row per **person**, showing the latest application's job/stage and a count of applications.
- New filters: outcome (active / hired / rejected), job (any application), rejected-from stage, rejection reason. The existing text search and filters stay.
  - The filters match a person if **any** of their applications matches. With a job filter set, the other filters apply to that job's application only. *My call.*
- Closed and hired people are included by default, with a toggle.

### Profile page (`pages/CandidateDetail.tsx`)
- A new **Applications** section with one card per application. Each card shows:
  - the job,
  - the current stage and stepper (scoped to that application),
  - the outcome and reason,
  - a timeline of stage transitions: from → to, who, when, reason, note.
- **"Consider for another job"**: pick a job, and a new application is created at the first active stage. It writes a transition with `from = null`. Previous applications are untouched. It is blocked if the person already has an open application for that job. Permission `candidates.moveStage`. Route `POST /api/candidates/:id/applications`.
- Notes are shown together, each with its job label. The interviews tab is grouped by application.
- The Activity tab loads this person's full activity from a new `GET /api/candidates/:id/activity`, not the capped bootstrap list.

### Resume Library (new page `pages/Resumes.tsx`, nav entry, permission `resumes.download` to open)
- One row per person's current resume: file name, person (links to profile), latest job/stage, uploaded date, parse status, storage/sync state.
- Search (file name, person, email, skills). Filters: parse status, sync state, job.
- Preview reuses `ResumePane`/`PdfViewer`/`DocxViewer` (`components/candidate.tsx:10-98`) in a side panel. Download uses `resumeUrl()`.
- Data comes from the store, which already holds `candidate.resume` with `syncState`, so no new API is needed. Opening it never creates candidates. Admins also see the existing `ResumeSync` page for conflicts and failed syncs.

### Duplicate detection and merge
- After parsing fills in email/phone (`pipeline.ts:89-120`), look for another person with the same lower-cased email, or the same last 10 digits of phone. If found, set `possible_duplicate_of`.
- The Review page and the profile show a banner, "Looks like *X* (n applications)", with **Merge into X** and **Keep separate** (which clears the flag).
- **At most one open application per person per job.** This is checked in the app by reapply and merge. It is not a DB constraint, because closed ones can repeat. *My call.*
- Merge (`POST /api/candidates/:id/merge-into/:targetId`, permission `candidates.moveStage`):
  1. move the duplicate's applications, notes and interviews to the target. If the target already has an application for the same job, the duplicate's application is folded into it. The target's stage, score, owner and history win. The duplicate's interviews and notes are re-pointed to it, and the duplicate's application row is dropped. *My call:* this is usually the same resume dropped twice.
  2. if the merge created a new application, move the target's Drive file to that job's folder (see Decisions),
  3. replace the target's resume with the duplicate's file, reusing the existing replace-resume path (new S3/Drive version of the same `resume_files` row),
  4. delete the duplicate via the existing delete path (`markCandidatesDeleted`). The duplicate's own Drive copy goes into the normal grace-period deletion, which leaves one file with the newest content in the latest job's folder.

  One transaction for the DB steps. The file step runs first, so a failure leaves both people intact.

### Unchanged on purpose
- Delete person stays a hard delete, as today. There is no per-application delete; closing an application is the answer.
- The job delete check (just added in `routes/admin.ts`) counts applications instead of candidates.
- The AI match score becomes per application: analysis runs per open application against that job (`ai.ts:49`). `resummarize` takes an application id.
- Email merge fields `job_title`/`stage` (`email.ts:46`) come from the application that triggered the email. For a manual compose to a person, they come from the most recently touched application.
- Bootstrap still loads every person and application at once. `ponytail:` fine at a few thousand people. Move the pool and library to server-side search when bootstrap gets slow.

## Build order (each phase ships and works on its own)

The user's suggested order put history and ordering first. Doing the split first avoids building history and ordering on candidates and then moving them. *My call.*

1. **Split.** Migration 005 plus backend and frontend switched to applications, with nothing visible changing yet (one application per person).
   - Frontend `types.ts` gets an `Application` type.
   - Store holds `applications`, `moveStage` takes application ids.
   - Pipeline, Review, Dashboard, Email, Interviews and Candidates read job/stage from applications.
   - Backend: `serialize.ts` gets `application()`, bootstrap sends applications, and `routes/candidates.ts`, `pipeline.ts`, `drive.ts`, `storage.ts`, `email.ts` and `routes/interviews.ts` are updated.
2. **History, required reasons, recent-first ordering.** `stage_transitions` writes, `RejectDialog`, the reasons editor, `touch()`, the board sort.
3. **Pool and library.** Candidates page filters, the Applications section on the profile, the full activity endpoint, the Resumes page.
4. **Reapply and duplicates.** "Consider for another job", duplicate flag, merge.

## Verification

- `npm run typecheck` in `backend/` and `frontend/`, plus `npm run build` in `frontend/`.
- Existing checks: `npm run check:sync` and `npm run check:sync-db` (local DB), to confirm S3/Drive sync still works.
- New `backend/scripts/check-applications-db.ts` (same assert style as `check-sync-db.ts`, local DB only):
  - the backfill gives one application per candidate,
  - a move writes a transition and bumps `last_activity_at`,
  - a move to a closed stage without a reason → 400,
  - reapply creates a second application and leaves the first unchanged,
  - merge moves applications and notes and leaves one person.
- Manual run (`localhost:5173`, with the dev backend `--watch`) as Super Admin:
  - drag to "Not moving forward" → the reason dialog appears; it is recorded on the timeline,
  - add a note → the card jumps to the top; it is the same order in a second browser,
  - upload the same person's resume again → the possible-match banner appears; merge,
  - consider a rejected person for another job → two applications, the old one is still rejected,
  - the Resume Library lists, previews and downloads,
  - drag-drop, stage auto-emails, parsing and the Drive/S3 sync status still work.
- After approval, also save this design to `docs/superpowers/specs/2026-10-19-applications-history-design.md` (committed), then write the step-by-step plan with superpowers:writing-plans.
