# Resume sync — manual runbook

Run against a **test** bucket (Versioning on) and a **test** Drive folder, never production. Set `DRIVE_SYNC_MINUTES=1`
while testing. Mark each scenario pass/fail with the date.

Plan: `docs/superpowers/plans/2026-10-15-s3-drive-resume-sync.md` · Spec: `docs/superpowers/specs/2026-10-15-s3-drive-resume-sync-design.md`

Also still to run from the plan (they need S3 + Drive): Task 5 Step 6, Task 6 Step 5, Task 7 Step 4, Task 8 Step 4, Task 9 Step 8.

| # | Result |
|---|---|
| 1 | not run |
| 2 | not run |
| 3 | not run |
| 4 | not run |
| 5 | not run |
| 6 | not run |
| 7 | not run |
| 8 | not run |
| 9 | not run |

## Scenarios

1. **Interrupted migration:** start the migration with 50+ resumes and kill the backend after about 10 jobs. Restart and re-run the migration. Expected: every row ends `synced`, the `resume_files` count equals the candidates with resumes, and there are no duplicate keys in S3.
2. **Duplicate change events:** repeat a poll by resetting `driveChanges.pageToken` to the previous value with SQL. Expected: no new jobs beyond merges, and no new rows.
3. **Simultaneous edit:** the Task 7 Step 4.3 procedure. Expected: a conflict, both versions retrievable (the S3 version id and the `conflicts/` object), and either resolution works.
4. **Crash after Drive upload:** add a temporary `throw new Error("crash")` right after `createDriveFileOnce` in `toDrive`, upload a resume, wait for one failure, remove the throw. Expected: the retry completes, and there is exactly one Drive file with the pre-generated id.
5. **Rename before copy:** queue a migration, stop the worker before it runs (`S3_BUCKET` empty), rename the file in Drive, restore the env and restart. Expected: the S3 object is created under the new name, with one row.
6. **Trash/untrash, removed (404 vs lost access), purge, restore (both sides):** as in Task 8 Step 4, plus share-revoke a file for "lost access", which should show `failed` and no countdown.
7. **Failed-job recovery:** set a wrong `AWS_SECRET_ACCESS_KEY`, upload a resume, and see it in Failures. Fix the key, click Retry, and it becomes `synced`.
8. **Preview cache after Replace:** the preview shows the new file without a hard refresh.
9. **Missing filename:** with SQL, set a `drive_files.file_name` to `''` before import. Expected: the name is `resume_<id>.pdf` and it appears under Needs review.
