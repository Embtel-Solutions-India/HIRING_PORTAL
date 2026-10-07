/** Creating candidates from resume files and the background parse/summarize queue. */
import Anthropic from "@anthropic-ai/sdk";
import type { ResumeFile } from "../../frontend/src/types.ts";
import { logActivity } from "./activity.ts";
import { analyzeResume } from "./ai.ts";
import { one, q } from "./db.ts";
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
  const row = await one<{ id: string }>(
    `insert into candidates (first_name, last_name, job_id, stage_id, source_id, owner_id, resume, parse_status, tags)
     values ($1, $2, $3, (select id from stages where kind = 'active' order by position limit 1), $4, $5, $6, 'pending', '{New}')
     returning id`,
    [guess.firstName, guess.lastName, input.jobId, input.sourceId, input.actorId, JSON.stringify(input.resume)],
  );
  const src = input.sourceId ? await one<{ name: string }>("select name from sources where id = $1", [input.sourceId]) : undefined;
  await logActivity(
    input.actorId,
    "resume_upload",
    `${input.intake === "drive" ? "imported" : "uploaded"} ${input.resume.fileName}${src ? ` (source: ${src.name})` : ""}`,
    row!.id,
  );
  enqueueParse(row!.id);
  return row!.id;
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
  const rows = await q<{ id: string }>("select id from candidates where parse_status = 'pending'");
  rows.forEach((r) => enqueueParse(r.id));
}

async function parseCandidate(id: string, attempt = 1): Promise<void> {
  const c = await one<{ resume: ResumeFile; job_id: string | null; first_name: string; last_name: string; email: string; phone: string }>(
    "select resume, job_id, first_name, last_name, email, phone from candidates where id = $1",
    [id],
  );
  if (!c?.resume) return;
  try {
    const file = await readResume(c.resume);
    const text = await extractResumeText(file.data, file.mimeType);
    const basic = basicParse(text, c.resume.fileName);
    const job = c.job_id ? await one<{ title: string; description: string; department: string }>("select title, description, department from jobs where id = $1", [c.job_id]) : null;
    const org = await getSetting("org");
    const ai = org.aiSummariesEnabled ? await analyzeResume(text, job ?? null) : null;

    if (ai) {
      await q(
        `update candidates set
           first_name = $2, last_name = $3, email = coalesce(nullif($4, ''), email), phone = coalesce(nullif($5, ''), phone),
           location = $6, current_title = $7, current_company = $8, skills = $9, experience = $10, education = $11,
           summary = $12, resume_text = $13, parse_status = 'ready', tags = array_remove(tags, 'New')
         where id = $1`,
        [
          id,
          ai.firstName || basic.firstName,
          ai.lastName || basic.lastName,
          ai.email || basic.email,
          ai.phone || basic.phone,
          ai.location,
          ai.currentTitle,
          ai.currentCompany,
          ai.skills,
          JSON.stringify(ai.experience),
          JSON.stringify(ai.education),
          JSON.stringify({
            headline: ai.headline,
            overview: ai.overview,
            strengths: ai.strengths,
            concerns: ai.concerns,
            matchScore: ai.matchScore,
            yearsExperience: ai.yearsExperience,
            generatedAt: new Date().toISOString(),
          }),
          text,
        ],
      );
    } else {
      await q(
        `update candidates set first_name = $2, last_name = $3, email = coalesce(nullif($4, ''), email), phone = coalesce(nullif($5, ''), phone),
           resume_text = $6, parse_status = 'ready', tags = array_remove(tags, 'New')
         where id = $1`,
        [id, basic.firstName, basic.lastName, basic.email, basic.phone, text],
      );
    }
  } catch (e) {
    const retryable = e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError || e instanceof Anthropic.APIConnectionError;
    if (retryable && attempt < 4) {
      await new Promise((r) => setTimeout(r, 15_000 * attempt));
      return parseCandidate(id, attempt + 1);
    }
    console.error(`[parse] candidate ${id}:`, e instanceof Error ? e.message : e);
    await q("update candidates set parse_status = 'failed' where id = $1", [id]);
  }
}
