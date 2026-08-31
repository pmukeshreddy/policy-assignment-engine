import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { fetchNycEmployees, importNycEmployees, NYC_IMPORT_COUNT } from '../src/eval/nyc.js';

const pageSizeArgument = process.argv.find((argument) => argument.startsWith('--page-size='));
const pageSize = pageSizeArgument === undefined ? 5_000 : Number(pageSizeArgument.slice('--page-size='.length));
if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50_000) {
  throw new Error('--page-size must be an integer between 1 and 50,000');
}

const config = loadConfig();
const pool = createPool(config);
try {
  process.stdout.write(`Fetching exactly ${NYC_IMPORT_COUNT.toLocaleString()} usable NYC Open Data payroll records...\n`);
  const fetched = await fetchNycEmployees({
    targetCount: NYC_IMPORT_COUNT,
    pageSize,
    ...(process.env['NYC_APP_TOKEN'] === undefined ? {} : { appToken: process.env['NYC_APP_TOKEN'] }),
  });
  process.stdout.write(
    `Validated ${fetched.employees.length.toLocaleString()} rows; skipped ${fetched.skippedRows.toLocaleString()} malformed rows. Importing into PostgreSQL...\n`,
  );
  const result = await importNycEmployees(pool, fetched);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await pool.end();
}
