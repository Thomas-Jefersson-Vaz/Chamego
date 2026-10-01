import { Pool, types } from 'pg';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

// NUMERIC/DECIMAL (oid 1700) -> JS number instead of string (cost, price)
types.setTypeParser(1700, (v: string) => parseFloat(v));

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export async function initDb() {
  try {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    await pool.query(schemaSql);
    console.log('Database schema initialized successfully.');
  } catch (error) {
    console.error('Error initializing database schema:', error);
  }
}
