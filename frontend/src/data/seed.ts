import { addDays, addMinutes, setHours, setMinutes, startOfDay, subDays, subHours } from "date-fns";
import type {
  ActivityEvent,
  BookingLink,
  Candidate,
  EmailCampaign,
  EmailTemplate,
  Experience,
  Interview,
  Job,
  OrgSettings,
  Stage,
  TeamMember,
} from "../types";

// Deterministic RNG so the demo data looks the same on every reset.
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(42);
const pick = <T,>(arr: readonly T[]) => arr[Math.floor(rand() * arr.length)]!;
const pickN = <T,>(arr: readonly T[], n: number) => [...arr].sort(() => rand() - 0.5).slice(0, n);
const between = (min: number, max: number) => Math.floor(rand() * (max - min + 1)) + min;
const iso = (d: Date) => d.toISOString();
const driveId = () => "1" + Array.from({ length: 32 }, () => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"[between(0, 63)]).join("");

export const SEED_VERSION = 5;

export const seedStages: Stage[] = [
  { id: "screening", name: "Screening", color: "#2a78d6", kind: "active", autoEmailTemplateId: "t_received" },
  { id: "shortlisted", name: "Shortlisted", color: "#eb6834", kind: "active", autoEmailTemplateId: "t_shortlisted" },
  { id: "interview", name: "Interview", color: "#1baf7a", kind: "active", autoEmailTemplateId: "t_interview" },
  { id: "final", name: "Final Interview", color: "#eda100", kind: "active", autoEmailTemplateId: "t_final" },
  { id: "offer", name: "Offer", color: "#4a3aa7", kind: "active", autoEmailTemplateId: "t_offer" },
  { id: "onboarding", name: "Onboarding", color: "#008300", kind: "hired", autoEmailTemplateId: "t_welcome" },
  { id: "rejected", name: "Not moving forward", color: "#e34948", kind: "closed", autoEmailTemplateId: "t_rejection" },
];

const AVATAR_COLORS = ["#1d5a3a", "#9a3412", "#1e40af", "#7c2d12", "#6d28d9", "#0f766e", "#be185d", "#4d7c0f", "#a16207"];

export const seedTeam: TeamMember[] = [
  { id: "u_priya", name: "Priya Raman", email: "priya@yourcompany.com", role: "super_admin", title: "Head of People", status: "active", avatarColor: AVATAR_COLORS[0]!, lastActiveAt: iso(subHours(new Date(), 1)), calendarConnected: true },
  { id: "u_marcus", name: "Marcus Chen", email: "marcus@yourcompany.com", role: "admin", title: "Talent Lead", status: "active", avatarColor: AVATAR_COLORS[2]!, lastActiveAt: iso(subHours(new Date(), 3)), calendarConnected: true },
  { id: "u_sofia", name: "Sofia Alvarez", email: "sofia@yourcompany.com", role: "admin", title: "Operations Manager", status: "active", avatarColor: AVATAR_COLORS[6]!, lastActiveAt: iso(subDays(new Date(), 1)), calendarConnected: true },
  { id: "u_daniel", name: "Daniel Okafor", email: "daniel@yourcompany.com", role: "user", title: "Recruiter", status: "active", avatarColor: AVATAR_COLORS[1]!, lastActiveAt: iso(subHours(new Date(), 5)), calendarConnected: true },
  { id: "u_aisha", name: "Aisha Khan", email: "aisha@yourcompany.com", role: "user", title: "Recruiter", status: "active", avatarColor: AVATAR_COLORS[4]!, lastActiveAt: iso(subHours(new Date(), 2)), calendarConnected: false },
  { id: "u_lena", name: "Lena Park", email: "lena@yourcompany.com", role: "user", title: "Recruiting Coordinator", status: "active", avatarColor: AVATAR_COLORS[5]!, lastActiveAt: iso(subDays(new Date(), 2)), calendarConnected: true },
  { id: "u_tom", name: "Tom Becker", email: "tom@yourcompany.com", role: "user", title: "Recruiter", status: "invited", avatarColor: AVATAR_COLORS[7]!, calendarConnected: false },
  { id: "u_james", name: "James Wright", email: "james@yourcompany.com", role: "user", title: "Contract Recruiter", status: "deactivated", avatarColor: AVATAR_COLORS[8]!, lastActiveAt: iso(subDays(new Date(), 40)), calendarConnected: false },
];

type Family = "eng" | "legal" | "cs" | "mkt" | "ops";

export const seedJobs: (Job & { family: Family })[] = [
  { id: "j_fullstack", title: "Full-Stack Developer", department: "Engineering", location: "Remote (US)", type: "Full-time", status: "open", hiringManagerId: "u_marcus", openings: 2, createdAt: iso(subDays(new Date(), 34)), driveFolder: "ATS/Resumes/Full-Stack Developer", family: "eng" },
  { id: "j_case", title: "Case Manager", department: "Operations", location: "San Jose, CA", type: "Full-time", status: "open", hiringManagerId: "u_sofia", openings: 3, createdAt: iso(subDays(new Date(), 28)), driveFolder: "ATS/Resumes/Case Manager", family: "legal" },
  { id: "j_paralegal", title: "Paralegal", department: "Legal", location: "San Francisco, CA", type: "Full-time", status: "open", hiringManagerId: "u_priya", openings: 1, createdAt: iso(subDays(new Date(), 21)), driveFolder: "ATS/Resumes/Paralegal", family: "legal" },
  { id: "j_success", title: "Client Success Associate", department: "Client Services", location: "Hybrid · Oakland, CA", type: "Full-time", status: "open", hiringManagerId: "u_sofia", openings: 2, createdAt: iso(subDays(new Date(), 15)), driveFolder: "ATS/Resumes/Client Success Associate", family: "cs" },
  { id: "j_marketing", title: "Marketing Specialist", department: "Marketing", location: "Remote (US)", type: "Contract", status: "open", hiringManagerId: "u_marcus", openings: 1, createdAt: iso(subDays(new Date(), 10)), driveFolder: "ATS/Resumes/Marketing Specialist", family: "mkt" },
  { id: "j_ops", title: "Operations Coordinator", department: "Operations", location: "San Jose, CA", type: "Part-time", status: "paused", hiringManagerId: "u_sofia", openings: 1, createdAt: iso(subDays(new Date(), 45)), driveFolder: "ATS/Resumes/Operations Coordinator", family: "ops" },
];

const FAMILY: Record<Family, { titles: string[]; companies: string[]; skills: string[]; highlights: string[]; strengths: string[]; concerns: string[] }> = {
  eng: {
    titles: ["Software Engineer", "Frontend Engineer", "Full-Stack Engineer", "Senior Software Engineer", "Web Developer"],
    companies: ["Stripe", "Brightline Labs", "Northwind Health", "Gusto", "Asana", "Lumen Analytics", "Cobalt Systems"],
    skills: ["React", "TypeScript", "Node.js", "PostgreSQL", "AWS", "GraphQL", "Python", "Docker", "CI/CD", "Next.js", "Tailwind CSS", "REST APIs"],
    highlights: [
      "Rebuilt the customer dashboard in React + TypeScript, cutting load time by 48%",
      "Designed a Postgres-backed job queue processing 2M events/day",
      "Led migration from a monolith to 6 Node.js services on AWS ECS",
      "Shipped a document-upload pipeline with virus scanning and OCR",
      "Mentored 3 junior engineers and ran the weekly code-review guild",
      "Introduced end-to-end tests that reduced production incidents by 30%",
      "Built internal admin tools used daily by 120+ operations staff",
    ],
    strengths: ["Strong modern React/TypeScript depth", "Has owned features end-to-end, from schema to UI", "Experience building internal tools for ops teams", "Clear track record of measurable performance wins"],
    concerns: ["Limited backend experience at scale", "Short tenure (<1 yr) at most recent role", "No experience with document-heavy workflows", "Mostly agency work, less product ownership"],
  },
  legal: {
    titles: ["Paralegal", "Case Manager", "Legal Assistant", "Senior Paralegal", "Case Coordinator"],
    companies: ["Fragomen", "Pacific Law Group", "Berry Appleman & Leiden", "Sutter Legal", "Golden Gate Legal Aid", "Harbor & Finch LLP"],
    skills: ["Case management", "Legal research", "Document drafting", "Client intake", "Clio", "Compliance", "Bilingual (Spanish)", "Deadline tracking", "USCIS forms", "Docketing"],
    highlights: [
      "Managed a caseload of 80+ active matters with zero missed filing deadlines",
      "Prepared and assembled petitions and supporting evidence packets",
      "Built a client-intake checklist that cut document back-and-forth by 35%",
      "Coordinated with attorneys on RFE responses under tight timelines",
      "Trained 4 new legal assistants on firm docketing procedures",
      "Served as primary Spanish-speaking point of contact for clients",
      "Migrated 1,200 case files into Clio with full audit trail",
    ],
    strengths: ["Large, well-organized caseload experience", "Deadline discipline — no missed filings cited", "Bilingual client communication", "Comfortable with case-management software"],
    concerns: ["No direct experience with employment-based cases", "Gap of ~8 months in 2024", "Limited supervisory experience", "Has mostly worked in very large firms"],
  },
  cs: {
    titles: ["Client Success Associate", "Customer Support Specialist", "Account Coordinator", "Client Services Rep"],
    companies: ["Zendesk", "Intuit", "Bay Credit Union", "Kaiser Permanente", "Rippling", "Front"],
    skills: ["Client communication", "Zendesk", "Salesforce", "De-escalation", "Onboarding", "CSAT", "Bilingual (Mandarin)", "Bilingual (Hindi)", "Process documentation"],
    highlights: [
      "Maintained a 97% CSAT across 1,500+ client conversations",
      "Owned onboarding for 60 new clients per month",
      "Wrote the support playbook adopted by a 14-person team",
      "Reduced average first-response time from 9h to 2h",
      "Handled escalations for high-value accounts",
    ],
    strengths: ["Excellent satisfaction metrics", "Calm under pressure with escalations", "Writes clear process docs", "Multilingual"],
    concerns: ["Mostly phone/chat support, less in-person", "No experience in a regulated industry", "Looking for remote-first, role is hybrid"],
  },
  mkt: {
    titles: ["Marketing Specialist", "Content Marketer", "Growth Marketer", "Digital Marketing Coordinator"],
    companies: ["HubSpot", "Canva", "Local Roots Media", "Brightwave Agency", "Yelp"],
    skills: ["SEO", "Google Ads", "Content strategy", "HubSpot", "Copywriting", "Analytics", "Social media", "Email marketing", "Canva"],
    highlights: [
      "Grew organic traffic 3.2x in 12 months via a content + SEO program",
      "Managed a $40k/mo Google Ads budget at a 4.1x ROAS",
      "Launched a monthly newsletter with a 46% open rate",
      "Produced multilingual campaigns for 3 regional markets",
    ],
    strengths: ["Data-driven, cites real growth metrics", "Hands-on with paid + organic", "Strong writing samples"],
    concerns: ["Agency background, little in-house experience", "Limited B2C services marketing", "Prefers full-time over contract"],
  },
  ops: {
    titles: ["Operations Coordinator", "Office Manager", "Administrative Coordinator", "Operations Associate"],
    companies: ["WeWork", "Stanford Health Care", "Bay Area Rapid Transit", "Coastal Realty", "Blue Bottle"],
    skills: ["Scheduling", "Vendor management", "Google Workspace", "Notion", "Bookkeeping", "Process improvement", "Records management"],
    highlights: [
      "Coordinated schedules for a 40-person office across 3 sites",
      "Cut vendor costs 18% by consolidating contracts",
      "Built a records-retention system in Google Drive",
      "Owned new-hire onboarding logistics for 25 hires",
    ],
    strengths: ["Organized, systems-minded", "Google Workspace power user", "Experience with onboarding logistics"],
    concerns: ["Seeking more hours than a part-time role offers", "No legal-industry exposure"],
  },
};

const FIRST = ["Ava", "Noah", "Mia", "Ethan", "Sara", "Luis", "Grace", "Omar", "Hannah", "Kenji", "Zara", "Leo", "Maya", "Arjun", "Elena", "Victor", "Chloe", "Ravi", "Isabel", "Samuel", "Nadia", "Theo", "Fatima", "Diego", "Julia", "Kai", "Amara", "Ben", "Lucia", "Ming", "Rosa", "Imran", "Clara", "Andre", "Yuki", "Tariq", "Nina", "Felix", "Anika", "Mateo", "Leah", "Hugo"];
const LAST = ["Patel", "Garcia", "Nguyen", "Kim", "Johnson", "Hernandez", "Singh", "Lopez", "Wang", "Martinez", "Brown", "Ali", "Chen", "Davis", "Rossi", "Silva", "Kowalski", "Sato", "Mehta", "Ortiz", "Reyes", "Novak", "Haddad", "Bauer", "Torres", "Shah", "Lee", "Moreno"];
const CITIES = ["San Jose, CA", "San Francisco, CA", "Oakland, CA", "Fremont, CA", "Sunnyvale, CA", "Santa Clara, CA", "Austin, TX", "Seattle, WA", "Remote", "Hayward, CA", "Berkeley, CA"];
// Source ids from backend migration 003_sources.sql ("" = not tagged yet).
const SOURCES = ["linkedin", "linkedin", "linkedin", "indeed", "indeed", "referral", "referral", "instagram", "internshala", "internshala", "naukri", "website", ""];
const SCHOOLS = ["San José State University", "UC Berkeley", "UC Davis", "Santa Clara University", "University of Washington", "UT Austin", "De Anza College", "UCLA", "Cal State East Bay"];
const DEGREES: Record<Family, string[]> = {
  eng: ["B.S. Computer Science", "B.S. Software Engineering", "B.A. Mathematics"],
  legal: ["B.A. Political Science", "Paralegal Certificate (ABA-approved)", "B.A. Legal Studies", "B.A. Sociology"],
  cs: ["B.A. Communications", "B.A. Psychology", "B.S. Business Administration"],
  mkt: ["B.A. Marketing", "B.A. Journalism", "B.S. Business Administration"],
  ops: ["B.S. Business Administration", "A.A. Office Administration", "B.A. Economics"],
};

// Rough stage distribution (more people early in the funnel).
const STAGE_WEIGHTS: [string, number][] = [
  ["screening", 13],
  ["shortlisted", 8],
  ["interview", 7],
  ["final", 4],
  ["offer", 2],
  ["onboarding", 2],
  ["rejected", 5],
];
function weightedStage() {
  const total = STAGE_WEIGHTS.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [id, w] of STAGE_WEIGHTS) {
    if ((r -= w) <= 0) return id;
  }
  return "screening";
}

const OWNER_IDS = ["u_daniel", "u_aisha", "u_lena", "u_marcus"];
const NOTE_BODIES = [
  "Great phone screen — very clear communicator. Recommend moving forward.",
  "Salary expectations are at the top of our band. Flagging for the hiring manager.",
  "Available to start in 2 weeks. Prefers hybrid schedule.",
  "Asked for a portfolio / writing sample, should arrive by Friday.",
  "References checked out — both strongly positive.",
  "Resume is strong but light on the specific tooling we use. Worth a quick screen.",
];

function buildExperience(family: Family, years: number): Experience[] {
  const f = FAMILY[family];
  const count = years > 6 ? 3 : 2;
  const now = new Date().getFullYear();
  let end: number | "Present" = "Present";
  const items: Experience[] = [];
  let cursor = now;
  // Deal highlights without replacement so bullets don't repeat across roles.
  const deck = pickN(f.highlights, f.highlights.length);
  for (let i = 0; i < count; i++) {
    const span = Math.max(1, Math.round(years / count) + between(-1, 1));
    const start = cursor - span;
    items.push({
      company: pick(f.companies),
      title: i === 0 ? pick(f.titles) : pick(f.titles).replace("Senior ", ""),
      start: `${start}`,
      end: end === "Present" ? "Present" : `${end}`,
      highlights: deck.splice(0, Math.max(1, Math.min(3, Math.floor(deck.length / (count - i))))),
    });
    end = start;
    cursor = start;
  }
  return items;
}

function buildCandidates(): Candidate[] {
  const out: Candidate[] = [];
  const usedNames = new Set<string>();
  const openJobs = seedJobs;
  for (let i = 0; i < 42; i++) {
    let first = pick(FIRST);
    let last = pick(LAST);
    while (usedNames.has(first + last)) {
      first = pick(FIRST);
      last = pick(LAST);
    }
    usedNames.add(first + last);
    const job = openJobs[i % 5 === 4 ? between(0, openJobs.length - 1) : i % openJobs.length]!;
    const family = job.family;
    const f = FAMILY[family];
    const years = between(1, 11);
    const experience = buildExperience(family, years);
    const stageId = job.status === "paused" && rand() > 0.4 ? "screening" : weightedStage();
    const appliedDaysAgo = between(1, 30);
    const appliedAt = subDays(subHours(new Date(), between(0, 20)), appliedDaysAgo);
    const stageEnteredAt = subDays(new Date(), between(0, Math.max(0, appliedDaysAgo - 1)));
    const skills = pickN(f.skills, between(5, 7));
    const match = between(55, 96);
    const strengths = pickN(f.strengths, 3);
    const concerns = pickN(f.concerns, match > 85 ? 1 : 2);
    const id = `c_${i + 1}`;
    const fileName = `${first}_${last}_Resume.pdf`;
    const fileId = driveId();
    const ownerId = pick(OWNER_IDS);
    out.push({
      id,
      firstName: first,
      lastName: last,
      email: `${first}.${last}${between(1, 99)}@gmail.com`.toLowerCase(),
      phone: `(${between(408, 510)}) ${between(200, 999)}-${between(1000, 9999)}`,
      location: pick(CITIES),
      currentTitle: experience[0]!.title,
      currentCompany: experience[0]!.company,
      jobId: job.id,
      stageId,
      sourceId: pick(SOURCES),
      appliedAt: iso(appliedAt),
      stageEnteredAt: iso(stageEnteredAt < appliedAt ? appliedAt : stageEnteredAt),
      ownerId,
      rating: stageId === "screening" ? between(0, 3) : between(2, 5),
      tags: pickN(["Bilingual", "Referral", "Fast-track", "Relocating", "Remote only", "Visa sponsorship", "Senior"], between(0, 2)),
      skills,
      resume: {
        driveFileId: fileId,
        fileName,
        mimeType: "application/pdf",
        sizeKb: between(80, 420),
        uploadedAt: iso(appliedAt),
        uploadedById: pick(["u_marcus", "u_sofia", "u_priya"]),
        driveUrl: `https://drive.google.com/file/d/${fileId}/view`,
      },
      experience,
      education: [{ school: pick(SCHOOLS), degree: pick(DEGREES[family]), year: `${new Date().getFullYear() - years - between(0, 3)}` }],
      summary: {
        headline: `${years}+ yrs ${experience[0]!.title.toLowerCase()} · ${skills.slice(0, 2).join(", ")}`,
        overview: `${first} is a ${experience[0]!.title} at ${experience[0]!.company} with about ${years} year${years === 1 ? "" : "s"} of experience. ${experience[0]!.highlights[0]}. Previously at ${experience[1]?.company ?? experience[0]!.company}, where they ${experience[1]?.highlights[0]?.replace(/^\w/, (c) => c.toLowerCase()) ?? "built a strong track record"}. Profile aligns ${match > 80 ? "strongly" : match > 68 ? "reasonably well" : "partially"} with the ${job.title} requirements.`,
        strengths,
        concerns,
        matchScore: match,
        yearsExperience: years,
        generatedAt: iso(appliedAt),
      },
      notes:
        stageId !== "screening" && rand() > 0.35
          ? [{ id: `n_${i}`, authorId: ownerId, body: pick(NOTE_BODIES), createdAt: iso(subDays(new Date(), between(0, 6))) }]
          : [],
      starred: rand() > 0.82,
    });
  }
  return out;
}

export const seedCandidates = buildCandidates();

function buildInterviews(cands: Candidate[]): Interview[] {
  const out: Interview[] = [];
  const today = startOfDay(new Date());
  const inPlay = cands.filter((c) => ["interview", "final", "offer", "shortlisted"].includes(c.stageId));
  inPlay.forEach((c, i) => {
    const future = c.stageId === "interview" || c.stageId === "final" || (c.stageId === "shortlisted" && i % 2 === 0);
    const dayOffset = future ? between(0, 9) : -between(1, 8);
    let day = addDays(today, dayOffset);
    if (day.getDay() === 0) day = addDays(day, 1);
    if (day.getDay() === 6) day = addDays(day, 2);
    const start = setMinutes(setHours(day, pick([9, 10, 11, 13, 14, 15, 16])), pick([0, 30]));
    const type = c.stageId === "final" ? pick(["onsite", "video"] as const) : pick(["phone", "video", "video"] as const);
    const past = start < new Date();
    const title =
      c.stageId === "final" ? "Final interview" : c.stageId === "shortlisted" ? "Intro call" : c.stageId === "offer" ? "Final interview" : "Interview · Round 1";
    out.push({
      id: `i_${i + 1}`,
      candidateId: c.id,
      jobId: c.jobId,
      title,
      type,
      start: iso(start),
      durationMin: type === "onsite" ? 60 : pick([30, 45]),
      interviewerIds: pickN(["u_marcus", "u_sofia", "u_priya", "u_daniel", "u_lena"], type === "onsite" ? 2 : 1),
      meetLink: type === "video" ? `https://meet.google.com/${"abc".split("").map(() => String.fromCharCode(97 + between(0, 25))).join("")}-${Array.from({ length: 4 }, () => String.fromCharCode(97 + between(0, 25))).join("")}-${Array.from({ length: 3 }, () => String.fromCharCode(97 + between(0, 25))).join("")}` : undefined,
      location: type === "onsite" ? "HQ · Conference Room B" : undefined,
      status: past ? "completed" : "scheduled",
      calendarEventId: `gcal_${i}`,
      bookedVia: i % 3 === 0 ? "bl_intro" : undefined,
      feedback: past
        ? [{ authorId: "u_marcus", recommendation: pick(["strong_yes", "yes", "yes", "no"] as const), comment: pick(["Solid fundamentals, good culture add.", "Strong communicator; a bit light on depth.", "Would hire. Clear examples for every question.", "Not quite the experience level we need."]) }]
        : undefined,
    });
  });
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

export const seedInterviews = buildInterviews(seedCandidates);

export const seedBookingLinks: BookingLink[] = [
  { id: "bl_intro", slug: "intro-call", title: "30-min intro call", durationMin: 30, type: "phone", hostIds: ["u_daniel", "u_aisha"], days: [1, 2, 3, 4, 5], startHour: 9, endHour: 17, bufferMin: 15, active: true, bookings: 18 },
  { id: "bl_tech", slug: "technical-interview", title: "Technical interview (video)", durationMin: 60, type: "video", hostIds: ["u_marcus"], days: [2, 4], startHour: 10, endHour: 16, bufferMin: 15, active: true, bookings: 7 },
  { id: "bl_final", slug: "final-round", title: "Final round with leadership", durationMin: 45, type: "video", hostIds: ["u_priya", "u_sofia"], days: [3, 5], startHour: 13, endHour: 17, bufferMin: 30, active: false, bookings: 4 },
];

export const seedTemplates: EmailTemplate[] = [
  { id: "t_received", name: "Application received", category: "stage_update", subject: "We received your application for {{job_title}}", body: "Hi {{first_name}},\n\nThank you for applying for the {{job_title}} role at {{company}}. Our team is reviewing your resume and we'll be in touch within 5 business days.\n\nBest,\n{{sender_name}}", updatedAt: iso(subDays(new Date(), 20)) },
  { id: "t_shortlisted", name: "You've been shortlisted", category: "stage_update", subject: "Next steps for {{job_title}} at {{company}}", body: "Hi {{first_name}},\n\nGood news — we'd love to learn more about you for the {{job_title}} role. Please pick a time for a short intro call here:\n{{booking_link}}\n\nLooking forward to it,\n{{sender_name}}", updatedAt: iso(subDays(new Date(), 12)) },
  { id: "t_interview", name: "Interview invitation", category: "interview", subject: "Interview invitation · {{job_title}}", body: "Hi {{first_name}},\n\nWe'd like to invite you to interview for {{job_title}}. Choose a slot that works for you:\n{{booking_link}}\n\nYou'll receive a Google Calendar invite with the meeting link once booked.\n\nThanks,\n{{sender_name}}", updatedAt: iso(subDays(new Date(), 8)) },
  { id: "t_final", name: "Final interview", category: "interview", subject: "Final round for {{job_title}}", body: "Hi {{first_name}},\n\nThank you for your time so far. We'd like to invite you to a final interview with our leadership team. Please book a time here: {{booking_link}}\n\nBest,\n{{sender_name}}", updatedAt: iso(subDays(new Date(), 8)) },
  { id: "t_offer", name: "Offer coming your way", category: "offer", subject: "An offer from {{company}}", body: "Hi {{first_name}},\n\nWe're thrilled to let you know we'll be extending an offer for the {{job_title}} position. Your formal offer letter will follow shortly from our People team.\n\nCongratulations!\n{{sender_name}}", updatedAt: iso(subDays(new Date(), 30)) },
  { id: "t_welcome", name: "Welcome & onboarding", category: "stage_update", subject: "Welcome to {{company}}, {{first_name}}!", body: "Hi {{first_name}},\n\nWelcome aboard! Over the next few days you'll receive your onboarding checklist, equipment details and first-week schedule.\n\nWe're excited to have you,\n{{sender_name}}", updatedAt: iso(subDays(new Date(), 30)) },
  { id: "t_rejection", name: "Not moving forward", category: "rejection", subject: "Your application for {{job_title}}", body: "Hi {{first_name}},\n\nThank you for your interest in {{company}} and for the time you invested in the process. After careful consideration, we've decided not to move forward at this time.\n\nWe'll keep your resume on file and reach out if a better fit opens up.\n\nWarm regards,\n{{sender_name}}", updatedAt: iso(subDays(new Date(), 40)) },
  { id: "t_checkin", name: "Status check-in", category: "general", subject: "An update on your application", body: "Hi {{first_name}},\n\nA quick update: your application for {{job_title}} is currently in the {{stage}} stage. We appreciate your patience and will share next steps soon.\n\nBest,\n{{sender_name}}", updatedAt: iso(subDays(new Date(), 4)) },
];

export const seedCampaigns: EmailCampaign[] = [
  { id: "ec_1", subject: "An update on your application", templateId: "t_checkin", fromAddress: "careers@yourcompany.com", recipientIds: seedCandidates.filter((c) => c.stageId === "screening").map((c) => c.id), sentById: "u_marcus", sentAt: iso(subDays(new Date(), 2)), status: "sent", stats: { delivered: 12, opened: 9, clicked: 3, bounced: 1 } },
  { id: "ec_2", subject: "Interview invitation · Case Manager", templateId: "t_interview", fromAddress: "careers@yourcompany.com", recipientIds: seedCandidates.filter((c) => c.jobId === "j_case").slice(0, 6).map((c) => c.id), sentById: "u_sofia", sentAt: iso(subDays(new Date(), 5)), status: "sent", stats: { delivered: 6, opened: 6, clicked: 5, bounced: 0 } },
  { id: "ec_3", subject: "Your application for Operations Coordinator", templateId: "t_rejection", fromAddress: "careers@yourcompany.com", recipientIds: seedCandidates.filter((c) => c.stageId === "rejected").map((c) => c.id), sentById: "u_priya", sentAt: iso(subDays(new Date(), 9)), status: "sent", stats: { delivered: 5, opened: 4, clicked: 0, bounced: 0 } },
  { id: "ec_4", subject: "Hiring event: Meet the team (Oct 15)", fromAddress: "careers@yourcompany.com", recipientIds: seedCandidates.filter((c) => ["shortlisted", "interview"].includes(c.stageId)).map((c) => c.id), sentById: "u_marcus", sentAt: iso(addDays(new Date(), 3)), status: "scheduled", stats: { delivered: 0, opened: 0, clicked: 0, bounced: 0 } },
];

export const seedActivity: ActivityEvent[] = (() => {
  const events: ActivityEvent[] = [];
  seedCandidates.slice(0, 24).forEach((c, i) => {
    const stage = seedStages.find((s) => s.id === c.stageId)!;
    events.push({ id: `a_s${i}`, actorId: c.ownerId, type: "stage_change", candidateId: c.id, message: `moved ${c.firstName} ${c.lastName} to ${stage.name}`, createdAt: c.stageEnteredAt });
    if (i % 2 === 0)
      events.push({ id: `a_r${i}`, actorId: c.resume.uploadedById, type: "resume_upload", candidateId: c.id, message: `imported ${c.resume.fileName} from Google Drive`, createdAt: c.appliedAt });
  });
  seedInterviews.slice(0, 8).forEach((iv, i) => {
    const c = seedCandidates.find((x) => x.id === iv.candidateId)!;
    events.push({ id: `a_i${i}`, actorId: iv.interviewerIds[0]!, type: "interview_scheduled", candidateId: c.id, message: `scheduled ${iv.title.toLowerCase()} with ${c.firstName} ${c.lastName}`, createdAt: iso(addMinutes(new Date(iv.start), -60 * 24 * 3)) });
  });
  events.push({ id: "a_u1", actorId: "u_priya", type: "user_invited", message: "invited tom@yourcompany.com as Recruiter", createdAt: iso(subDays(new Date(), 1)) });
  events.push({ id: "a_u2", actorId: "u_priya", type: "role_changed", message: "changed Sofia Alvarez's role to Admin", createdAt: iso(subDays(new Date(), 6)) });
  events.push({ id: "a_e1", actorId: "u_marcus", type: "email_sent", message: "sent “An update on your application” to 13 candidates", createdAt: iso(subDays(new Date(), 2)) });
  events.push({ id: "a_x1", actorId: "u_priya", type: "settings_changed", message: "enabled automatic Drive sync for ATS/Resumes", createdAt: iso(subDays(new Date(), 12)) });
  return events.filter((e) => new Date(e.createdAt) <= new Date()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
})();

export const seedSettings: OrgSettings = {
  orgName: "Your Company",
  emailDomain: "yourcompany.com",
  senderName: "Talent Team",
  senderAddress: "careers@yourcompany.com",
  replyTo: "recruiting@yourcompany.com",
  emailSignature: "Talent Team\nYour Company · hire.yourcompany.com",
  dnsRecords: [
    { type: "SPF", host: "@", value: "v=spf1 include:_spf.google.com include:sendgrid.net ~all", verified: true },
    { type: "DKIM", host: "s1._domainkey", value: "s1.domainkey.u1234.wl.sendgrid.net", verified: true },
    { type: "DMARC", host: "_dmarc", value: "v=DMARC1; p=quarantine; rua=mailto:dmarc@yourcompany.com", verified: false },
  ],
  google: {
    connected: true,
    account: "workspace-admin@yourcompany.com",
    driveRootFolder: "ATS/Resumes",
    driveSyncEnabled: true,
    lastSyncAt: iso(subHours(new Date(), 0.3)),
    calendarId: "hiring@yourcompany.com",
    autoMeetLinks: true,
  },
  aiSummariesEnabled: true,
};

/** Unfiled resumes sitting in the watched Drive folder, waiting to be imported. */
export const seedDriveInbox = [
  { driveFileId: driveId(), fileName: "Rohan_Desai_CV.pdf", folder: "ATS/Resumes/Case Manager", sizeKb: 212, modifiedAt: iso(subHours(new Date(), 2)) },
  { driveFileId: driveId(), fileName: "Emily Zhang - Resume 2026.pdf", folder: "ATS/Resumes/Full-Stack Developer", sizeKb: 188, modifiedAt: iso(subHours(new Date(), 5)) },
  { driveFileId: driveId(), fileName: "M.Okonkwo_Paralegal.docx", folder: "ATS/Resumes/Paralegal", sizeKb: 96, modifiedAt: iso(subHours(new Date(), 26)) },
];

export type DriveInboxFile = (typeof seedDriveInbox)[number];
