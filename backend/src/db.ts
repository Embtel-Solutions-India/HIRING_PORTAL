import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { PrismaPg } from "@prisma/adapter-pg";
import { config } from "./config.ts";
import { PrismaClient } from "./generated/prisma/client.ts";

export { Prisma } from "./generated/prisma/client.ts";

// DATABASE_URL may point at a transaction-mode pooler (e.g. Supabase :6543); node-postgres works there as-is.
export const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: config.databaseUrl, max: 10 }) });

/**
 * A development server (npm run dev) must not change a hosted database such as production Supabase just because
 * backend/.env points at it. Local hosts and single-label hosts (a Docker service like "db") are fine.
 * Opt in with ALLOW_REMOTE_MIGRATIONS=true; production (NODE_ENV=production) always migrates.
 */
export function remoteMigrationBlocked({ isProd, url, allow }: { isProd: boolean; url: string; allow: boolean }) {
  if (isProd || allow) return false;
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return host.includes(".") && !/^127\.|^localhost$/.test(host);
}

/** Applies pending migrations in prisma/migrations (via DIRECT_URL, see prisma.config.ts). */
export async function migrate() {
  const target = process.env.DIRECT_URL || config.databaseUrl;
  if (remoteMigrationBlocked({ isProd: config.isProd, url: target, allow: process.env.ALLOW_REMOTE_MIGRATIONS === "true" })) {
    console.warn(
      `\n[db] Not applying migrations: this is a development server and the database is remote (${new URL(target).hostname}).\n` +
        "     Point DATABASE_URL/DIRECT_URL at a local database (npm run dev:db), or set ALLOW_REMOTE_MIGRATIONS=true if you really mean it.\n",
    );
    return;
  }
  // @prisma/adapter-pg reads timestamptz values as UTC no matter the session time zone, so a non-UTC server
  // would silently shift every date. Supabase and the postgres Docker image default to UTC.
  const [tz] = await prisma.$queryRaw<{ name: string; utc: boolean }[]>`select current_setting('TimeZone') as name, extract(timezone from now()) = 0 as utc`;
  if (!tz?.utc) throw new Error(`Postgres time zone is "${tz?.name}"; set it to UTC (e.g. ALTER DATABASE <db> SET timezone TO 'UTC')`);

  const prismaCli = (...args: string[]) =>
    execFileSync(process.execPath, [createRequire(import.meta.url).resolve("prisma/build/index.js"), ...args], { stdio: "inherit" });
  // Databases created by the old built-in runner: mark the migrations it already applied, once.
  const [state] = await prisma.$queryRaw<{ legacy: boolean; prisma: boolean }[]>`
    select to_regclass('public.schema_migrations') is not null as legacy, to_regclass('public._prisma_migrations') is not null as prisma`;
  if (state?.legacy && !state.prisma) {
    const done = await prisma.$queryRaw<{ name: string }[]>`select name from schema_migrations order by name`;
    for (const { name } of done) prismaCli("migrate", "resolve", "--applied", name.replace(/\.sql$/, ""));
  }
  prismaCli("migrate", "deploy");
}
