/** The editable list of recruiting sources, and tagging candidates with one. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { logActivity } from "../activity.ts";
import { one, q, tx } from "../db.ts";
import { HttpError, requirePerm } from "../http.ts";

const Color = z.string().regex(/^#[0-9a-f]{6}$/i);
const Name = z.string().trim().min(1).max(40);

const slug = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .slice(0, 40) || "source";

export default async function sourceRoutes(app: FastifyInstance) {
  app.post("/api/sources", async (req) => {
    const user = requirePerm(req, "sources.manage");
    const body = z.object({ name: Name, color: Color }).parse(req.body);
    if (await one("select 1 from sources where lower(name) = lower($1)", [body.name])) throw new HttpError(409, `“${body.name}” already exists`);
    let id = slug(body.name);
    for (let n = 2; await one("select 1 from sources where id = $1", [id]); n++) id = `${slug(body.name)}-${n}`;
    const pos = await one<{ p: number }>("select coalesce(max(position), -1) + 1 as p from sources");
    await q("insert into sources (id, name, color, position) values ($1, $2, $3, $4)", [id, body.name, body.color, pos?.p ?? 0]);
    await logActivity(user.id, "settings_changed", `added source ${body.name}`);
    return { id, name: body.name, color: body.color, active: true };
  });

  app.patch("/api/sources/:id", async (req) => {
    const user = requirePerm(req, "sources.manage");
    const { id } = req.params as { id: string };
    const body = z.object({ name: Name, color: Color, active: z.boolean() }).partial().parse(req.body);
    const current = await one<{ name: string }>("select name from sources where id = $1", [id]);
    if (!current) throw new HttpError(404, "Source not found");
    if (body.name && (await one("select 1 from sources where lower(name) = lower($1) and id <> $2", [body.name, id]))) throw new HttpError(409, `“${body.name}” already exists`);
    await q("update sources set name = coalesce($2, name), color = coalesce($3, color), active = coalesce($4, active) where id = $1", [id, body.name ?? null, body.color ?? null, body.active ?? null]);
    if (body.name && body.name !== current.name) await logActivity(user.id, "settings_changed", `renamed source ${current.name} to ${body.name}`);
    return { ok: true };
  });

  app.delete("/api/sources/:id", async (req) => {
    const user = requirePerm(req, "sources.manage");
    const { id } = req.params as { id: string };
    const used = await one<{ n: number }>("select count(*)::int as n from candidates where source_id = $1", [id]);
    if (used?.n) throw new HttpError(409, `${used.n} candidate${used.n === 1 ? " is" : "s are"} tagged with this source — hide it instead, or re-tag them first`);
    const row = await one<{ name: string }>("delete from sources where id = $1 returning name", [id]);
    if (row) await logActivity(user.id, "settings_changed", `deleted source ${row.name}`);
    return { ok: true };
  });

  app.put("/api/sources/order", async (req) => {
    requirePerm(req, "sources.manage");
    const ids = z.array(z.string()).max(200).parse(req.body);
    await tx(async (c) => {
      for (const [i, id] of ids.entries()) await c.query("update sources set position = $2 where id = $1", [id, i]);
    });
    return { ok: true };
  });

  /** Tag one or many candidates with a source (null clears it). */
  app.post("/api/candidates/source", async (req) => {
    const user = requirePerm(req, "candidates.tagSource");
    const body = z.object({ ids: z.array(z.string().uuid()).min(1).max(1000), sourceId: z.string().max(64).nullable() }).parse(req.body);
    const src = body.sourceId ? await one<{ id: string; name: string }>("select id, name from sources where id = $1", [body.sourceId]) : null;
    if (body.sourceId && !src) throw new HttpError(400, "Unknown source");
    const rows = await q<{ id: string; first_name: string; last_name: string }>(
      "update candidates set source_id = $2 where id = any($1::uuid[]) and source_id is distinct from $2 returning id, first_name, last_name",
      [body.ids, src?.id ?? null],
    );
    if (rows.length === 1) {
      const c = rows[0]!;
      await logActivity(user.id, "source_changed", src ? `tagged ${c.first_name} ${c.last_name} as ${src.name}` : `cleared the source on ${c.first_name} ${c.last_name}`, c.id);
    } else if (rows.length > 1) {
      await logActivity(user.id, "source_changed", src ? `tagged ${rows.length} candidates as ${src.name}` : `cleared the source on ${rows.length} candidates`);
    }
    return { updated: rows.length };
  });
}
