import type { FastifyReply, FastifyRequest } from "fastify";
import type { Role } from "../../frontend/src/types.ts";
import { can, type Permission } from "../../frontend/src/lib/permissions.ts";
import { config } from "./config.ts";
import { prisma } from "./db.ts";
import { randomToken, sha256 } from "./crypto.ts";

export interface UserRow {
  id: string;
  email: string;
  name: string;
  title: string;
  role: Role;
  status: "active" | "invited" | "deactivated";
  avatar_color: string;
  last_active_at: Date | null;
  created_at: Date;
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
  await prisma.sessions.create({ data: { id: sha256(token), user_id: userId, expires_at: expires } });
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
  if (token) await prisma.sessions.deleteMany({ where: { id: sha256(token) } });
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

/** Loads the signed-in user (if any) onto req.user. */
export async function loadUser(req: FastifyRequest) {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return;
  const session = await prisma.sessions.findFirst({
    where: { id: sha256(token), expires_at: { gt: new Date() }, users: { status: "active" } },
    select: { users: true },
  });
  if (!session) return;
  const user = session.users as UserRow;
  req.user = user;
  // Cheap "last active" tracking: at most once every 5 minutes.
  if (!user.last_active_at || Date.now() - new Date(user.last_active_at).getTime() > 300_000) {
    prisma.users.updateMany({ where: { id: user.id }, data: { last_active_at: new Date() } }).catch(() => {});
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
    const exists = await prisma.candidates.findUnique({ where: { id: candidateId }, select: { id: true } });
    if (!exists) throw new HttpError(404, "Candidate not found");
    return;
  }
  const ok = await prisma.interviews.findFirst({ where: { candidate_id: candidateId, interviewer_ids: { has: user.id } }, select: { id: true } });
  if (!ok) throw new HttpError(404, "Candidate not found");
}

export const isUuid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
