/** Candidate email: templates, campaigns (bulk or single), Amazon SES delivery and open/click tracking. */
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { logActivity } from "./activity.ts";
import { config } from "./config.ts";
import { sign } from "./crypto.ts";
import { one, q } from "./db.ts";
import { getSetting } from "./settings.ts";

let ses: SESv2Client | null = null;
const sesClient = () => (ses ??= new SESv2Client({ region: config.email.awsRegion }));

interface Outgoing {
  to: string;
  subject: string;
  text: string;
  html: string;
}

async function deliver(msg: Outgoing): Promise<string> {
  const org = await getSetting("org");
  const from = `"${org.senderName.replace(/"/g, "")}" <${org.senderAddress}>`;
  if (config.email.transport === "log") {
    console.log(`\n[email:log] From: ${from}\nTo: ${msg.to}\nSubject: ${msg.subject}\n\n${msg.text}\n`);
    return `log-${Date.now()}`;
  }
  const res = await sesClient().send(
    new SendEmailCommand({
      FromEmailAddress: from,
      Destination: { ToAddresses: [msg.to] },
      ReplyToAddresses: org.replyTo ? [org.replyTo] : undefined,
      ConfigurationSetName: config.email.sesConfigurationSet || undefined,
      Content: {
        Simple: {
          Subject: { Data: msg.subject, Charset: "UTF-8" },
          Body: { Text: { Data: msg.text, Charset: "UTF-8" }, Html: { Data: msg.html, Charset: "UTF-8" } },
        },
      },
    }),
  );
  return res.MessageId ?? "";
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
  const link = await one<{ slug: string }>("select slug from booking_links where active order by bookings desc, created_at limit 1");
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

/** Creates a campaign with one message per candidate. Sends right away unless scheduled for later. */
export async function createCampaign(input: { recipientIds: string[]; subject: string; body: string; templateId?: string | null; scheduledAt?: string | null; actorId: string | null }) {
  const org = await getSetting("org");
  const sendAt = input.scheduledAt ? new Date(input.scheduledAt) : new Date();
  const scheduled = sendAt.getTime() > Date.now() + 30_000;
  const recipients = await q<{ id: string; email: string }>("select id, email from candidates where id = any($1::uuid[])", [input.recipientIds]);
  const campaign = await one<{ id: string }>(
    `insert into email_campaigns (subject, body, template_id, from_address, sent_by_id, send_at, status) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [input.subject, input.body, input.templateId ?? null, org.senderAddress, input.actorId, sendAt, scheduled ? "scheduled" : "sending"],
  );
  for (const r of recipients) {
    await q("insert into email_messages (campaign_id, candidate_id, to_address) values ($1, $2, $3)", [campaign!.id, r.id, r.email]);
  }
  const label = recipients.length === 1 ? "1 candidate" : `${recipients.length} candidates`;
  await logActivity(input.actorId, "email_sent", `${scheduled ? "scheduled" : "sent"} “${input.subject}” to ${label}`, recipients.length === 1 ? recipients[0]!.id : null);
  if (!scheduled) void sendCampaign(campaign!.id);
  return campaign!.id;
}

const sending = new Set<string>();

export async function sendCampaign(campaignId: string) {
  if (sending.has(campaignId)) return;
  sending.add(campaignId);
  try {
    await q("update email_campaigns set status = 'sending' where id = $1", [campaignId]);
    const campaign = await one<{ subject: string; body: string }>("select subject, body from email_campaigns where id = $1", [campaignId]);
    const org = await getSetting("org");
    const messages = await q<{ id: string; to_address: string; candidate_id: string | null; first_name: string; last_name: string; job_title: string | null; stage: string | null }>(
      `select m.id, m.to_address, m.candidate_id, c.first_name, c.last_name, j.title as job_title, s.name as stage
       from email_messages m left join candidates c on c.id = m.candidate_id left join jobs j on j.id = c.job_id left join stages s on s.id = c.stage_id
       where m.campaign_id = $1 and m.status = 'queued'`,
      [campaignId],
    );
    let failures = 0;
    for (const m of messages) {
      try {
        if (!m.to_address || !m.to_address.includes("@")) throw new Error("Candidate has no email address");
        const fields = await mergeFields({ candidateId: m.candidate_id ?? "", firstName: m.first_name ?? "", lastName: m.last_name ?? "", jobTitle: m.job_title ?? "", stage: m.stage ?? "" });
        const subject = render(campaign!.subject, fields);
        const text = render(campaign!.body, fields);
        const providerId = await deliver({ to: m.to_address, subject, text: `${text}\n\n${org.emailSignature}`, html: toHtml(text, org.emailSignature, m.id) });
        await q("update email_messages set status = 'sent', subject = $2, provider_id = $3, sent_at = now() where id = $1", [m.id, subject, providerId]);
      } catch (e) {
        failures++;
        await q("update email_messages set status = 'failed', error = $2 where id = $1", [m.id, e instanceof Error ? e.message.slice(0, 500) : String(e)]);
      }
      await new Promise((r) => setTimeout(r, Math.ceil(1000 / config.email.maxPerSecond)));
    }
    await q("update email_campaigns set status = $2 where id = $1", [campaignId, failures && failures === messages.length ? "failed" : "sent"]);
  } finally {
    sending.delete(campaignId);
  }
}

export async function sendDueCampaigns() {
  const due = await q<{ id: string }>("select id from email_campaigns where status = 'scheduled' and send_at <= now()");
  for (const c of due) await sendCampaign(c.id);
}

/** Transactional email to a teammate (invites, test emails). Not tracked. */
export async function sendSystemEmail(to: string, subject: string, text: string) {
  const org = await getSetting("org");
  return deliver({ to, subject, text: `${text}\n\n${org.emailSignature}`, html: toHtml(text, org.emailSignature) });
}
