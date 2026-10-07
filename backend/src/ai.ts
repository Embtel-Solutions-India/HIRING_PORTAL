/** Resume → structured profile + reviewer summary, using Claude structured outputs. */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "./config.ts";

const ResumeAnalysis = z.object({
  firstName: z.string(),
  lastName: z.string(),
  email: z.string().describe("Empty string if not present"),
  phone: z.string().describe("Empty string if not present"),
  location: z.string().describe("City, state/country. Empty string if not present"),
  currentTitle: z.string(),
  currentCompany: z.string(),
  yearsExperience: z.number().describe("Total relevant professional years, rounded"),
  skills: z.array(z.string()).describe("Up to 12 concrete skills/tools, most relevant to the job first"),
  experience: z.array(
    z.object({
      company: z.string(),
      title: z.string(),
      start: z.string().describe("Year or Month Year"),
      end: z.string().describe("Year, Month Year, or 'Present'"),
      highlights: z.array(z.string()).describe("Up to 3 short achievement bullets, taken from the resume"),
    }),
  ),
  education: z.array(z.object({ school: z.string(), degree: z.string(), year: z.string() })),
  headline: z.string().describe("One line, under 80 characters, e.g. '7+ yrs case manager · immigration filings, Spanish'"),
  overview: z.string().describe("3-4 sentence neutral summary for a hiring team"),
  strengths: z.array(z.string()).describe("2-4 job-relevant strengths, each under 90 characters"),
  concerns: z.array(z.string()).describe("1-3 job-relevant gaps or questions to probe, each under 90 characters"),
  matchScore: z.number().describe("0-100 fit against the job requirements"),
});

export type ResumeAnalysis = z.infer<typeof ResumeAnalysis>;

const SYSTEM = `You read resumes for an internal hiring team and produce a structured profile plus a short reviewer summary.

Rules:
- Use only what the resume says. Never invent employers, dates, degrees or contact details; use an empty string when something is missing.
- Judge fit only on job-relevant qualifications: skills, experience, achievements, certifications and stated work authorization or availability when the job requires it.
- Do not consider or mention age, gender, race, ethnicity, nationality, religion, disability, marital or family status, or other protected characteristics, and don't infer them from names, photos, schools or dates.
- Employment gaps are worth a neutral question, not a penalty.
- The match score is a rough guide for reviewers (90+ exceptional, 75-89 strong, 60-74 partial, under 60 weak). People make the decisions.`;

let client: Anthropic | null = null;

export const aiConfigured = () => !!config.anthropicApiKey;

export async function analyzeResume(resumeText: string, job: { title: string; description: string; department: string } | null): Promise<ResumeAnalysis | null> {
  if (!aiConfigured() || !resumeText.trim()) return null;
  client ??= new Anthropic({ apiKey: config.anthropicApiKey });

  const jobBlock = job
    ? `<job>\nTitle: ${job.title}\nDepartment: ${job.department}\n${job.description ? `Description:\n${job.description}` : "No description provided — judge against the job title."}\n</job>`
    : "<job>Not assigned to a job yet — judge general strength and set matchScore to 70 if unsure.</job>";

  const response = await client.beta.messages.parse({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: betaZodOutputFormat(ResumeAnalysis) },
    system: SYSTEM,
    messages: [{ role: "user", content: `${jobBlock}\n\n<resume>\n${resumeText}\n</resume>` }],
  });

  if (response.stop_reason === "refusal") {
    console.warn("[ai] resume analysis declined:", response.stop_details?.category);
    return null;
  }
  const out = response.parsed_output;
  if (!out) return null;
  return {
    ...out,
    skills: out.skills.slice(0, 12),
    strengths: out.strengths.slice(0, 4),
    concerns: out.concerns.slice(0, 3),
    experience: out.experience.slice(0, 6).map((e) => ({ ...e, highlights: e.highlights.slice(0, 3) })),
    matchScore: Math.max(0, Math.min(100, Math.round(out.matchScore))),
    yearsExperience: Math.max(0, Math.round(out.yearsExperience)),
  };
}
