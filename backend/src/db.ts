import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "./config.ts";

// Return timestamps as ISO strings (what the frontend expects) instead of Date objects.
pg.types.setTypeParser(1184, (v) => new Date(v).toISOString()); // timestamptz
pg.types.setTypeParser(20, (v) => Number(v)); // int8 (count(*))

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}

export async function one<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await q<T>(text, params);
  return rows[0];
}

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/** Applies every .sql file in src/migrations once, in filename order. */
export async function migrate() {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
  await pool.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
  const done = new Set((await q<{ name: string }>("select name from schema_migrations")).map((r) => r.name));
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await fs.readFile(path.join(dir, file), "utf8");
    await tx(async (c) => {
      await c.query(sql);
      await c.query("insert into schema_migrations (name) values ($1)", [file]);
    });
    console.log(`[db] applied migration ${file}`);
  }
}
