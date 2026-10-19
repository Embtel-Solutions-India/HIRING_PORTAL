// All runtime configuration comes from environment variables (see /.env.example).
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function str(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

function bool(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

/** A number of at least 1; anything non-numeric falls back to the default. */
export function positiveNumber(raw: string, fallback: number): number {
  const n = Number(raw);
  return raw.trim() !== "" && Number.isFinite(n) ? Math.max(1, n) : fallback;
}

const nodeEnv = str("NODE_ENV", "development");
const appUrl = str("APP_URL", "http://localhost:3000").replace(/\/$/, "");

export const config = {
  isProd: nodeEnv === "production",
  port: Number(str("PORT", "3000")),
  appUrl,
  secureCookies: appUrl.startsWith("https://"),
  databaseUrl: str("DATABASE_URL", "postgres://postgres:postgres@localhost:5433/hirely"),
  /** 32+ random characters. Encrypts the stored Google refresh token and signs tracking links. */
  appSecret: str("APP_SECRET"),
  /** First person allowed in. They become Super Admin on first sign-in. */
  superAdminEmail: str("SUPER_ADMIN_EMAIL").toLowerCase(),
  /** Optional: only Google accounts on this domain can sign in (e.g. yourcompany.com). */
  allowedEmailDomain: str("ALLOWED_EMAIL_DOMAIN").toLowerCase(),
  orgName: str("ORG_NAME", "Your Company"),
  orgTimezone: str("ORG_TIMEZONE", "America/Los_Angeles"),
  devLogin: !(nodeEnv === "production") && bool("DEV_LOGIN", false),

  google: {
    clientId: str("GOOGLE_CLIENT_ID"),
    clientSecret: str("GOOGLE_CLIENT_SECRET"),
    /** The only account allowed to connect, reconnect or disconnect Google (Drive + Calendar). */
    ownerEmail: (str("GOOGLE_OWNER_EMAIL") || "admin@embtelsolutions.com").toLowerCase(),
  },

  email: {
    /** "smtp" sends through any SMTP provider; "log" prints emails to the server log (for testing). */
    transport: (str("EMAIL_TRANSPORT", "log") === "smtp" ? "smtp" : "log") as "smtp" | "log",
    fromAddress: str("EMAIL_FROM_ADDRESS"),
    fromName: str("EMAIL_FROM_NAME", "Talent Team"),
    replyTo: str("EMAIL_REPLY_TO"),
    smtp: {
      host: str("SMTP_HOST"),
      port: Number(str("SMTP_PORT", "587")),
      user: str("SMTP_USER"),
      pass: str("SMTP_PASS"),
    },
    maxPerSecond: positiveNumber(str("EMAIL_MAX_PER_SECOND"), 5),
  },

  anthropicApiKey: str("ANTHROPIC_API_KEY"),

  /** Where resumes are kept when Google Drive isn't connected yet, and for local dev. */
  dataDir: path.resolve(str("DATA_DIR", path.join(here, "..", "data"))),
  frontendDist: path.resolve(str("FRONTEND_DIST", path.join(here, "..", "..", "frontend", "dist"))),
  driveSyncMinutes: positiveNumber(str("DRIVE_SYNC_MINUTES"), 5),

  /**
   * Primary resume storage: region + bucket turn it on (empty = resumes stay in Drive / on disk as before).
   * The access keys are optional; without them the server's IAM role is used (EC2 instance profile).
   */
  s3: {
    region: str("AWS_REGION"),
    bucket: str("S3_BUCKET"),
    accessKeyId: str("AWS_ACCESS_KEY_ID"),
    secretAccessKey: str("AWS_SECRET_ACCESS_KEY"),
  },
  /** Days a deleted resume's other copy is kept before it is removed. */
  resumeDeleteGraceDays: positiveNumber(str("RESUME_DELETE_GRACE_DAYS"), 30),
};

export function assertConfig() {
  const problems: string[] = [];
  if (config.appSecret.length < 32) problems.push("APP_SECRET must be at least 32 characters (run: openssl rand -hex 32)");
  if (config.isProd) {
    if (!config.superAdminEmail) problems.push("SUPER_ADMIN_EMAIL is required");
    if (!config.google.clientId || !config.google.clientSecret) problems.push("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required");
    if (!config.appUrl.startsWith("https://")) problems.push("APP_URL must start with https:// in production");
  }
  if (config.email.transport === "smtp" && !config.email.smtp.host) problems.push("SMTP_HOST is required when EMAIL_TRANSPORT=smtp");
  if (problems.length) {
    console.error("\nConfiguration problems:\n - " + problems.join("\n - ") + "\n");
    process.exit(1);
  }
}
