import { Pool, PoolClient, types } from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
dotenv.config();
types.setTypeParser(1700, Number);
export const JOURNAL_LOCK = 434343;
export const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10,
  connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 15000 });
pool.on('error', () => console.error(JSON.stringify({ event: 'database_pool_error' })));
export async function transaction<T>(db: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [JOURNAL_LOCK]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}
export async function initDb(db = pool): Promise<void> {
  await transaction(db, async client => {
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    for (const version of ['001_schema', '002_production']) {
      if ((await client.query('SELECT version FROM schema_migrations WHERE version=$1', [version])).rowCount) continue;
      const filename = version === '001_schema' ? 'schema.sql' : 'migrations/002_production.sql';
      await client.query(fs.readFileSync(path.join(__dirname, filename), 'utf8'));
      await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [version]);
    }
  });
}
