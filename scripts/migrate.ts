import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';

const config = loadConfig();
const pool = createPool(config);
const migrationsDirectory = resolve(process.cwd(), 'migrations');

try {
  const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith('.sql')).sort();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query('SELECT pg_advisory_lock(hashtext($1))', ['policy-engine-migrations']);
  try {
    for (const file of files) {
      const sql = await readFile(resolve(migrationsDirectory, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await pool.query<{ checksum: string }>(
        'SELECT checksum FROM schema_migrations WHERE name = $1',
        [file],
      );
      if (existing.rowCount === 1) {
        if (existing.rows[0]?.checksum !== checksum) {
          throw new Error(`Applied migration ${file} has changed`);
        }
        continue;
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
        process.stdout.write(`Applied ${file}\n`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.query('SELECT pg_advisory_unlock(hashtext($1))', ['policy-engine-migrations']);
  }
} finally {
  await pool.end();
}
