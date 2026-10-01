import { Express, Request, Response, NextFunction, RequestHandler } from 'express';
import { Pool } from 'pg';

/**
 * REST CRUD for the couple-scoped entities described in Guide.md:
 *   /api/outings, /api/memories, /api/gifts, /api/special-dates
 *
 * Rules:
 *  - Every route requires a Bearer token (the `auth` middleware passed in).
 *  - Data is always scoped to the authenticated user's couple. `couple_id` in the
 *    request body is ignored, so a user can never read/write another couple's data.
 *  - DELETE is a soft delete (is_deleted = TRUE, updated_at = NOW()) so that the
 *    /api/sync endpoint still propagates the deletion to the partner's device.
 *  - POST is an idempotent upsert on the client-generated `id` (offline-first
 *    clients may retry the same request).
 */

interface EntityConfig {
  route: string;
  table: string;
  /** Columns a client may set (besides id / couple_id / timestamps). */
  fields: string[];
  /** Columns that must be present on create. */
  required: string[];
  /** Columns stored as JSONB. */
  json?: string[];
  /** Column automatically filled with the authenticated user id (gifts). */
  creatorColumn?: string;
}

const ENTITIES: EntityConfig[] = [
  {
    route: 'outings',
    table: 'outings',
    fields: ['title', 'location', 'date', 'category', 'cost', 'status', 'rating', 'notify_option'],
    required: ['title'],
  },
  {
    route: 'memories',
    table: 'memories',
    fields: ['title', 'date', 'description', 'mood', 'photo_urls'],
    required: ['title', 'date'],
    json: ['photo_urls'],
  },
  {
    route: 'gifts',
    table: 'gifts',
    fields: ['type', 'title', 'store_url', 'price', 'occasion'],
    required: ['title'],
    creatorColumn: 'creator_id',
  },
  {
    route: 'special-dates',
    table: 'special_dates',
    fields: ['title', 'date', 'repeat_option', 'notify_option'],
    required: ['title', 'date'],
  },
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(res: Response, status: number, msg: string): void {
  res.status(status).json({ error: msg, message: msg });
}

/** pg returns NUMERIC as string; the API contract uses numbers. */
function serialize(row: any): any {
  if (!row) return row;
  const out = { ...row };
  for (const k of ['cost', 'price']) {
    if (out[k] !== null && out[k] !== undefined) out[k] = Number(out[k]);
  }
  return out;
}

export function registerCrudRoutes(app: Express, pool: Pool, auth: RequestHandler): void {
  /** Resolve the couple of the authenticated user; sends a 400 and returns null if none. */
  async function getCoupleId(req: Request, res: Response): Promise<string | null> {
    const userId = (req as any).user.id as string;
    const r = await pool.query('SELECT couple_id FROM users WHERE id = $1', [userId]);
    const coupleId = r.rows[0]?.couple_id as string | undefined;
    if (!coupleId) {
      fail(res, 400, 'Usuário não possui casal associado.');
      return null;
    }
    return coupleId;
  }

  /** Pick whitelisted fields from body; undefined values are skipped. */
  function pickFields(cfg: EntityConfig, body: any): Record<string, any> {
    const out: Record<string, any> = {};
    for (const f of cfg.fields) {
      if (body[f] === undefined) continue;
      out[f] = cfg.json?.includes(f) ? JSON.stringify(body[f] ?? []) : body[f];
    }
    return out;
  }

  const wrap =
    (fn: (req: Request, res: Response) => Promise<void>, tag: string): RequestHandler =>
    async (req: Request, res: Response, _next: NextFunction) => {
      try {
        await fn(req, res);
      } catch (err: any) {
        console.error(`[CRUD:${tag}]`, err);
        if (err?.code === '22P02' || err?.code === '22007' || err?.code === '22008') {
          // invalid uuid / date / numeric text representation
          fail(res, 400, 'Dados inválidos na requisição.');
        } else {
          fail(res, 500, 'Erro interno do servidor.');
        }
      }
    };

  for (const cfg of ENTITIES) {
    const base = `/api/${cfg.route}`;

    // ── GET /api/<entity> ──
    app.get(
      base,
      auth,
      wrap(async (req, res) => {
        const coupleId = await getCoupleId(req, res);
        if (!coupleId) return;
        const r = await pool.query(
          `SELECT * FROM ${cfg.table}
            WHERE couple_id = $1 AND is_deleted = FALSE
            ORDER BY created_at DESC`,
          [coupleId]
        );
        res.status(200).json(r.rows.map(serialize));
      }, cfg.route)
    );

    // ── POST /api/<entity> (idempotent upsert on client id) ──
    app.post(
      base,
      auth,
      wrap(async (req, res) => {
        const userId = (req as any).user.id as string;
        const coupleId = await getCoupleId(req, res);
        if (!coupleId) return;

        const body = req.body ?? {};
        for (const f of cfg.required) {
          if (body[f] === undefined || body[f] === null || body[f] === '') {
            return fail(res, 400, `${f} é obrigatório.`);
          }
        }
        if (body.id !== undefined && !UUID_RE.test(String(body.id))) {
          return fail(res, 400, 'id inválido (esperado UUID).');
        }

        const data = pickFields(cfg, body);
        if (cfg.creatorColumn) data[cfg.creatorColumn] = userId;

        const cols: string[] = ['couple_id'];
        const vals: any[] = [coupleId];
        if (body.id) {
          cols.push('id');
          vals.push(body.id);
        }
        for (const [k, v] of Object.entries(data)) {
          cols.push(k);
          vals.push(v);
        }
        const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');

        // On conflict only update non-identity columns, and only if the row belongs to this couple.
        const updatable = Object.keys(data).filter((k) => k !== cfg.creatorColumn);
        const setClause = [...updatable.map((k) => `${k} = EXCLUDED.${k}`), 'is_deleted = FALSE', 'updated_at = NOW()'].join(', ');

        const r = await pool.query(
          `INSERT INTO ${cfg.table} (${cols.join(', ')})
           VALUES (${placeholders})
           ON CONFLICT (id) DO UPDATE SET ${setClause}
             WHERE ${cfg.table}.couple_id = EXCLUDED.couple_id
           RETURNING *, (xmax = 0) AS _inserted`,
          vals
        );

        if (r.rows.length === 0) {
          // id exists but belongs to another couple
          return fail(res, 409, 'Conflito: id já está em uso.');
        }
        const { _inserted, ...row } = r.rows[0];
        res.status(_inserted ? 201 : 200).json(serialize(row));
      }, cfg.route)
    );

    // ── PUT /api/<entity>/:id ──
    app.put(
      `${base}/:id`,
      auth,
      wrap(async (req, res) => {
        const id = String(req.params.id);
        if (!UUID_RE.test(id)) return fail(res, 400, 'id inválido (esperado UUID).');
        const coupleId = await getCoupleId(req, res);
        if (!coupleId) return;

        const body = req.body ?? {};
        for (const f of cfg.required) {
          if (body[f] !== undefined && (body[f] === null || body[f] === '')) {
            return fail(res, 400, `${f} não pode ser vazio.`);
          }
        }

        const data = pickFields(cfg, body);
        if (typeof body.is_deleted === 'boolean') data.is_deleted = body.is_deleted;

        const keys = Object.keys(data);
        if (keys.length === 0) return fail(res, 400, 'Nenhum campo válido para atualizar.');

        const sets = keys.map((k, i) => `${k} = $${i + 1}`);
        sets.push('updated_at = NOW()');
        const vals = keys.map((k) => data[k]);

        const r = await pool.query(
          `UPDATE ${cfg.table} SET ${sets.join(', ')}
            WHERE id = $${keys.length + 1} AND couple_id = $${keys.length + 2}
            RETURNING *`,
          [...vals, id, coupleId]
        );
        if (r.rows.length === 0) return fail(res, 404, 'Registro não encontrado.');
        res.status(200).json(serialize(r.rows[0]));
      }, cfg.route)
    );

    // ── DELETE /api/<entity>/:id (soft delete) ──
    app.delete(
      `${base}/:id`,
      auth,
      wrap(async (req, res) => {
        const id = String(req.params.id);
        if (!UUID_RE.test(id)) return fail(res, 400, 'id inválido (esperado UUID).');
        const coupleId = await getCoupleId(req, res);
        if (!coupleId) return;

        const r = await pool.query(
          `UPDATE ${cfg.table} SET is_deleted = TRUE, updated_at = NOW()
            WHERE id = $1 AND couple_id = $2
            RETURNING id`,
          [id, coupleId]
        );
        if (r.rows.length === 0) return fail(res, 404, 'Registro não encontrado.');
        res.status(200).json({ status: 'success', id });
      }, cfg.route)
    );
  }
}
