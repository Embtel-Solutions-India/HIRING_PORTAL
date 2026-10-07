import dns from "node:dns/promises";
import { CreateEmailIdentityCommand, GetEmailIdentityCommand, NotFoundException, SESv2Client } from "@aws-sdk/client-sesv2";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { canManageRole, ROLE_LABEL } from "../../../frontend/src/lib/permissions.ts";
import type { Role } from "../../../frontend/src/types.ts";
import { logActivity } from "../activity.ts";
import { config } from "../config.ts";
import { one, q, tx } from "../db.ts";
import { createCampaign, sendSystemEmail } from "../email.ts";
import { HttpError, isUuid, requirePerm, type UserRow } from "../http.ts";
import { ensureJobFolder } from "../storage.ts";
import { getSetting, patchSetting, setSetting, type DnsRecord } from "../settings.ts";

const RoleEnum = z.enum(["interviewer", "user", "admin", "super_admin"]);
const AVATAR_COLORS = ["#1d5a3a", "#1e40af", "#9a3412", "#6d28d9", "#0f766e", "#be185d", "#4d7c0f", "#a16207"];

export default async function adminRoutes(app: FastifyInstance) {
  // ---------- email ----------

  app.post("/api/emails", async (req) => {
    const body = z
      .object({
        recipientIds: z.array(z.string().uuid()).min(1).max(2000),
        subject: z.string().trim().min(1).max(300),
        body: z.string().max(20000),
        templateId: z.string().optional(),
        scheduledAt: z.string().datetime({ offset: true }).optional(),
      })
      .parse(req.body);
    const user = requirePerm(req, body.recipientIds.length > 1 ? "emails.sendBulk" : "emails.sendSingle");
    const id = await createCampaign({ ...body, actorId: user.id });
    return { id };
  });

  const Template = z.object({
    name: z.string().trim().min(1).max(120),
    subject: z.string().trim().min(1).max(300),
    body: z.string().max(20000),
    category: z.enum(["stage_update", "interview", "rejection", "offer", "general"]),
  });

  app.put("/api/email-templates/:id", async (req) => {
    requirePerm(req, "emails.manageTemplates");
    const { id } = req.params as { id: string };
    if (!/^[\w-]{1,64}$/.test(id)) throw new HttpError(400, "Bad id");
    const t = Template.parse(req.body);
    await q(
      `insert into email_templates (id, name, subject, body, category, updated_at) values ($1, $2, $3, $4, $5, now())
       on conflict (id) do update set name = excluded.name, subject = excluded.subject, body = excluded.body, category = excluded.category, updated_at = now()`,
      [id, t.name, t.subject, t.body, t.category],
    );
    return { ok: true };
  });

  app.delete("/api/email-templates/:id", async (req) => {
    requirePerm(req, "emails.manageTemplates");
    await q("delete from email_templates where id = $1", [(req.params as { id: string }).id]);
    return { ok: true };
  });

  // ---------- jobs ----------

  const Job = z.object({
    title: z.string().trim().min(1).max(120),
    department: z.string().max(120).default(""),
    location: z.string().max(120).default(""),
    type: z.enum(["Full-time", "Part-time", "Contract", "Internship"]),
    status: z.enum(["open", "paused", "closed"]),
    hiringManagerId: z.string().uuid().or(z.literal("")),
    openings: z.number().int().min(1).max(500),
    description: z.string().max(20000).optional(),
  });

  app.put("/api/jobs/:id", async (req) => {
    const user = requirePerm(req, "jobs.manage");
    const { id } = req.params as { id: string };
    const j = Job.parse(req.body);
    const existing = isUuid(id) ? await one<{ title: string }>("select title from jobs where id = $1", [id]) : undefined;
    let jobId = id;
    if (existing) {
      await q(
        "update jobs set title=$2, department=$3, location=$4, type=$5, status=$6, hiring_manager_id=$7, openings=$8, description=coalesce($9, description) where id=$1",
        [id, j.title, j.department, j.location, j.type, j.status, j.hiringManagerId || null, j.openings, j.description ?? null],
      );
    } else {
      const row = await one<{ id: string }>(
        "insert into jobs (title, department, location, type, status, hiring_manager_id, openings, description) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id",
        [j.title, j.department, j.location, j.type, j.status, j.hiringManagerId || null, j.openings, j.description ?? ""],
      );
      jobId = row!.id;
      await logActivity(user.id, "settings_changed", `created job ${j.title}`);
    }
    try {
      await ensureJobFolder(jobId);
    } catch (e) {
      console.warn("[jobs] couldn't create Drive folder:", e instanceof Error ? e.message : e);
    }
    return { id: jobId };
  });

  // ---------- team ----------

  app.post("/api/users/invite", async (req) => {
    const actor = requirePerm(req, "users.manage");
    const body = z.object({ name: z.string().trim().min(1).max(120), email: z.string().trim().toLowerCase().email(), role: RoleEnum, title: z.string().max(120).default("") }).parse(req.body);
    if (!canManageRole(actor.role, body.role)) throw new HttpError(403, `You can't invite ${ROLE_LABEL[body.role]}s`);
    if (config.allowedEmailDomain && !body.email.endsWith(`@${config.allowedEmailDomain}`)) throw new HttpError(400, `Only @${config.allowedEmailDomain} accounts can sign in`);
    const existing = await one<UserRow>("select * from users where email = $1", [body.email]);
    if (existing && existing.status !== "deactivated") throw new HttpError(409, "That person is already on the team");
    const count = await one<{ n: number }>("select count(*)::int as n from users");
    if (existing) {
      await q("update users set name=$2, title=$3, role=$4, status='invited' where id=$1", [existing.id, body.name, body.title, body.role]);
    } else {
      await q("insert into users (email, name, title, role, status, avatar_color) values ($1,$2,$3,$4,'invited',$5)", [
        body.email,
        body.name,
        body.title,
        body.role,
        AVATAR_COLORS[(count?.n ?? 0) % AVATAR_COLORS.length],
      ]);
    }
    await logActivity(actor.id, "user_invited", `invited ${body.email} as ${ROLE_LABEL[body.role]}`);
    await sendInvite(body.email, body.name, actor.name, body.role).catch((e) => console.warn("[invite] email failed:", e));
    return { ok: true };
  });

  async function sendInvite(email: string, name: string, inviter: string, role: Role) {
    const org = await getSetting("org");
    await sendSystemEmail(
      email,
      `${inviter} invited you to ${org.orgName}'s hiring workspace`,
      `Hi ${name.split(" ")[0]},\n\n${inviter} added you to ${org.orgName}'s hiring workspace as ${ROLE_LABEL[role]}.\n\nSign in with your Google account (${email}):\n${config.appUrl}/login`,
    );
  }

  app.post("/api/users/:id/resend-invite", async (req) => {
    const actor = requirePerm(req, "users.manage");
    const u = await one<UserRow>("select * from users where id = $1", [(req.params as { id: string }).id]);
    if (!u || u.status !== "invited") throw new HttpError(404, "No pending invite");
    if (!canManageRole(actor.role, u.role)) throw new HttpError(403, "Not allowed");
    await sendInvite(u.email, u.name, actor.name, u.role);
    return { ok: true };
  });

  app.patch("/api/users/:id", async (req) => {
    const actor = requirePerm(req, "users.manage");
    const { id } = req.params as { id: string };
    const body = z.object({ role: RoleEnum, status: z.enum(["active", "deactivated"]), title: z.string().max(120), name: z.string().trim().min(1).max(120) }).partial().parse(req.body);
    const target = isUuid(id) ? await one<UserRow>("select * from users where id = $1", [id]) : undefined;
    if (!target) throw new HttpError(404, "Not found");
    if (target.id === actor.id && (body.role || body.status)) throw new HttpError(400, "You can't change your own role or status");
    if (!canManageRole(actor.role, target.role) || (body.role && !canManageRole(actor.role, body.role))) throw new HttpError(403, "Not allowed");
    if (target.role === "super_admin" && (body.role && body.role !== "super_admin" || body.status === "deactivated")) {
      const supers = await one<{ n: number }>("select count(*)::int as n from users where role = 'super_admin' and status = 'active'");
      if ((supers?.n ?? 0) <= 1) throw new HttpError(400, "There must always be at least one Super Admin");
    }
    if (target.email === config.superAdminEmail && (body.role && body.role !== "super_admin" || body.status === "deactivated")) {
      throw new HttpError(400, "This is the account set in SUPER_ADMIN_EMAIL — change that setting first");
    }
    await q(
      "update users set role = coalesce($2, role), status = coalesce($3, status), title = coalesce($4, title), name = coalesce($5, name) where id = $1",
      [id, body.role ?? null, body.status === "active" && target.status === "invited" ? "invited" : (body.status ?? null), body.title ?? null, body.name ?? null],
    );
    if (body.status === "deactivated") await q("delete from sessions where user_id = $1", [id]);
    if (body.role && body.role !== target.role) await logActivity(actor.id, "role_changed", `changed ${target.name}'s role to ${ROLE_LABEL[body.role]}`);
    if (body.status && body.status !== target.status) await logActivity(actor.id, "settings_changed", `${body.status === "deactivated" ? "deactivated" : "reactivated"} ${target.name}`);
    return { ok: true };
  });

  // ---------- booking links ----------

  app.put("/api/booking-links/:id", async (req) => {
    requirePerm(req, "interviews.manageBookingLinks");
    const { id } = req.params as { id: string };
    const b = z
      .object({
        slug: z.string().regex(/^[a-z0-9-]{2,60}$/),
        title: z.string().trim().min(1).max(120),
        durationMin: z.number().int().min(5).max(240),
        type: z.enum(["phone", "video", "onsite"]),
        hostIds: z.array(z.string().uuid()).max(20),
        days: z.array(z.number().int().min(0).max(6)),
        startHour: z.number().int().min(0).max(23),
        endHour: z.number().int().min(1).max(24),
        bufferMin: z.number().int().min(0).max(120),
        active: z.boolean(),
      })
      .parse(req.body);
    if (b.endHour <= b.startHour) throw new HttpError(400, "End time must be after start time");
    const clash = await one("select 1 from booking_links where slug = $1 and id::text <> $2", [b.slug, id]);
    if (clash) throw new HttpError(409, "That URL is already used by another link");
    const exists = isUuid(id) && (await one("select 1 from booking_links where id = $1", [id]));
    const params = [b.slug, b.title, b.durationMin, b.type, b.hostIds, b.days, b.startHour, b.endHour, b.bufferMin, b.active];
    if (exists) {
      await q("update booking_links set slug=$2, title=$3, duration_min=$4, type=$5, host_ids=$6, days=$7, start_hour=$8, end_hour=$9, buffer_min=$10, active=$11 where id=$1", [id, ...params]);
      return { id };
    }
    const row = await one<{ id: string }>(
      "insert into booking_links (slug, title, duration_min, type, host_ids, days, start_hour, end_hour, buffer_min, active) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id",
      params,
    );
    return { id: row!.id };
  });

  app.delete("/api/booking-links/:id", async (req) => {
    requirePerm(req, "interviews.manageBookingLinks");
    await q("delete from booking_links where id::text = $1", [(req.params as { id: string }).id]);
    return { ok: true };
  });

  // ---------- settings ----------

  app.patch("/api/settings", async (req) => {
    const user = requirePerm(req, "settings.integrations");
    const body = z
      .object({
        orgName: z.string().trim().min(1).max(120),
        emailDomain: z.string().trim().toLowerCase().max(120),
        senderName: z.string().trim().min(1).max(120),
        senderAddress: z.string().trim().toLowerCase().email(),
        replyTo: z.string().trim().toLowerCase().email().or(z.literal("")),
        emailSignature: z.string().max(1000),
        aiSummariesEnabled: z.boolean(),
        google: z.object({ driveRootFolder: z.string().trim().min(1).max(200), driveSyncEnabled: z.boolean(), calendarId: z.string().trim().min(1).max(200), autoMeetLinks: z.boolean() }).partial(),
      })
      .partial()
      .parse(req.body);
    const { google, ...org } = body;
    if (Object.keys(org).length) await patchSetting("org", org);
    if (google) {
      const current = await getSetting("google");
      const folderChanged = google.driveRootFolder && google.driveRootFolder !== current.driveRootFolder;
      await patchSetting("google", { ...google, ...(folderChanged ? { driveRootFolderId: undefined } : {}) });
      if (folderChanged) await q("update jobs set drive_folder_id = null");
    }
    await logActivity(user.id, "settings_changed", `updated ${Object.keys(body).join(", ")} settings`);
    return { ok: true };
  });

  app.put("/api/settings/stages", async (req) => {
    const user = requirePerm(req, "settings.pipeline");
    const stages = z
      .array(z.object({ id: z.string().regex(/^[\w-]{1,64}$/), name: z.string().trim().min(1).max(60), color: z.string().regex(/^#[0-9a-f]{6}$/i), kind: z.enum(["active", "hired", "closed"]), autoEmailTemplateId: z.string().optional() }))
      .min(2)
      .parse(req.body);
    if (!stages.some((s) => s.kind === "active")) throw new HttpError(400, "Keep at least one in-progress stage");
    await tx(async (c) => {
      const keep = stages.map((s) => s.id);
      const used = await c.query("select distinct stage_id from candidates where not (stage_id = any($1::text[]))", [keep]);
      if (used.rowCount) throw new HttpError(400, "Move candidates out of a stage before deleting it");
      await c.query("delete from stages where not (id = any($1::text[]))", [keep]);
      for (const [i, s] of stages.entries()) {
        await c.query(
          `insert into stages (id, name, color, kind, position, auto_email_template_id) values ($1,$2,$3,$4,$5,$6)
           on conflict (id) do update set name=excluded.name, color=excluded.color, kind=excluded.kind, position=excluded.position, auto_email_template_id=excluded.auto_email_template_id`,
          [s.id, s.name, s.color, s.kind, i, s.autoEmailTemplateId || null],
        );
      }
    });
    await logActivity(user.id, "settings_changed", "updated pipeline stages");
    return { ok: true };
  });

  /** Registers the domain with Amazon SES (first time) and reports the DNS records to add + their status. */
  app.post("/api/settings/email/verify", async (req) => {
    requirePerm(req, "settings.email");
    const org = await getSetting("org");
    const domain = org.emailDomain || org.senderAddress.split("@")[1] || "";
    if (!domain) throw new HttpError(400, "Set the email domain first");
    const records: DnsRecord[] = [];
    if (config.email.transport === "ses") {
      const client = new SESv2Client({ region: config.email.awsRegion });
      let identity;
      try {
        identity = await client.send(new GetEmailIdentityCommand({ EmailIdentity: domain }));
      } catch (e) {
        if (!(e instanceof NotFoundException)) throw new HttpError(502, `Amazon SES: ${e instanceof Error ? e.message : e}`);
        await client.send(new CreateEmailIdentityCommand({ EmailIdentity: domain }));
        identity = await client.send(new GetEmailIdentityCommand({ EmailIdentity: domain }));
      }
      const ok = identity.DkimAttributes?.Status === "SUCCESS";
      for (const token of identity.DkimAttributes?.Tokens ?? []) {
        records.push({ type: "DKIM", host: `${token}._domainkey.${domain}`, value: `${token}.dkim.amazonses.com`, verified: ok });
      }
    }
    const dmarc = await dns.resolveTxt(`_dmarc.${domain}`).then((r) => r.map((x) => x.join("")).find((t) => t.startsWith("v=DMARC1"))).catch(() => undefined);
    records.push({ type: "DMARC", host: `_dmarc.${domain}`, value: dmarc ?? `v=DMARC1; p=none; rua=mailto:dmarc@${domain}`, verified: !!dmarc });
    await setSetting("dns", records);
    return { records };
  });

  app.post("/api/settings/email/test", async (req) => {
    const user = requirePerm(req, "settings.email");
    await sendSystemEmail(user.email, "Test email from your hiring workspace", `Hi ${user.name.split(" ")[0]},\n\nIf you're reading this, candidate emails are set up correctly.`);
    return { ok: true, transport: config.email.transport };
  });
}
