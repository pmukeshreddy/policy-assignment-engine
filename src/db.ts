import pg from 'pg';
import type { AppConfig } from './config.js';

const { Pool } = pg;

export type DbPool = pg.Pool;
export type DbClient = pg.PoolClient;
export type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

export function createPool(config: Pick<AppConfig, 'DATABASE_URL'>): DbPool {
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'policy-assignment-engine',
  });
  pool.on('error', (error) => {
    process.stderr.write(`Unexpected PostgreSQL pool error: ${error.message}\n`);
  });
  return pool;
}

export async function inTransaction<T>(pool: DbPool, fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === '23505';
}
