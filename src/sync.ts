import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { transaction } from './db';
import { entities, membership, validateRecord, writeRecord } from './crud';
import { ApiError, object, uuid, date, choice, relationshipTypes } from './validation';

export function safeUser(row: any) {
  if (!row) return null;
  const { password_hash, fcm_token, ...user } = row;
  return user;
}
export async function coupleProfile(client: PoolClient, userId: string) {
  const user = (await client.query('SELECT * FROM users WHERE id=$1', [userId])).rows[0];
  if (!user?.couple_id) return { couple: null, partner: null };
  const c = (await client.query('SELECT * FROM couples WHERE id=$1 AND ended_at IS NULL AND (user1_id=$2 OR user2_id=$2)', [user.couple_id,userId])).rows[0];
  if (!c) return { couple: null, partner: null };
  const partnerId = c.user1_id === userId ? c.user2_id : c.user1_id;
  const partner = partnerId ? safeUser((await client.query('SELECT * FROM users WHERE id=$1',[partnerId])).rows[0]) : null;
  return { couple: { ...c, partner_name: partner?.name ?? null }, partner };
}
function encodeCursor(sequence: string, userId: string, coupleId: string | null, secret: string) {
  const data = Buffer.from(JSON.stringify({ sequence, userId, coupleId })).toString('base64url');
  return `${data}.${createHmac('sha256',secret).update(data).digest('base64url')}`;
}
function decodeCursor(cursor: unknown, userId: string, coupleId: string | null, secret: string): string {
  if (cursor === undefined || cursor === null) return '0';
  if (typeof cursor !== 'string' || cursor.length > 1024) throw new ApiError(400,'Cursor inválido.');
  const [data,signature,...extra] = cursor.split('.');
  const expected = createHmac('sha256',secret).update(data).digest();
  const actual = Buffer.from(signature ?? '', 'base64url');
  if (extra.length || actual.length !== expected.length || !timingSafeEqual(actual,expected)) throw new ApiError(400,'Cursor inválido.');
  let decoded;
  try { decoded = JSON.parse(Buffer.from(data,'base64url').toString()); } catch { throw new ApiError(400,'Cursor inválido.'); }
  if (decoded.userId !== userId) throw new ApiError(403,'Cursor de outra conta.');
  if (decoded.coupleId !== coupleId) return '0';
  if (!/^\d{1,19}$/.test(decoded.sequence)) throw new ApiError(400,'Cursor inválido.');
  return decoded.sequence;
}
export function validateMutation(value: unknown) {
  const m = object(value);
  uuid(m.mutation_id);
  const record = object(m.record);
  uuid(record.id);
  if (m.entity === 'users') choice(record.relationship_type,relationshipTypes);
  else if (m.entity === 'couples') { uuid(record.couple_id ?? record.id); date(record.start_date); }
  else validateRecord(m.entity,record);
  return m;
}
export async function synchronize(db: Pool, userId: string, input: unknown, secret: string) {
  const body = object(input);
  if (body.protocol !== 2) throw new ApiError(426,'Atualize o aplicativo para sincronizar.');
  if (!Array.isArray(body.mutations) || body.mutations.length > 100) throw new ApiError(400,'Envie até 100 alterações por lote.');
  const mutations = body.mutations.map(validateMutation);
  return transaction(db,async client => {
    const me = (await client.query('SELECT * FROM users WHERE id=$1',[userId])).rows[0];
    if (!me) throw new ApiError(401,'Conta indisponível.');
    const coupleId = me.couple_id ? await membership(client,userId) : null;
    const since = decodeCursor(body.cursor,userId,coupleId,secret);
    const acknowledgements: string[] = [];
    const messages: any[] = [];
    for (const m of mutations) {
      const hash = createHash('sha256').update(JSON.stringify(m)).digest('hex');
      const receipt = (await client.query('SELECT payload_hash FROM mutation_receipts WHERE user_id=$1 AND mutation_id=$2',[userId,m.mutation_id])).rows[0];
      if (receipt) {
        if (receipt.payload_hash !== hash) throw new ApiError(409,'ID de alteração já utilizado.');
      } else {
        if (m.entity === 'users') {
          if (m.record.id !== userId) throw new ApiError(403,'Perfil de outra conta.');
          await client.query('UPDATE users SET relationship_type=$1,updated_at=NOW() WHERE id=$2',[m.record.relationship_type,userId]);
        } else if (m.entity === 'couples') {
          if (!coupleId || m.record.id !== coupleId) throw new ApiError(403,'Casal indisponível.');
          await client.query('UPDATE couples SET start_date=$1,updated_at=NOW() WHERE id=$2',[m.record.start_date,coupleId]);
        } else {
          if (!coupleId) throw new ApiError(403,'Usuário não possui casal ativo.');
          const result = await writeRecord(client,m.entity,m.record,userId,coupleId);
          if (m.entity === 'chamegos' && result.inserted) messages.push(result.row);
        }
        await client.query('INSERT INTO mutation_receipts(user_id,mutation_id,payload_hash) VALUES($1,$2,$3)',[userId,m.mutation_id,hash]);
      }
      acknowledgements.push(m.mutation_id);
    }
    const changes = (await client.query(`SELECT * FROM sync_changes WHERE sequence>$1
      AND (user_id=$2 OR ($3::uuid IS NOT NULL AND couple_id=$3)) ORDER BY sequence LIMIT 501`,[since,userId,coupleId])).rows;
    const hasMore = changes.length > 500;
    const page = changes.slice(0,500);
    const remote: Record<string,any[]> = Object.fromEntries(Object.keys(entities).map(k=>[k,[]]));
    for (const entity of Object.keys(entities)) {
      const ids = [...new Set(page.filter(c=>c.entity===entity).map(c=>c.record_id))];
      if (!ids.length || !coupleId) continue;
      const rows = (await client.query(`SELECT * FROM ${entity} WHERE id=ANY($1::uuid[]) AND couple_id=$2`,[ids,coupleId])).rows;
      for (const id of ids) {
        const row = rows.find(r=>r.id===id);
        if (!row || (entity==='gifts' && row.type==='secret' && row.creator_id!==userId)) remote[entity].push({id,is_deleted:true});
        else remote[entity].push(row);
      }
    }
    const profile = await coupleProfile(client,userId);
    const currentUser = safeUser((await client.query('SELECT * FROM users WHERE id=$1',[userId])).rows[0]);
    return { protocol: 2, status:'success', cursor:encodeCursor(page.at(-1)?.sequence ?? since,userId,coupleId,secret),
      has_more:hasMore, acknowledgements, remote_updates:{...remote,...profile,user:currentUser}, messages };
  });
}
