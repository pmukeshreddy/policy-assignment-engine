import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import {
  backfillNycEmployeeNames,
  fetchNycEmployees,
  NYC_DATASET_ID,
  NYC_IMPORT_COUNT,
} from '../src/eval/nyc.js';

const config = loadConfig();
const pool = createPool(config);

try {
  const workspaces = await pool.query<{ company_id: string }>(
    'SELECT company_id FROM product_workspaces WHERE dataset_id = $1 ORDER BY created_at, company_id',
    [NYC_DATASET_ID],
  );
  if (workspaces.rowCount !== 1 || workspaces.rows[0] === undefined) {
    throw new Error(`Expected exactly one NYC product workspace; found ${workspaces.rowCount}`);
  }
  process.stdout.write('Fetching NYC source facts to restore employee names without replacing the product workspace...\n');
  const fetched = await fetchNycEmployees({
    targetCount: NYC_IMPORT_COUNT,
    pageSize: 5_000,
    ...(process.env['NYC_APP_TOKEN'] === undefined ? {} : { appToken: process.env['NYC_APP_TOKEN'] }),
  });
  const result = await backfillNycEmployeeNames(pool, workspaces.rows[0].company_id, fetched);
  process.stdout.write(
    `Restored ${result.employeesNamed.toLocaleString()} source names across ${result.versionsUpdated.toLocaleString()} employee versions; `
    + `${result.employeesMatched.toLocaleString()} imported employees matched exactly.\n`,
  );
} finally {
  await pool.end();
}
