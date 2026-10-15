// Run: npm run check:sync — assert-based checks of the pure resume-sync rules.
import assert from "node:assert/strict";
import { config, positiveNumber } from "../src/config.ts";
import { s3Configured } from "../src/s3.ts";
import { backoffMs, ChecksumMismatch, decide, GOOGLE_DOC, isPermanent, keyPrefix, nameBaseline, resolveFileName, s3KeyFor, safeKeyName, type Baseline, type DriveObservation, type PortalPending } from "../src/sync-rules.ts";

const PDF = "application/pdf";
const base: Baseline = { driveMd5: "aaa", driveVersion: "10", driveName: "cv.pdf" };
const obs = (o: Partial<DriveObservation> = {}): DriveObservation => ({ removed: false, trashed: false, md5: "aaa", version: "10", name: "cv.pdf", mimeType: PDF, ...o });
const none: PortalPending = { contentQueued: false, contentMd5: null, renameTo: null };
const synced = { state: "synced" as const, deletedSide: null };

// --- decide ---
assert.deepEqual(decide(synced, base, obs(), none), [], "no change → nothing");
assert.deepEqual(decide(synced, base, obs({ md5: "bbb", version: "11" }), none), [{ do: "copy_to_s3" }], "content edit → copy to S3");
assert.deepEqual(decide(synced, base, obs({ name: "new.pdf", version: "11" }), none), [{ do: "rename_s3", name: "new.pdf" }], "rename → S3 rename, no copy");
assert.deepEqual(decide(synced, base, obs({ md5: "ccc" }), { contentQueued: true, contentMd5: "ccc", renameTo: null }), [], "our own upload echoing back → ignored");
assert.deepEqual(decide(synced, base, obs({ md5: "ddd" }), { contentQueued: true, contentMd5: "ccc", renameTo: null }), [{ do: "conflict", on: "content" }], "both sides changed → conflict");
assert.deepEqual(decide(synced, base, obs({ md5: "ddd" }), { contentQueued: true, contentMd5: null, renameTo: null }), [{ do: "conflict", on: "content" }], "portal change not pushed yet + Drive edit → conflict");
assert.deepEqual(decide(synced, base, obs({ name: "x.pdf" }), { ...none, renameTo: "x.pdf" }), [], "our own rename echoing back → ignored");
assert.deepEqual(decide(synced, base, obs({ name: "y.pdf" }), { ...none, renameTo: "x.pdf" }), [{ do: "conflict", on: "name" }], "renamed on both sides → name conflict");
assert.deepEqual(decide(synced, base, obs({ trashed: true }), none), [{ do: "start_deletion" }], "trashed → countdown");
assert.deepEqual(decide({ state: "pending_deletion", deletedSide: "drive" }, base, obs({ trashed: true }), none), [], "still trashed → nothing new");
assert.deepEqual(decide({ state: "pending_deletion", deletedSide: "drive" }, base, obs(), none), [{ do: "cancel_deletion" }], "untrashed → cancel countdown");
assert.deepEqual(decide({ state: "pending_deletion", deletedSide: "portal" }, base, obs({ md5: "zzz" }), none), [], "portal-deleted: Drive edits don't revive it");
assert.deepEqual(decide(synced, base, obs({ removed: true }), none), [{ do: "check_removed" }], "removed → confirm with files.get first");
assert.deepEqual(decide({ state: "conflict", deletedSide: null }, base, obs({ md5: "eee" }), none), [], "conflict is frozen until an Admin resolves it");
const doc: Baseline = { driveMd5: null, driveVersion: "5", driveName: "CV" };
assert.deepEqual(decide(synced, doc, obs({ md5: null, version: "6", name: "CV", mimeType: GOOGLE_DOC }), none), [{ do: "copy_to_s3" }], "Google Doc edit detected by version");
assert.deepEqual(decide(synced, doc, obs({ md5: null, version: "6", name: "CV", mimeType: GOOGLE_DOC }), { contentQueued: true, contentMd5: "x", renameTo: null }), [], "portal replaced a Google Doc → Doc gets archived, not a conflict");
assert.deepEqual(decide(synced, base, obs({ name: "" }), none), [], "Drive returned no name → not a rename");

// --- keys and names ---
assert.equal(s3KeyFor("1AbC", "Ritik_Saini_Java_Developer_Resume.pdf", PDF), "resumes/1AbC/Ritik_Saini_Java_Developer_Resume.pdf");
assert.notEqual(s3KeyFor("id1", "cv.pdf", PDF), s3KeyFor("id2", "cv.pdf", PDF), "same name under two ids → different keys");
assert.equal(safeKeyName("a/b\\c\u0001.pdf"), "a_b_c_.pdf");
assert.equal(s3KeyFor("d1", "My CV", GOOGLE_DOC), "resumes/d1/My CV.pdf", "Google Doc stored as PDF");
const long = "é".repeat(300) + ".pdf";
const trimmed = safeKeyName(long);
assert.ok(Buffer.byteLength(trimmed) <= 200 && trimmed.endsWith(".pdf") && !trimmed.includes("�"), "trimmed to 200 bytes, extension kept, no broken characters");
assert.deepEqual(resolveFileName("  ", "XYZ", PDF), { fileName: "resume_XYZ.pdf", reviewReason: "missing_filename" });
assert.deepEqual(resolveFileName("cv.pdf", "XYZ", PDF), { fileName: "cv.pdf", reviewReason: null });

// --- retries ---
assert.equal(backoffMs(1, () => 0.5), 60_000);
assert.equal(backoffMs(20, () => 0.5), 3_600_000, "capped at 1h");
assert.equal(backoffMs(1, () => 0), 48_000, "-20% jitter");
assert.equal(isPermanent(Object.assign(new Error("x"), { status: 404 }), null), true);
assert.equal(isPermanent(new Error("Google API error (403): The user does not have sufficient permissions"), null), true);
assert.equal(isPermanent(new Error("Google API error (403): User Rate Limit Exceeded"), null), false, "rate limit 403 is transient");
assert.equal(isPermanent(new Error("socket hang up"), null), false);
assert.equal(isPermanent(new ChecksumMismatch("S3 read-back"), null), false, "first checksum mismatch → retry");
assert.equal(isPermanent(new ChecksumMismatch("S3 read-back"), "Checksum mismatch: S3 read-back"), true, "second in a row → fail");
assert.equal(isPermanent(Object.assign(new Error("x"), { name: "NoSuchKey" }), null), true);

// --- Drive name seen during a transfer: never silently becomes the baseline ---
assert.deepEqual(nameBaseline("cv.pdf", "cv.pdf", "cv.pdf"), { baseline: "cv.pdf", rename: null }, "same name → nothing to do");
assert.deepEqual(nameBaseline("cv.pdf", "cv.pdf", "new.pdf"), { baseline: "cv.pdf", rename: "new.pdf" }, "renamed in Drive mid-transfer → follow-up rename, baseline unchanged");
assert.deepEqual(nameBaseline(null, "cv.pdf", "new.pdf"), { baseline: "cv.pdf", rename: "new.pdf" }, "first sync: baseline from the portal name");
assert.deepEqual(nameBaseline("cv.pdf", "cv.pdf", ""), { baseline: "cv.pdf", rename: null }, "no name from Drive → not a rename");

// --- key prefix ---
assert.equal(keyPrefix("resumes/abc/My CV.pdf"), "resumes/abc");

// --- numeric config ---
assert.equal(positiveNumber("abc", 30), 30, "non-numeric → default");
assert.equal(positiveNumber("", 30), 30);
assert.equal(positiveNumber("0", 30), 1, "clamped to at least 1");
assert.equal(positiveNumber("7", 30), 7);

// --- S3 needs only a region and a bucket (keys are optional: EC2 instance role) ---
const s3Was = { ...config.s3 };
Object.assign(config.s3, { region: "ap-south-1", bucket: "b", accessKeyId: "", secretAccessKey: "" });
assert.equal(s3Configured(), true, "region + bucket is enough");
Object.assign(config.s3, { bucket: "" });
assert.equal(s3Configured(), false, "no bucket → off");
Object.assign(config.s3, s3Was);

console.log("check-sync: all assertions passed");
