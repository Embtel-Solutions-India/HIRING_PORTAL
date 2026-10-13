import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { PrismaPg } from "@prisma/adapter-pg";
import { config } from "./config.ts";
import { PrismaClient } from "./generated/prisma/client.ts";

export { Prisma } from "./generated/prisma/client.ts";

// DATABASE_URL may point at a transaction-mode pooler (e.g. Supabase :6543); node-postgres works there as-is.
export const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: config.databaseUrl, max: 10 }) });

/** Applies pending migrations in prisma/migrations (via DIRECT_URL, see prisma.config.ts). */
export async function migrate() {
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
