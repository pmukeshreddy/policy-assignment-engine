import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import {
  DEFAULT_MUTATION_BATCH_SIZE,
  DEFAULT_MUTATION_COUNT,
  DEFAULT_REGRESSION_SEED,
  formatRegressionReport,
  runRegressionEvaluation,
} from '../src/eval/regression.js';

const seed = integerArgument('--seed', DEFAULT_REGRESSION_SEED);
const mutationCount = integerArgument('--mutations', DEFAULT_MUTATION_COUNT);
const batchSize = integerArgument('--batch-size', DEFAULT_MUTATION_BATCH_SIZE);
const allowSmall = process.argv.includes('--allow-small');
const reusePreparedUniverse = process.argv.includes('--reuse-prepared');
if (mutationCount < DEFAULT_MUTATION_COUNT && !allowSmall) {
  throw new Error(`Certified regression runs require at least ${DEFAULT_MUTATION_COUNT.toLocaleString()} mutations; use --allow-small only for non-certifying smoke runs`);
}

const config = loadConfig();
const pool = createPool(config);
try {
  const report = await runRegressionEvaluation(pool, {
    seed,
    mutationCount,
    batchSize,
    reusePreparedUniverse,
    progress: (message) => process.stdout.write(`${message}\n`),
  });
  process.stdout.write(`\n${formatRegressionReport(report)}\n`);
  process.stdout.write(`\nJSON artifact: ${report.artifacts.json}\nHuman report: ${report.artifacts.markdown}\n`);
} finally {
  await pool.end();
}

function integerArgument(name: string, fallback: number): number {
  const raw = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (raw === undefined) return fallback;
  const value = Number(raw.slice(name.length + 1));
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
  return value;
}
