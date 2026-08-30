import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';

if (process.env.NODE_ENV === 'production') {
  throw new Error('Refusing to reset a production database');
}

const config = loadConfig();
const database = new URL(config.DATABASE_URL).pathname.slice(1);
if (!database.endsWith('_test') && process.env.ALLOW_DATABASE_RESET !== 'true') {
  throw new Error('Database reset requires a *_test database or ALLOW_DATABASE_RESET=true');
}

const pool = createPool(config);
try {
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  process.stdout.write(`Reset database ${database}\n`);
} finally {
  await pool.end();
}
