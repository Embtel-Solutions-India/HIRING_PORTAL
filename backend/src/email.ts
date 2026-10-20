/** Candidate email: templates, campaigns (bulk or single), SMTP delivery and open/click tracking. */
import nodemailer, { type Transporter } from "nodemailer";
import { logActivity } from "./activity.ts";
import { config } from "./config.ts";
import { sign } from "./crypto.ts";
import { prisma } from "./db.ts";
import { getSetting } from "./settings.ts";

let smtp: Transporter | null = null;
const smtpClient = () => {
  const { host, port, user, pass } = config.email.smtp;
  // Port 465 is TLS from the start; anything else (587, 25, 2525) upgrades with STARTTLS.
  return (smtp ??= nodemailer.createTransport({ host, port, secure: port === 465, auth: user ? { user, pass } : undefined }));
};

interface Outgoing {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Who gets the reply: the teammate who sent it, plus anyone else on it (e.g. interviewers). Falls back to the org reply-to. */
  replyTo?: string[];
}

async function deliver(msg: Outgoing): Promise<string> {
  const org = await getSetting("org");
  const from = `"${org.senderName.replace(/"/g, "")}" <${org.senderAddress}>`;
  const replyTo = msg.replyTo?.length ? msg.replyTo : org.replyTo || undefined;
  if (config.email.transport === "log") {
    console.log(`\n[email:log] From: ${from}\nTo: ${msg.to}\nReply-To: ${replyTo ?? ""}\nSubject: ${msg.subject}\n\n${msg.text}\n`);
    return `log-${Date.now()}`;
  }
  const res = await smtpClient().sendMail({ from, to: msg.to, replyTo, subject: msg.subject, text: msg.text, html: msg.html });
  return res.messageId ?? "";
}

// ---------- rendering ----------

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

interface MergeContext {
  candidateId: string;
  firstName: string;
  lastName: string;
  jobTitle: string;
  stage: string;
}

export async function mergeFields(ctx: MergeContext) {
  const org = await getSetting("org");
  const link = await prisma.booking_links.findFirst({ where: { active: true }, orderBy: [{ bookings: "desc" }, { created_at: "asc" }], select: { slug: true } });
  return {
    first_name: ctx.firstName,
    last_name: ctx.lastName,
    full_name: `${ctx.firstName} ${ctx.lastName}`.trim(),
    job_title: ctx.jobTitle || "the role",
    stage: ctx.stage,
    company: org.orgName,
    sender_name: org.senderName,
    booking_link: link ? `${config.appUrl}/book/${link.slug}?c=${ctx.candidateId}` : config.appUrl,
  } as Record<string, string>;
}

export const render = (text: string, fields: Record<string, string>) => text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => fields[k] ?? m);

function toHtml(text: string, signature: string, messageId?: string) {
  const linkify = (s: string) =>
    esc(s).replace(/https?:\/\/[^\s<]+/g, (url) => {
      const raw = url.replace(/&amp;/g, "&");
      const href = messageId ? `${config.appUrl}/t/c/${messageId}?u=${encodeURIComponent(raw)}&s=${sign(`${messageId}|${raw}`)}` : raw;
      return `<a href="${esc(href)}" style="color:#1a5233">${url}</a>`;
    });
  const body = text
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px">${linkify(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
  const pixel = messageId ? `<img src="${config.appUrl}/t/o/${messageId}.gif" width="1" height="1" alt="" style="display:block">` : "";
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f5f1;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1b1a17">
<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e6e3db;border-radius:12px;padding:28px">${body}
<p style="margin:22px 0 0;color:#7a766c;font-size:13px">${esc(signature).replace(/\n/g, "<br>")}</p></div>${pixel}</body></html>`;
}

// ---------- campaigns ----------

/**
 * Creates a campaign with one message per candidate. Sends right away unless scheduled for later.
 * Each recipient's application decides {{job_title}} and {{stage}}.
 */
export async function createCampaign(input: { recipients: { candidateId: string; applicationId: string | null }[]; subject: string; body: string; templateId?: string | null; scheduledAt?: string | null; replyTo?: string[]; actorId: string | null }) {
  const org = await getSetting("org");
  const sendAt = input.scheduledAt ? new Date(input.scheduledAt) : new Date();
  const scheduled = sendAt.getTime() > Date.now() + 30_000;
  const appFor = new Map(input.recipients.map((r) => [r.candidateId, r.applicationId]));
  const recipients = await prisma.candidates.findMany({ where: { id: { in: [...appFor.keys()] } }, select: { id: true, email: true } });
  const campaign = await prisma.email_campaigns.create({
    data: {
      subject: input.subject,
      body: input.body,
      template_id: input.templateId ?? null,
      from_address: org.senderAddress,
      sent_by_id: input.actorId,
      send_at: sendAt,
      status: scheduled ? "scheduled" : "sending",
    },
    select: { id: true },
  });
  for (const r of recipients) {
    await prisma.email_messages.create({ data: { campaign_id: campaign.id, candidate_id: r.id, application_id: appFor.get(r.id) ?? null, to_address: r.email } });
  }
  const label = recipients.length === 1 ? "1 candidate" : `${recipients.length} candidates`;
  await logActivity(input.actorId, "email_sent", `${scheduled ? "scheduled" : "sent"} “${input.subject}” to ${label}`, recipients.length === 1 ? recipients[0]!.id : null);
  // The sender (sent_by_id) is stored and always gets replies. ponytail: extra replyTo isn't stored, so it only
  // reaches campaigns sent right away (interview confirmations are); add a column if scheduled sends ever need it.
  if (!scheduled) void sendCampaign(campaign.id, input.replyTo);
  return campaign.id;
}

const sending = new Set<string>();

export async function sendCampaign(campaignId: string, extraReplyTo: string[] = []) {
  if (sending.has(campaignId)) return;
  sending.add(campaignId);
  try {
    await prisma.email_campaigns.updateMany({ where: { id: campaignId }, data: { status: "sending" } });
    const campaign = await prisma.email_campaigns.findUnique({ where: { id: campaignId }, select: { subject: true, body: true, users: { select: { email: true } } } });
    const replyTo = [...new Set([campaign?.users?.email, ...extraReplyTo].filter((e): e is string => !!e))];
    const org = await getSetting("org");
    const messages = (
      await prisma.email_messages.findMany({
        where: { campaign_id: campaignId, status: "queued" },
        select: {
          id: true,
          to_address: true,
          candidate_id: true,
          candidates: { select: { first_name: true, last_name: true } },
          applications: { select: { jobs: { select: { title: true } }, stages: { select: { name: true } } } },
        },
      })
    ).map(({ candidates: c, applications: a, ...m }) => ({ ...m, first_name: c?.first_name, last_name: c?.last_name, job_title: a?.jobs?.title, stage: a?.stages.name }));
    let failures = 0;
    for (const m of messages) {
      try {
        if (!m.to_address || !m.to_address.includes("@")) throw new Error("Candidate has no email address");
        const fields = await mergeFields({ candidateId: m.candidate_id ?? "", firstName: m.first_name ?? "", lastName: m.last_name ?? "", jobTitle: m.job_title ?? "", stage: m.stage ?? "" });
        const subject = render(campaign!.subject, fields);
        const text = render(campaign!.body, fields);
        const providerId = await deliver({ to: m.to_address, subject, text: `${text}\n\n${org.emailSignature}`, html: toHtml(text, org.emailSignature, m.id), replyTo });
        await prisma.email_messages.updateMany({ where: { id: m.id }, data: { status: "sent", subject, provider_id: providerId, sent_at: new Date() } });
      } catch (e) {
        failures++;
        await prisma.email_messages.updateMany({ where: { id: m.id }, data: { status: "failed", error: e instanceof Error ? e.message.slice(0, 500) : String(e) } });
      }
      await new Promise((r) => setTimeout(r, Math.ceil(1000 / config.email.maxPerSecond)));
    }
    await prisma.email_campaigns.updateMany({ where: { id: campaignId }, data: { status: failures && failures === messages.length ? "failed" : "sent" } });
  } finally {
    sending.delete(campaignId);
  }
}

export async function sendDueCampaigns() {
  const due = await prisma.email_campaigns.findMany({ where: { status: "scheduled", send_at: { lte: new Date() } }, select: { id: true } });
  for (const c of due) await sendCampaign(c.id);
}

/** Transactional email to a teammate (invites, test emails). Not tracked. */
export async function sendSystemEmail(to: string, subject: string, text: string, replyTo: string) {
  const org = await getSetting("org");
  return deliver({ to, subject, text: `${text}\n\n${org.emailSignature}`, html: toHtml(text, org.emailSignature), replyTo: [replyTo] });
}
