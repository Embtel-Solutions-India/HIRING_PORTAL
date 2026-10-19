/** The editable list of recruiting sources, and tagging candidates with one. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { logActivity, touchCandidate } from "../activity.ts";
import { prisma } from "../db.ts";
import { HttpError, requirePerm } from "../http.ts";

const Color = z.string().regex(/^#[0-9a-f]{6}$/i);
const Name = z.string().trim().min(1).max(40);

/** Case-insensitive name clash. Raw so it is an exact lower() match (sources_name_idx), not ILIKE. */
const nameTaken = async (name: string, exceptId = "") =>
  (await prisma.$queryRaw<unknown[]>`select 1 from sources where lower(name) = lower(${name}) and id <> ${exceptId}`).length > 0;

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
    if (await nameTaken(body.name)) throw new HttpError(409, `“${body.name}” already exists`);
    let id = slug(body.name);
    for (let n = 2; await prisma.sources.findUnique({ where: { id }, select: { id: true } }); n++) id = `${slug(body.name)}-${n}`;
    const { _max } = await prisma.sources.aggregate({ _max: { position: true } });
    await prisma.sources.create({ data: { id, name: body.name, color: body.color, position: (_max.position ?? -1) + 1 } });
    await logActivity(user.id, "settings_changed", `added source ${body.name}`);
    return { id, name: body.name, color: body.color, active: true };
  });

  app.patch("/api/sources/:id", async (req) => {
    const user = requirePerm(req, "sources.manage");
    const { id } = req.params as { id: string };
    const body = z.object({ name: Name, color: Color, active: z.boolean() }).partial().parse(req.body);
    const current = await prisma.sources.findUnique({ where: { id }, select: { name: true } });
    if (!current) throw new HttpError(404, "Source not found");
    if (body.name && (await nameTaken(body.name, id))) throw new HttpError(409, `“${body.name}” already exists`);
    await prisma.sources.updateMany({ where: { id }, data: { name: body.name, color: body.color, active: body.active } });
    if (body.name && body.name !== current.name) await logActivity(user.id, "settings_changed", `renamed source ${current.name} to ${body.name}`);
    return { ok: true };
  });

  app.delete("/api/sources/:id", async (req) => {
    const user = requirePerm(req, "sources.manage");
    const { id } = req.params as { id: string };
    const used = await prisma.candidates.count({ where: { source_id: id } });
    if (used) throw new HttpError(409, `${used} candidate${used === 1 ? " is" : "s are"} tagged with this source — hide it instead, or re-tag them first`);
    const row = await prisma.sources.findUnique({ where: { id }, select: { name: true } });
    if (row) await prisma.sources.deleteMany({ where: { id } });
    if (row) await logActivity(user.id, "settings_changed", `deleted source ${row.name}`);
    return { ok: true };
  });

  app.put("/api/sources/order", async (req) => {
    requirePerm(req, "sources.manage");
    const ids = z.array(z.string()).max(200).parse(req.body);
    await prisma.$transaction(ids.map((id, i) => prisma.sources.updateMany({ where: { id }, data: { position: i } })));
    return { ok: true };
  });

  /** Tag one or many candidates with a source (null clears it). */
  app.post("/api/candidates/source", async (req) => {
    const user = requirePerm(req, "candidates.tagSource");
    const body = z.object({ ids: z.array(z.string().uuid()).min(1).max(1000), sourceId: z.string().max(64).nullable() }).parse(req.body);
    const src = body.sourceId ? await prisma.sources.findUnique({ where: { id: body.sourceId }, select: { id: true, name: true } }) : null;
    if (body.sourceId && !src) throw new HttpError(400, "Unknown source");
    const rows = await prisma.candidates.updateManyAndReturn({
      // "source_id is distinct from <new>": skip candidates that already have it.
      where: { id: { in: body.ids }, ...(src ? { OR: [{ source_id: null }, { source_id: { not: src.id } }] } : { source_id: { not: null } }) },
      data: { source_id: src?.id ?? null },
      select: { id: true, first_name: true, last_name: true },
    });
    for (const r of rows) await touchCandidate(r.id);
    if (rows.length === 1) {
      const c = rows[0]!;
      await logActivity(user.id, "source_changed", src ? `tagged ${c.first_name} ${c.last_name} as ${src.name}` : `cleared the source on ${c.first_name} ${c.last_name}`, c.id);
    } else if (rows.length > 1) {
      await logActivity(user.id, "source_changed", src ? `tagged ${rows.length} candidates as ${src.name}` : `cleared the source on ${rows.length} candidates`);
    }
    return { updated: rows.length };
  });
}
