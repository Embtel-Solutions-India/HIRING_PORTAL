import dns from "node:dns/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { canManageRole, ROLE_LABEL } from "../../../frontend/src/lib/permissions.ts";
import type { Role } from "../../../frontend/src/types.ts";
import { logActivity } from "../activity.ts";
import { config } from "../config.ts";
import { prisma } from "../db.ts";
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
    const data = { name: t.name, subject: t.subject, body: t.body, category: t.category, updated_at: new Date() };
    await prisma.email_templates.upsert({ where: { id }, create: { id, ...data }, update: data });
    return { ok: true };
  });

  app.delete("/api/email-templates/:id", async (req) => {
    requirePerm(req, "emails.manageTemplates");
    await prisma.email_templates.deleteMany({ where: { id: (req.params as { id: string }).id } });
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
    const existing = isUuid(id) ? await prisma.jobs.findUnique({ where: { id }, select: { title: true } }) : null;
    let jobId = id;
    const data = { title: j.title, department: j.department, location: j.location, type: j.type, status: j.status, hiring_manager_id: j.hiringManagerId || null, openings: j.openings };
    if (existing) {
      await prisma.jobs.updateMany({ where: { id }, data: { ...data, description: j.description } });
    } else {
      const row = await prisma.jobs.create({ data: { ...data, description: j.description ?? "" }, select: { id: true } });
      jobId = row.id;
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
    const existing = await prisma.users.findUnique({ where: { email: body.email } });
    if (existing && existing.status !== "deactivated") throw new HttpError(409, "That person is already on the team");
    const count = await prisma.users.count();
    if (existing) {
      await prisma.users.updateMany({ where: { id: existing.id }, data: { name: body.name, title: body.title, role: body.role, status: "invited" } });
    } else {
      await prisma.users.create({
        data: { email: body.email, name: body.name, title: body.title, role: body.role, status: "invited", avatar_color: AVATAR_COLORS[count % AVATAR_COLORS.length]! },
      });
    }
    await logActivity(actor.id, "user_invited", `invited ${body.email} as ${ROLE_LABEL[body.role]}`);
    // The invite is saved either way; report a failed email so the admin can fix settings and use "Resend invite".
    try {
      await sendInvite(body.email, body.name, actor.name, body.role);
    } catch (e) {
      console.warn("[invite] email failed:", e);
      return { ok: true, emailError: e instanceof Error ? e.message : String(e) };
    }
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
    const { id } = req.params as { id: string };
    const u = isUuid(id) ? ((await prisma.users.findUnique({ where: { id } })) as UserRow | null) : null;
    if (!u || u.status !== "invited") throw new HttpError(404, "No pending invite");
    if (!canManageRole(actor.role, u.role)) throw new HttpError(403, "Not allowed");
    await sendInvite(u.email, u.name, actor.name, u.role);
    return { ok: true };
  });

  app.patch("/api/users/:id", async (req) => {
    const actor = requirePerm(req, "users.manage");
    const { id } = req.params as { id: string };
    const body = z.object({ role: RoleEnum, status: z.enum(["active", "deactivated"]), title: z.string().max(120), name: z.string().trim().min(1).max(120) }).partial().parse(req.body);
    const target = isUuid(id) ? ((await prisma.users.findUnique({ where: { id } })) as UserRow | null) : null;
    if (!target) throw new HttpError(404, "Not found");
    if (target.id === actor.id && (body.role || body.status)) throw new HttpError(400, "You can't change your own role or status");
    if (!canManageRole(actor.role, target.role) || (body.role && !canManageRole(actor.role, body.role))) throw new HttpError(403, "Not allowed");
    if (target.role === "super_admin" && (body.role && body.role !== "super_admin" || body.status === "deactivated")) {
      const supers = await prisma.users.count({ where: { role: "super_admin", status: "active" } });
      if (supers <= 1) throw new HttpError(400, "There must always be at least one Super Admin");
    }
    if (target.email === config.superAdminEmail && (body.role && body.role !== "super_admin" || body.status === "deactivated")) {
      throw new HttpError(400, "This is the account set in SUPER_ADMIN_EMAIL — change that setting first");
    }
    await prisma.users.updateMany({
      where: { id },
      data: { role: body.role, status: body.status === "active" && target.status === "invited" ? "invited" : body.status, title: body.title, name: body.name },
    });
    if (body.status === "deactivated") await prisma.sessions.deleteMany({ where: { user_id: id } });
    if (body.role && body.role !== target.role) await logActivity(actor.id, "role_changed", `changed ${target.name}'s role to ${ROLE_LABEL[body.role]}`);
    if (body.status && body.status !== target.status) await logActivity(actor.id, "settings_changed", `${body.status === "deactivated" ? "deactivated" : "reactivated"} ${target.name}`);
    return { ok: true };
  });

  // Their notes, feedback, jobs and campaigns stay; the user FKs are ON DELETE SET NULL, sessions cascade.
  app.delete("/api/users/:id", async (req) => {
    const actor = requirePerm(req, "users.delete");
    const { id } = req.params as { id: string };
    const target = isUuid(id) ? ((await prisma.users.findUnique({ where: { id } })) as UserRow | null) : null;
    if (!target) throw new HttpError(404, "Not found");
    if (target.id === actor.id) throw new HttpError(400, "You can't delete your own account");
    if (target.email === config.superAdminEmail) throw new HttpError(400, "This is the account set in SUPER_ADMIN_EMAIL — change that setting first");
    // Don't leave upcoming interviews or booking links with nobody on them.
    const [soloInterviews, soloLinks] = await Promise.all([
      prisma.interviews.count({ where: { status: "scheduled", start_at: { gt: new Date() }, interviewer_ids: { equals: [id] } } }),
      prisma.booking_links.findMany({ where: { host_ids: { equals: [id] } }, select: { title: true } }),
    ]);
    const blockers = [
      soloInterviews && `${soloInterviews} upcoming interview${soloInterviews === 1 ? "" : "s"}`,
      soloLinks.length && `booking link${soloLinks.length === 1 ? "" : "s"} ${soloLinks.map((l) => `“${l.title}”`).join(", ")}`,
    ].filter(Boolean);
    if (blockers.length) throw new HttpError(409, `${target.name} is the only person on ${blockers.join(" and ")} — reassign first`);
    await prisma.$transaction(async (tx) => {
      // Lock the active Super Admins so two admins deleting each other can't both pass the check.
      const supers = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM users WHERE role = 'super_admin' AND status = 'active' FOR UPDATE`;
      if (supers.some((s) => s.id === id) && supers.length <= 1) throw new HttpError(400, "There must always be at least one Super Admin");
      await tx.$executeRaw`UPDATE booking_links SET host_ids = array_remove(host_ids, ${id}::uuid) WHERE ${id}::uuid = ANY(host_ids)`;
      await tx.$executeRaw`UPDATE interviews SET interviewer_ids = array_remove(interviewer_ids, ${id}::uuid) WHERE ${id}::uuid = ANY(interviewer_ids)`;
      await tx.users.delete({ where: { id } });
    });
    await logActivity(actor.id, "user_deleted", `deleted ${target.name} (${target.email})`);
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
    const clash = await prisma.booking_links.findFirst({ where: { slug: b.slug, ...(isUuid(id) ? { NOT: { id } } : {}) }, select: { id: true } });
    if (clash) throw new HttpError(409, "That URL is already used by another link");
    const exists = isUuid(id) && (await prisma.booking_links.findUnique({ where: { id }, select: { id: true } }));
    const data = {
      slug: b.slug,
      title: b.title,
      duration_min: b.durationMin,
      type: b.type,
      host_ids: b.hostIds,
      days: b.days,
      start_hour: b.startHour,
      end_hour: b.endHour,
      buffer_min: b.bufferMin,
      active: b.active,
    };
    if (exists) {
      await prisma.booking_links.updateMany({ where: { id }, data });
      return { id };
    }
    const row = await prisma.booking_links.create({ data, select: { id: true } });
    return { id: row.id };
  });

  app.delete("/api/booking-links/:id", async (req) => {
    requirePerm(req, "interviews.manageBookingLinks");
    const { id } = req.params as { id: string };
    if (isUuid(id)) await prisma.booking_links.deleteMany({ where: { id } });
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
      if (folderChanged) await prisma.jobs.updateMany({ data: { drive_folder_id: null } });
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
    await prisma.$transaction(
      async (tx) => {
        const keep = stages.map((s) => s.id);
        const used = await tx.candidates.findFirst({ where: { stage_id: { notIn: keep } }, select: { id: true } });
        if (used) throw new HttpError(400, "Move candidates out of a stage before deleting it");
        await tx.stages.deleteMany({ where: { id: { notIn: keep } } });
        for (const [i, s] of stages.entries()) {
          const data = { name: s.name, color: s.color, kind: s.kind, position: i, auto_email_template_id: s.autoEmailTemplateId || null };
          await tx.stages.upsert({ where: { id: s.id }, create: { id: s.id, ...data }, update: data });
        }
      },
      { timeout: 30_000 }, // one round trip per stage; the 5s default is tight over a remote pooler
    );
    await logActivity(user.id, "settings_changed", "updated pipeline stages");
    return { ok: true };
  });

  /** Checks the domain's SPF and DMARC records. DKIM keys come from the SMTP provider's own dashboard. */
  app.post("/api/settings/email/verify", async (req) => {
    requirePerm(req, "settings.email");
    const org = await getSetting("org");
    const domain = org.emailDomain || org.senderAddress.split("@")[1] || "";
    if (!domain) throw new HttpError(400, "Set the email domain first");
    const txt = (host: string, prefix: string) => dns.resolveTxt(host).then((r) => r.map((x) => x.join("")).find((t) => t.startsWith(prefix))).catch(() => undefined);
    const spf = await txt(domain, "v=spf1");
    const dmarc = await txt(`_dmarc.${domain}`, "v=DMARC1");
    const records: DnsRecord[] = [
      { type: "SPF", host: domain, value: spf ?? "v=spf1 include:<your SMTP provider> ~all", verified: !!spf },
      { type: "DMARC", host: `_dmarc.${domain}`, value: dmarc ?? `v=DMARC1; p=none; rua=mailto:dmarc@${domain}`, verified: !!dmarc },
    ];
    await setSetting("dns", records);
    return { records };
  });

  app.post("/api/settings/email/test", async (req) => {
    const user = requirePerm(req, "settings.email");
    await sendSystemEmail(user.email, "Test email from your hiring workspace", `Hi ${user.name.split(" ")[0]},\n\nIf you're reading this, candidate emails are set up correctly.`);
    return { ok: true, transport: config.email.transport };
  });
}
