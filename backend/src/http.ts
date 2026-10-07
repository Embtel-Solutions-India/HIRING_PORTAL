import type { FastifyReply, FastifyRequest } from "fastify";
import type { Role } from "../../frontend/src/types.ts";
import { can, type Permission } from "../../frontend/src/lib/permissions.ts";
import { config } from "./config.ts";
import { one, q } from "./db.ts";
import { randomToken, sha256 } from "./crypto.ts";

export interface UserRow {
  id: string;
  email: string;
  name: string;
  title: string;
  role: Role;
  status: "active" | "invited" | "deactivated";
  avatar_color: string;
  last_active_at: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: UserRow;
  }
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const SESSION_COOKIE = "hirely_sid";
const SESSION_DAYS = 30;

export async function createSession(reply: FastifyReply, userId: string) {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await q("insert into sessions (id, user_id, expires_at) values ($1, $2, $3)", [sha256(token), userId, expires]);
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: config.secureCookies,
    expires,
  });
}

export async function destroySession(req: FastifyRequest, reply: FastifyReply) {
  const token = req.cookies[SESSION_COOKIE];
  if (token) await q("delete from sessions where id = $1", [sha256(token)]);
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

/** Loads the signed-in user (if any) onto req.user. */
export async function loadUser(req: FastifyRequest) {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return;
  const user = await one<UserRow>(
    `select u.* from sessions s join users u on u.id = s.user_id
     where s.id = $1 and s.expires_at > now() and u.status = 'active'`,
    [sha256(token)],
  );
  if (!user) return;
  req.user = user;
  // Cheap "last active" tracking: at most once every 5 minutes.
  if (!user.last_active_at || Date.now() - new Date(user.last_active_at).getTime() > 300_000) {
    q("update users set last_active_at = now() where id = $1", [user.id]).catch(() => {});
  }
}

export function requireUser(req: FastifyRequest): UserRow {
  if (!req.user) throw new HttpError(401, "Please sign in");
  return req.user;
}

export function requirePerm(req: FastifyRequest, permission: Permission): UserRow {
  const user = requireUser(req);
  if (!can(user.role, permission)) throw new HttpError(403, "Your role doesn't allow this");
  return user;
}

/** Interviewers only see candidates they're scheduled to interview. */
export async function assertCandidateAccess(user: UserRow, candidateId: string) {
  if (can(user.role, "candidates.viewAll")) {
    const exists = await one("select 1 from candidates where id = $1", [candidateId]);
    if (!exists) throw new HttpError(404, "Candidate not found");
    return;
  }
  const ok = await one("select 1 from interviews where candidate_id = $1 and $2 = any(interviewer_ids) limit 1", [candidateId, user.id]);
  if (!ok) throw new HttpError(404, "Candidate not found");
}

export const isUuid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f-]{36}$/i.test(s);
