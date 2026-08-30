import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { ReconciliationWorker } from './services/worker.js';

const config = loadConfig();
const pool = createPool(config);
const worker = new ReconciliationWorker(pool, config);

const shutdown = (): void => worker.stop();
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

try {
  await worker.run();
} finally {
  await pool.end();
}
