/** Creating candidates from resume files and the background parse/summarize queue. */
import Anthropic from "@anthropic-ai/sdk";
import type { ResumeFile } from "../../frontend/src/types.ts";
import { logActivity } from "./activity.ts";
import { analyzeResume } from "./ai.ts";
import { createApplication } from "./applications.ts";
import { prisma } from "./db.ts";
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

async function parseCandidate(id: string, attempt = 1): Promise<void> {
  const c = await prisma.candidates.findUnique({ where: { id }, select: { resume: true } });
  const resume = c?.resume as ResumeFile | null | undefined;
  if (!c || !resume) return;
  try {
    const file = await readResume(resume);
    const text = await extractResumeText(file.data, file.mimeType);
    const basic = basicParse(text, resume.fileName);
    // The match score is per job: score every open application; with none open, the most recent one.
    const appSelect = { id: true, jobs: { select: { title: true, description: true, department: true } } } as const;
    const open = await prisma.applications.findMany({ where: { candidate_id: id, stages: { kind: "active" } }, orderBy: { created_at: "desc" }, select: appSelect });
    const apps = open.length ? open : await prisma.applications.findMany({ where: { candidate_id: id }, orderBy: { last_activity_at: "desc" }, take: 1, select: appSelect });
    const org = await getSetting("org");
    // ponytail: one AI call per open application; split profile extraction from scoring if cost matters.
    const results = org.aiSummariesEnabled ? await Promise.all(apps.map(async (a) => ({ id: a.id, ai: await analyzeResume(text, a.jobs ?? null) }))) : [];
    const ai = results[0]?.ai ?? null;

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
      r
        ? [prisma.applications.updateMany({ where: { id: appId }, data: { summary: { headline: r.headline, overview: r.overview, strengths: r.strengths, concerns: r.concerns, matchScore: r.matchScore, yearsExperience: r.yearsExperience, generatedAt: new Date().toISOString() } } })]
        : [],
    );
    await prisma.$transaction([
      prisma.candidates.updateMany({ where: { id }, data }),
      prisma.$executeRaw`update candidates set tags = array_remove(tags, 'New') where id = ${id}::uuid`,
      ...summaries,
    ]);
  } catch (e) {
    const retryable = e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError || e instanceof Anthropic.APIConnectionError;
    if (retryable && attempt < 4) {
      await new Promise((r) => setTimeout(r, 15_000 * attempt));
      return parseCandidate(id, attempt + 1);
    }
    console.error(`[parse] candidate ${id}:`, e instanceof Error ? e.message : e);
    await prisma.candidates.updateMany({ where: { id }, data: { parse_status: "failed" } });
  }
}
