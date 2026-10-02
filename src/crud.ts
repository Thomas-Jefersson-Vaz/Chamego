import { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { ApiError, object, text, date, uuid, choice } from './validation';
export const entities: Record<string, string[]> = {
  chamegos: ['text','type','created_at'],
  outings: ['title','location','date','category','cost','status','rating','notify_option','is_deleted'],
  memories: ['title','date','description','mood','photo_urls','is_deleted'],
  gifts: ['title','type','store_url','price','occasion','is_deleted'],
  special_dates: ['title','date','repeat_option','notify_option','is_deleted'],
};
export function validateRecord(entity: string, value: unknown, partial = false): Record<string, any> {
  if (!Object.hasOwn(entities,entity)) throw new ApiError(400, 'Recurso invalido.');
  const body = object(value);
  if (body.id !== undefined) uuid(body.id);
  if (body.couple_id !== undefined) uuid(body.couple_id);
  const data: Record<string, any> = {};
  for (const key of entities[entity]) {
    if (body[key] === undefined) continue;
    const v = body[key];
    if (key === 'is_deleted') {
      if (typeof v !== 'boolean') throw new ApiError(400, 'is_deleted deve ser booleano.');
      data[key] = v;
    } else if (['cost','price','rating'].includes(key)) {
      if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 99999999.99 || (key === 'rating' && (!Number.isInteger(v) || v > 5)))) throw new ApiError(400, 'Valor numerico invalido.');
      data[key] = v;
    } else if (['date','created_at'].includes(key)) {
      data[key] = v === null && entity === 'outings' ? null : date(v);
    } else if (key === 'photo_urls') {
      if (!Array.isArray(v) || v.length > 20 || v.some(x => typeof x !== 'string' || x.length > 2048 || !/^https:\/\//.test(x))) throw new ApiError(400, 'Fotos invalidas.');
      data[key] = JSON.stringify(v);
    } else if (key === 'status') data[key] = choice(v,['planned','idea','done']);
    else if (key === 'repeat_option') data[key] = choice(v,['none','monthly','yearly']);
    else if (key === 'notify_option') data[key] = v === null ? null : choice(v,['none','day','1day_before','1week_before']);
    else if (key === 'type' && entity === 'gifts') data[key] = choice(v,['wish','secret','given']);
    else if (key === 'store_url') {
      if (v !== null && (typeof v !== 'string' || v.length > 2048 || !/^https?:\/\//.test(v))) throw new ApiError(400, 'Link invalido.');
      data[key] = v;
    } else {
      const required = ['title','text','type','category','mood'].includes(key);
      if (v === null && !required) data[key] = null;
      else if (v === '' && key === 'description') data[key] = '';
      else data[key] = text(v, ['text','description'].includes(key) ? 4000 : key === 'type' ? 50 : ['category','mood','occasion'].includes(key) ? 100 : 255);
    }
  }
  if (!partial) {
    for (const key of entity === 'chamegos' ? ['text','type'] : ['memories','special_dates'].includes(entity) ? ['title','date'] : ['title']) {
      if (data[key] === undefined) throw new ApiError(400, `${key} e obrigatorio.`);
    }
  }
  return data;
}
export async function membership(client: PoolClient, userId: string): Promise<string> {
  const r = await client.query(`SELECT u.couple_id FROM users u JOIN couples c ON c.id=u.couple_id
    WHERE u.id=$1 AND c.ended_at IS NULL AND (c.user1_id=u.id OR c.user2_id=u.id)`, [userId]);
  if (!r.rows[0]) throw new ApiError(403, 'Usuario nao possui casal ativo.');
  return r.rows[0].couple_id;
}
export async function writeRecord(client: PoolClient, entity: string, body: Record<string, any>, userId: string, coupleId: string, partial = false) {
  const data = validateRecord(entity, body, partial);
  const id = body.id ? uuid(body.id) : randomUUID();
  if (body.couple_id && uuid(body.couple_id) !== coupleId) throw new ApiError(403, 'Voce nao pertence a este casal.');
  const existing = (await client.query(`SELECT * FROM ${entity} WHERE id=$1 FOR UPDATE`, [id])).rows[0];
  if (existing && (existing.couple_id !== coupleId || (entity === 'gifts' && existing.type === 'secret' && existing.creator_id !== userId))) throw new ApiError(409, 'Registro indisponivel.');
  if (entity === 'gifts' && existing && data.type === 'secret' && existing.creator_id !== userId) throw new ApiError(403, 'Somente o criador pode tornar o presente secreto.');
  if (partial && !existing) throw new ApiError(404, 'Registro nao encontrado.');
  if (entity === 'chamegos' && existing) {
    if (existing.sender_id !== userId || existing.text !== data.text || existing.type !== data.type) throw new ApiError(409, 'ID de mensagem ja utilizado.');
    return { row: existing, inserted: false };
  }
  if (existing) {
    const keys = Object.keys(data);
    if (!keys.length) throw new ApiError(400, 'Nenhum campo valido.');
    const sets = keys.map((k,i) => `${k}=$${i+1}`);
    if (entity !== 'chamegos') sets.push('updated_at=NOW()');
    return { row: (await client.query(`UPDATE ${entity} SET ${sets.join(',')} WHERE id=$${keys.length+1} RETURNING *`, [...Object.values(data),id])).rows[0], inserted: false };
  }
  const all: Record<string, any> = { id, couple_id: coupleId, ...data };
  if (entity === 'gifts') all.creator_id = userId;
  if (entity === 'chamegos') all.sender_id = userId;
  const keys = Object.keys(all);
  return { row: (await client.query(`INSERT INTO ${entity} (${keys.join(',')}) VALUES (${keys.map((_,i)=>`$${i+1}`).join(',')}) RETURNING *`,Object.values(all))).rows[0], inserted: true };
}
