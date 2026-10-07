import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { logActivity } from "../activity.ts";
import { config } from "../config.ts";
import { decrypt, encrypt, randomToken } from "../crypto.ts";
import { one, q } from "../db.ts";
import * as google from "../google.ts";
import { createSession, destroySession, HttpError, requirePerm, type UserRow } from "../http.ts";
import * as s from "../serialize.ts";
import { getSetting, patchSetting } from "../settings.ts";

const STATE_COOKIE = "hirely_oauth";
const AVATAR_COLORS = ["#1d5a3a", "#1e40af", "#9a3412", "#6d28d9", "#0f766e", "#be185d", "#4d7c0f", "#a16207"];

function setState(reply: FastifyReply, payload: object) {
  const state = randomToken(16);
  reply.setCookie(STATE_COOKIE, JSON.stringify({ state, ...payload }), {
    path: "/api",
    httpOnly: true,
    sameSite: "lax",
    secure: config.secureCookies,
    maxAge: 600,
  });
  return state;
}

function readState(req: FastifyRequest, reply: FastifyReply, state: string) {
  const raw = req.cookies[STATE_COOKIE];
  reply.clearCookie(STATE_COOKIE, { path: "/api" });
  if (!raw) throw new HttpError(400, "Sign-in expired. Please try again.");
  const parsed = JSON.parse(raw) as { state: string; returnTo?: string };
  if (parsed.state !== state) throw new HttpError(400, "Sign-in state mismatch. Please try again.");
  return parsed;
}

const safeReturn = (p: unknown) => (typeof p === "string" && p.startsWith("/") && !p.startsWith("//") ? p : "/");

/** Signs a person in by email if they're invited (or are the configured Super Admin). */
async function signIn(email: string, displayName: string): Promise<UserRow | "not_invited" | "deactivated" | "wrong_domain"> {
  email = email.toLowerCase();
  if (config.allowedEmailDomain && !email.endsWith(`@${config.allowedEmailDomain}`) && email !== config.superAdminEmail) return "wrong_domain";
  let user = await one<UserRow>("select * from users where email = $1", [email]);
  if (!user && email === config.superAdminEmail) {
    const count = await one<{ n: number }>("select count(*)::int as n from users");
    user = await one<UserRow>(
      "insert into users (email, name, title, role, status, avatar_color) values ($1, $2, $3, 'super_admin', 'active', $4) returning *",
      [email, displayName || email.split("@")[0], "Super Admin", AVATAR_COLORS[0]],
    );
    if (count?.n === 0) {
      // First run: a default booking link hosted by the Super Admin so {{booking_link}} works right away.
      await q(
        "insert into booking_links (slug, title, duration_min, type, host_ids) values ('intro-call', '30-min intro call', 30, 'video', $1) on conflict do nothing",
        [[user!.id]],
      );
    }
  }
  if (!user) return "not_invited";
  if (user.status === "deactivated") return "deactivated";
  // The configured Super Admin can always get back in, even if someone changed their role.
  const role = email === config.superAdminEmail ? "super_admin" : user.role;
  const name = user.status === "invited" && displayName ? displayName : user.name;
  return (await one<UserRow>("update users set status = 'active', role = $2, name = $3, last_active_at = now() where id = $1 returning *", [user.id, role, name]))!;
}

export default async function authRoutes(app: FastifyInstance) {
  app.get("/api/auth/config", async () => {
    const org = await getSetting("org");
    return {
      googleConfigured: !!(config.google.clientId && config.google.clientSecret),
      devLogin: config.devLogin,
      orgName: org.orgName,
      emailDomain: config.allowedEmailDomain || org.emailDomain,
    };
  });

  app.get("/api/auth/me", async (req) => {
    if (!req.user) throw new HttpError(401, "Not signed in");
    return { user: s.user(req.user) };
  });

  app.get("/api/auth/google", async (req, reply) => {
    if (!config.google.clientId) throw new HttpError(500, "Google sign-in isn't configured (GOOGLE_CLIENT_ID).");
    const { returnTo } = req.query as { returnTo?: string };
    const state = setState(reply, { returnTo: safeReturn(returnTo) });
    return reply.redirect(google.authUrl({ scopes: google.LOGIN_SCOPES, redirectUri: google.loginRedirectUri(), state, hd: config.allowedEmailDomain || undefined }));
  });

  app.get("/api/auth/google/callback", async (req, reply) => {
    const { code, state, error } = req.query as { code?: string; state?: string; error?: string };
    if (error || !code || !state) return reply.redirect(`/login?error=${encodeURIComponent(error ?? "cancelled")}`);
    const { returnTo } = readState(req, reply, state);
    const token = await google.exchangeCode(code, google.loginRedirectUri());
    const info = await google.userInfo(token.access_token);
    if (!info.email_verified) return reply.redirect("/login?error=unverified");
    const result = await signIn(info.email, info.name ?? "");
    if (typeof result === "string") return reply.redirect(`/login?error=${result}&email=${encodeURIComponent(info.email)}`);
    await createSession(reply, result.id);
    return reply.redirect(safeReturn(returnTo));
  });

  app.post("/api/auth/dev-login", async (req, reply) => {
    if (!config.devLogin) throw new HttpError(404, "Not found");
    const { email } = req.body as { email?: string };
    if (!email) throw new HttpError(400, "Email required");
    const result = await signIn(email, "");
    if (typeof result === "string") throw new HttpError(403, result === "not_invited" ? "That email hasn't been invited" : result);
    await createSession(reply, result.id);
    return { user: s.user(result) };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    await destroySession(req, reply);
    return { ok: true };
  });

  // ---------- Google Workspace connection (Drive + Calendar), Super Admin only ----------

  app.get("/api/integrations/google/start", async (req, reply) => {
    const user = requirePerm(req, "settings.integrations");
    const state = setState(reply, { returnTo: "/settings" });
    return reply.redirect(
      google.authUrl({ scopes: google.INTEGRATION_SCOPES, redirectUri: google.integrationRedirectUri(), state, offline: true, loginHint: user.email }),
    );
  });

  app.get("/api/integrations/google/callback", async (req, reply) => {
    const user = requirePerm(req, "settings.integrations");
    const { code, state, error } = req.query as { code?: string; state?: string; error?: string };
    if (error || !code || !state) return reply.redirect(`/settings?google=${encodeURIComponent(error ?? "cancelled")}`);
    readState(req, reply, state);
    const token = await google.exchangeCode(code, google.integrationRedirectUri());
    if (!token.refresh_token) return reply.redirect("/settings?google=no_refresh_token");
    const missing = google.INTEGRATION_SCOPES.filter((sc) => sc.startsWith("https://") && !(token.scope ?? "").includes(sc));
    if (missing.length) return reply.redirect("/settings?google=missing_scopes");
    const info = await google.userInfo(token.access_token);
    google.clearTokenCache();
    await patchSetting("google", { connected: true, account: info.email, refreshTokenEnc: encrypt(token.refresh_token), scopes: token.scope, driveRootFolderId: undefined });
    // Folder ids belong to the previously connected account; they're recreated on demand.
    await q("update jobs set drive_folder_id = null");
    try {
      await google.ensureRootFolder();
    } catch (e) {
      console.error("[google] couldn't create root folder:", e);
    }
    await logActivity(user.id, "settings_changed", `connected Google Workspace (${info.email})`);
    return reply.redirect("/settings?google=connected");
  });

  app.post("/api/integrations/google/disconnect", async (req) => {
    const user = requirePerm(req, "settings.integrations");
    const g = await getSetting("google");
    if (g.refreshTokenEnc) await google.revokeToken(decrypt(g.refreshTokenEnc));
    google.clearTokenCache();
    await patchSetting("google", { connected: false, account: "", refreshTokenEnc: undefined, driveRootFolderId: undefined });
    await logActivity(user.id, "settings_changed", "disconnected Google Workspace");
    return { ok: true };
  });
}
