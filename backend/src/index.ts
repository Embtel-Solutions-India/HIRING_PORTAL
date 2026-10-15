import fs from "node:fs";
import path from "node:path";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { ZodError } from "zod";
import { assertConfig, config } from "./config.ts";
import { migrate, prisma } from "./db.ts";
import { syncDrive } from "./drive.ts";
import { sendDueCampaigns } from "./email.ts";
import { HttpError, loadUser } from "./http.ts";
import { resumePendingParses } from "./pipeline.ts";
import adminRoutes from "./routes/admin.ts";
import authRoutes from "./routes/auth.ts";
import bootstrapRoutes from "./routes/bootstrap.ts";
import candidateRoutes from "./routes/candidates.ts";
import driveRoutes from "./routes/drive.ts";
import interviewRoutes from "./routes/interviews.ts";
import publicRoutes from "./routes/public.ts";
import sourceRoutes from "./routes/sources.ts";
import syncRoutes from "./routes/sync.ts";
import { syncTick } from "./sync-jobs.ts";

assertConfig();
await migrate();

const app = Fastify({
  trustProxy: true,
  bodyLimit: 2 * 1024 * 1024,
  disableRequestLogging: true,
  logger: { level: config.isProd ? "info" : "warn" },
});

await app.register(cookie);
await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 30 } });

app.addHook("onRequest", async (req) => {
  if (!req.url.startsWith("/api/")) return;
  // CSRF guard: browsers can't send custom headers cross-site without CORS, which we never allow.
  if (req.method !== "GET" && req.method !== "HEAD" && req.headers["x-hirely"] !== "1") throw new HttpError(403, "Missing request header");
  await loadUser(req);
});

app.setErrorHandler((err, req, reply) => {
  if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
  if (err instanceof ZodError) return reply.status(400).send({ error: "Invalid input", details: err.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`) });
  const status = (err as { statusCode?: number }).statusCode;
  if (status && status < 500) return reply.status(status).send({ error: (err as Error).message });
  req.log.error(err);
  return reply.status(500).send({ error: "Something went wrong on the server" });
});

app.get("/api/health", async () => {
  await prisma.$queryRaw`select 1`;
  return { ok: true };
});

await app.register(authRoutes);
await app.register(bootstrapRoutes);
await app.register(candidateRoutes);
await app.register(interviewRoutes);
await app.register(adminRoutes);
await app.register(driveRoutes);
await app.register(sourceRoutes);
await app.register(syncRoutes);
await app.register(publicRoutes);

// The built React app (frontend/dist), with client-side routing fallback to index.html.
const hasFrontend = fs.existsSync(path.join(config.frontendDist, "index.html"));
if (hasFrontend) {
  await app.register(fastifyStatic, { root: config.frontendDist, wildcard: false, index: false, maxAge: "1h" });
}
app.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith("/api/") || req.url.startsWith("/t/") || req.method !== "GET") return reply.status(404).send({ error: "Not found" });
  if (!hasFrontend) return reply.status(404).type("text/plain").send("Frontend not built. Run `npm run build` in /frontend, or use the Vite dev server.");
  reply.header("cache-control", "no-cache");
  return reply.sendFile("index.html");
});

// ---------- background work ----------

const every = (ms: number, label: string, fn: () => Promise<unknown>) =>
  setInterval(() => fn().catch((e) => console.error(`[${label}]`, e instanceof Error ? e.message : e)), ms);

every(60_000, "email", sendDueCampaigns);
every(config.driveSyncMinutes * 60_000, "drive", syncDrive);
every(30_000, "sync", syncTick);
every(3600_000, "sessions", () => prisma.sessions.deleteMany({ where: { expires_at: { lt: new Date() } } }));
resumePendingParses().catch((e) => console.error("[parse] resume failed", e));

await app.listen({ port: config.port, host: "0.0.0.0" });
console.log(`Hirely API listening on :${config.port} — ${config.appUrl}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  });
}
