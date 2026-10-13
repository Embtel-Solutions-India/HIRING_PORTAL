/** Creating candidates from resume files and the background parse/summarize queue. */
import Anthropic from "@anthropic-ai/sdk";
import type { ResumeFile } from "../../frontend/src/types.ts";
import { logActivity } from "./activity.ts";
import { analyzeResume } from "./ai.ts";
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
  const stage = await prisma.stages.findFirst({ where: { kind: "active" }, orderBy: { position: "asc" }, select: { id: true } });
  const row = await prisma.candidates.create({
    data: {
      first_name: guess.firstName,
      last_name: guess.lastName,
      job_id: input.jobId,
      stage_id: stage!.id,
      source_id: input.sourceId,
      owner_id: input.actorId,
      resume: { ...input.resume },
      parse_status: "pending",
      tags: ["New"],
    },
    select: { id: true },
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
  const c = await prisma.candidates.findUnique({ where: { id }, select: { resume: true, job_id: true } });
  const resume = c?.resume as ResumeFile | null | undefined;
  if (!c || !resume) return;
  try {
    const file = await readResume(resume);
    const text = await extractResumeText(file.data, file.mimeType);
    const basic = basicParse(text, resume.fileName);
    const job = c.job_id ? await prisma.jobs.findUnique({ where: { id: c.job_id }, select: { title: true, description: true, department: true } }) : null;
    const org = await getSetting("org");
    const ai = org.aiSummariesEnabled ? await analyzeResume(text, job ?? null) : null;

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
          summary: {
            headline: ai.headline,
            overview: ai.overview,
            strengths: ai.strengths,
            concerns: ai.concerns,
            matchScore: ai.matchScore,
            yearsExperience: ai.yearsExperience,
            generatedAt: new Date().toISOString(),
          },
          resume_text: text,
          parse_status: "ready",
        }
      : { first_name: basic.firstName, last_name: basic.lastName, email, phone, resume_text: text, parse_status: "ready" };
    await prisma.$transaction([
      prisma.candidates.updateMany({ where: { id }, data }),
      prisma.$executeRaw`update candidates set tags = array_remove(tags, 'New') where id = ${id}::uuid`,
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
