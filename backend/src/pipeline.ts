/** Creating candidates from resume files and the background parse/summarize queue. */
import Anthropic from "@anthropic-ai/sdk";
import type { ResumeFile } from "../../frontend/src/types.ts";
import { logActivity } from "./activity.ts";
import { analyzeResume } from "./ai.ts";
import { createApplication, findDuplicate } from "./applications.ts";
import { Prisma, prisma } from "./db.ts";
import { basicParse, extractResumeText } from "./resume.ts";
import { getSetting } from "./settings.ts";
import { readResume } from "./storage.ts";

export async function createCandidate(input: {
  resume: ResumeFile;
  jobId: string | null;
  /** Recruiting platform (LinkedIn, Indeed…), or null when not tagged yet. */
  sourceId: string | null;
  /** How the file reached the ATS — only used for the activity log. */
  intake: "drive" | "upload";
  actorId: string | null;
}): Promise<string> {
  const guess = basicParse("", input.resume.fileName);
  const row = await prisma.$transaction(async (tx) => {
    const c = await tx.candidates.create({
      data: { first_name: guess.firstName, last_name: guess.lastName, source_id: input.sourceId, resume: { ...input.resume }, parse_status: "pending", tags: ["New"] },
      select: { id: true },
    });
    await createApplication({ candidateId: c.id, jobId: input.jobId, actorId: input.actorId }, tx);
    return c;
  });
  const src = input.sourceId ? await prisma.sources.findUnique({ where: { id: input.sourceId }, select: { name: true } }) : null;
  await logActivity(
    input.actorId,
    "resume_upload",
    `${input.intake === "drive" ? "imported" : "uploaded"} ${input.resume.fileName}${src ? ` (source: ${src.name})` : ""}`,
    row.id,
  );
  enqueueParse(row.id);
  return row.id;
}

// ---------- queue ----------

const queue: string[] = [];
let running = 0;
const CONCURRENCY = 2;

export function enqueueParse(candidateId: string) {
  if (!queue.includes(candidateId)) queue.push(candidateId);
  pump();
}

function pump() {
  while (running < CONCURRENCY && queue.length) {
    const id = queue.shift()!;
    running++;
    parseCandidate(id)
      .catch((e) => console.error(`[parse] ${id} failed:`, e))
      .finally(() => {
        running--;
        pump();
      });
  }
}

/** Re-queue anything left pending by a restart. */
export async function resumePendingParses() {
  const rows = await prisma.candidates.findMany({ where: { parse_status: "pending" }, select: { id: true } });
  rows.forEach((r) => enqueueParse(r.id));
}

const isRetryable = (e: unknown) => e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError || e instanceof Anthropic.APIConnectionError;

async function parseCandidate(id: string, attempt = 1): Promise<void> {
  const c = await prisma.candidates.findUnique({ where: { id }, select: { resume: true } });
  const resume = c?.resume as ResumeFile | null | undefined;
  if (!c || !resume) return;
  try {
    const file = await readResume(resume);
    const text = await extractResumeText(file.data, file.mimeType);
    const basic = basicParse(text, resume.fileName);
    // The match score is per job: score every open application plus any without a score (a finished one whose job
    // changed or that asked to be re-summarized); with none of those, the most recent one.
    const appSelect = { id: true, jobs: { select: { title: true, description: true, department: true } } } as const;
    const due = await prisma.applications.findMany({
      where: { candidate_id: id, OR: [{ stages: { kind: "active" } }, { summary: { equals: Prisma.DbNull } }] },
      orderBy: { created_at: "desc" },
      select: appSelect,
    });
    const apps = due.length ? due : await prisma.applications.findMany({ where: { candidate_id: id }, orderBy: { last_activity_at: "desc" }, take: 1, select: appSelect });
    // No application at all: still one call, for the profile.
    const targets: { id: string | null; jobs: (typeof apps)[number]["jobs"] }[] = apps.length ? apps : [{ id: null, jobs: null }];
    const org = await getSetting("org");
    // ponytail: one AI call per application; split profile extraction from scoring if cost matters.
    const settled = org.aiSummariesEnabled ? await Promise.allSettled(targets.map((a) => analyzeResume(text, a.jobs ?? null))) : [];
    const failed = settled.flatMap((s) => (s.status === "rejected" ? [s.reason as unknown] : []));
    // A transient error retries the whole parse; any other failure only loses that one job's score, unless all failed.
    const transient = failed.find(isRetryable);
    if ((transient && attempt < 4) || (failed.length && failed.length === settled.length)) throw transient ?? failed[0];
    failed.forEach((e) => console.warn(`[parse] candidate ${id}: one match score failed:`, e instanceof Error ? e.message : e));
    const results = settled.map((s, i) => ({ id: targets[i]!.id, ai: s.status === "fulfilled" ? s.value : null }));
    const ai = results.find((r) => r.ai)?.ai ?? null;

    // Empty email/phone keep whatever is already on file.
    const email = (ai?.email || basic.email) || undefined;
    const phone = (ai?.phone || basic.phone) || undefined;
    const data = ai
      ? {
          first_name: ai.firstName || basic.firstName,
          last_name: ai.lastName || basic.lastName,
          email,
          phone,
          location: ai.location,
          current_title: ai.currentTitle,
          current_company: ai.currentCompany,
          skills: ai.skills,
          experience: ai.experience,
          education: ai.education,
          resume_text: text,
          parse_status: "ready",
        }
      : { first_name: basic.firstName, last_name: basic.lastName, email, phone, resume_text: text, parse_status: "ready" };
    const summaries = results.flatMap(({ id: appId, ai: r }) =>
      r && appId
        ? [prisma.applications.updateMany({ where: { id: appId }, data: { summary: { headline: r.headline, overview: r.overview, strengths: r.strengths, concerns: r.concerns, matchScore: r.matchScore, yearsExperience: r.yearsExperience, generatedAt: new Date().toISOString() } } })]
        : [],
    );
    await prisma.$transaction([
      prisma.candidates.updateMany({ where: { id }, data }),
      prisma.$executeRaw`update candidates set tags = array_remove(tags, 'New') where id = ${id}::uuid`,
      ...summaries,
    ]);
    // Now that email/phone are known, flag a likely earlier record of the same person for a recruiter to check.
    await prisma.candidates.updateMany({ where: { id }, data: { possible_duplicate_of: await findDuplicate(id) } });
  } catch (e) {
    if (isRetryable(e) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 15_000 * attempt));
      return parseCandidate(id, attempt + 1);
    }
    console.error(`[parse] candidate ${id}:`, e instanceof Error ? e.message : e);
    await prisma.candidates.updateMany({ where: { id }, data: { parse_status: "failed" } });
  }
}
