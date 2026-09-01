import type { DbClient, DbPool } from '../db.js';
import { inTransaction } from '../db.js';
import {
  CERTIFIED_RULE_COUNT,
  CERTIFIED_RULE_SEED,
  certifiedCategoryDefinitions,
  createCertifiedBaseline,
  type CertifiedCategory,
} from '../baseline/certified-universe.js';
import { enqueueJob } from '../services/jobs.js';
import { NYC_DATASET_ID, NYC_EVALUATION_TENANT_KEY, NYC_IMPORT_COUNT } from './nyc.js';

export const EVALUATION_RULE_SEED = CERTIFIED_RULE_SEED;
export const EVALUATION_RULE_COUNT = CERTIFIED_RULE_COUNT;
export type EvaluationCategory = CertifiedCategory;

export interface EvaluationUniverse {
  companyId: string;
  importId: string;
  datasetChecksum: string;
  baselineDate: string;
  employeeCount: number;
  ruleCount: number;
  categories: EvaluationCategory[];
  groupIds: string[];
  initialJobId: string;
}

export async function rebuildEvaluationUniverse(
  pool: DbPool,
  input: { ruleCount?: number; expectedEmployees?: number } = {},
): Promise<EvaluationUniverse> {
  const ruleCount = input.ruleCount ?? EVALUATION_RULE_COUNT;
  const expectedEmployees = input.expectedEmployees ?? NYC_IMPORT_COUNT;
  if (!Number.isInteger(ruleCount) || ruleCount < 200 || ruleCount > 500) {
    throw new Error('Evaluation rule count must be between 200 and 500');
  }
  return inTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
      'policy-regression-universe', NYC_DATASET_ID,
    ]);
    const tenant = await client.query<{ company_id: string }>(
      'SELECT company_id FROM evaluation_tenants WHERE key = $1 FOR UPDATE', [NYC_EVALUATION_TENANT_KEY],
    );
    const companyId = tenant.rows[0]?.company_id;
    if (companyId === undefined) throw new Error('NYC data is not imported; run npm run data:nyc first');
    const latestImport = await client.query<{
      id: string; checksum: string; imported_rows: number; fiscal_year: string;
    }>(
      `SELECT id, checksum, imported_rows, metadata ->> 'fiscalYear' AS fiscal_year
         FROM dataset_imports
        WHERE company_id = $1 AND dataset_id = $2
        ORDER BY completed_at DESC, id DESC LIMIT 1`,
      [companyId, NYC_DATASET_ID],
    );
    const imported = latestImport.rows[0];
    if (imported === undefined) throw new Error('NYC import provenance is missing');
    if (imported.imported_rows !== expectedEmployees) {
      throw new Error(`Evaluation requires ${expectedEmployees.toLocaleString()} imported employees; found ${imported.imported_rows.toLocaleString()}`);
    }
    if (!/^\d{4}$/.test(imported.fiscal_year)) throw new Error('NYC import fiscal-year provenance is invalid');
    const baselineDate = `${imported.fiscal_year}-06-30`;
    await resetSourceState(client, companyId, imported.id, baselineDate);
    const baseline = await createCertifiedBaseline(client, {
      companyId,
      baselineDate,
      idNamespace: 'eval',
      createdBy: 'policy-regression-eval',
      ruleCount,
    });
    const initialJobId = await enqueueJob(client, {
      companyId,
      eventType: 'EVALUATION_UNIVERSE_REBUILT',
      scope: 'FULL',
      payload: {
        datasetId: NYC_DATASET_ID,
        importId: imported.id,
        datasetChecksum: imported.checksum,
        ruleSeed: EVALUATION_RULE_SEED,
        ruleCount: baseline.ruleCount,
      },
      dedupeKey: `evaluation-universe:${imported.id}:${imported.checksum}:${EVALUATION_RULE_SEED}:${baseline.ruleCount}`,
      priority: 100,
    });
    return {
      companyId,
      importId: imported.id,
      datasetChecksum: imported.checksum,
      baselineDate,
      employeeCount: imported.imported_rows,
      ruleCount: baseline.ruleCount,
      categories: baseline.categories,
      groupIds: baseline.groupIds,
      initialJobId,
    };
  });
}

/** Resume the exact prepared certified baseline without rebuilding or refetching it. */
export async function resumePreparedEvaluationUniverse(
  pool: DbPool,
  input: { ruleCount?: number; expectedEmployees?: number } = {},
): Promise<EvaluationUniverse> {
  const expectedRuleCount = input.ruleCount ?? EVALUATION_RULE_COUNT;
  const expectedEmployees = input.expectedEmployees ?? NYC_IMPORT_COUNT;
  return inTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
      'policy-regression-universe', NYC_DATASET_ID,
    ]);
    const tenant = await client.query<{ company_id: string }>(
      'SELECT company_id FROM evaluation_tenants WHERE key = $1 FOR UPDATE', [NYC_EVALUATION_TENANT_KEY],
    );
    const companyId = tenant.rows[0]?.company_id;
    if (companyId === undefined) throw new Error('NYC data is not imported; run npm run data:nyc first');
    const importedResult = await client.query<{
      id: string; checksum: string; imported_rows: number; fiscal_year: string;
    }>(
      `SELECT id, checksum, imported_rows, metadata ->> 'fiscalYear' AS fiscal_year
         FROM dataset_imports
        WHERE company_id = $1 AND dataset_id = $2
        ORDER BY completed_at DESC, id DESC LIMIT 1`,
      [companyId, NYC_DATASET_ID],
    );
    const imported = importedResult.rows[0];
    if (imported === undefined || !/^\d{4}$/.test(imported.fiscal_year)) {
      throw new Error('NYC import provenance is missing or invalid');
    }
    const baselineDate = `${imported.fiscal_year}-06-30`;
    const sourceState = await client.query<{
      employees: number; non_baseline_versions: number; manual_overrides: number; rules: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM employees WHERE company_id = $1) AS employees,
         (SELECT count(*)::int
            FROM employees e
            JOIN employee_versions ev ON ev.company_id = e.company_id AND ev.id = e.current_version_id
           WHERE e.company_id = $1
             AND (ev.version <> 1 OR ev.valid_from <> $2::date OR ev.valid_to IS NOT NULL)) AS non_baseline_versions,
         (SELECT count(*)::int FROM manual_overrides WHERE company_id = $1) AS manual_overrides,
         (SELECT count(*)::int FROM rules WHERE company_id = $1) AS rules`,
      [companyId, baselineDate],
    );
    const state = sourceState.rows[0]!;
    if (imported.imported_rows !== expectedEmployees || state.employees !== expectedEmployees) {
      throw new Error(`Prepared evaluation universe must contain exactly ${expectedEmployees.toLocaleString()} imported employees`);
    }
    if (state.non_baseline_versions !== 0 || state.manual_overrides !== 0) {
      throw new Error('Prepared evaluation universe contains source mutations and cannot be resumed as a baseline');
    }
    if (state.rules !== expectedRuleCount) {
      throw new Error(`Prepared evaluation universe must contain exactly ${expectedRuleCount} rules; found ${state.rules}`);
    }
    const categoryResult = await client.query<{
      id: string; key: string; cardinality: 'SINGLE' | 'MULTIPLE'; policy_ids: string[];
    }>(
      `SELECT pc.id, pc.key, pc.cardinality, array_agg(p.id::text ORDER BY p.key) AS policy_ids
         FROM policy_categories pc
         JOIN policies p ON p.company_id = pc.company_id AND p.category_id = pc.id
        WHERE pc.company_id = $1 AND pc.key = ANY($2::text[])
        GROUP BY pc.id, pc.key, pc.cardinality`,
      [companyId, certifiedCategoryDefinitions.map((definition) => definition.key)],
    );
    const byKey = new Map(categoryResult.rows.map((row) => [row.key, row]));
    const categories = certifiedCategoryDefinitions.map((definition) => {
      const row = byKey.get(definition.key);
      if (row === undefined || row.cardinality !== definition.cardinality || row.policy_ids.length !== 8) {
        throw new Error(`Prepared evaluation category ${definition.key} is missing or invalid`);
      }
      return { id: row.id, key: row.key, cardinality: row.cardinality, policyIds: row.policy_ids };
    });
    const groups = await client.query<{ id: string }>(
      `SELECT id FROM groups
        WHERE company_id = $1 AND slug LIKE 'eval-observed-department-%'
        ORDER BY slug`,
      [companyId],
    );
    if (groups.rows.length !== 8) throw new Error('Prepared evaluation universe must contain exactly eight observed cohort groups');
    const jobs = await client.query<{ id: string; active_jobs: number }>(
      `WITH baseline AS (
         SELECT id FROM reconciliation_jobs
          WHERE company_id = $1 AND event_type = 'EVALUATION_UNIVERSE_REBUILT' AND scope = 'FULL'
          ORDER BY created_at DESC, id DESC LIMIT 1
       )
       SELECT baseline.id,
              (SELECT count(*)::int FROM reconciliation_jobs jobs
                WHERE jobs.company_id = $1 AND jobs.id <> baseline.id
                  AND jobs.status IN ('PENDING', 'RUNNING')) AS active_jobs
         FROM baseline`,
      [companyId],
    );
    const job = jobs.rows[0];
    if (job === undefined) throw new Error('Prepared evaluation universe has no baseline FULL reconciliation job');
    if (job.active_jobs !== 0) throw new Error('Prepared evaluation universe has non-baseline jobs pending; refusing unsafe resume');
    const requeued = await client.query(
      `UPDATE reconciliation_jobs
          SET status = 'PENDING', attempts = 0, available_at = now(), locked_at = NULL,
              locked_by = NULL, finished_at = NULL, last_error = NULL
        WHERE company_id = $1 AND id = $2`,
      [companyId, job.id],
    );
    if (requeued.rowCount !== 1) throw new Error('Could not requeue the prepared baseline reconciliation job');
    return {
      companyId,
      importId: imported.id,
      datasetChecksum: imported.checksum,
      baselineDate,
      employeeCount: state.employees,
      ruleCount: state.rules,
      categories,
      groupIds: groups.rows.map((row) => row.id),
      initialJobId: job.id,
    };
  });
}

async function resetSourceState(client: DbClient, companyId: string, importId: string, baselineDate: string): Promise<void> {
  await client.query(
    `CREATE TEMP TABLE evaluation_employee_reset ON COMMIT DROP AS
     SELECT e.id AS employee_id, e.external_id, records.dataset_id, records.source_row_id,
            records.source_record_checksum, records.normalized_facts
       FROM employee_import_records records
       JOIN employees e ON e.company_id = records.company_id AND e.id = records.employee_id
      WHERE records.company_id = $1 AND records.import_id = $2`,
    [companyId, importId],
  );
  const staged = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM evaluation_employee_reset');
  if (Number(staged.rows[0]?.count) === 0) throw new Error('Imported employee baseline is empty');
  await client.query('DELETE FROM assignment_history WHERE company_id = $1', [companyId]);
  await client.query('DELETE FROM materialized_assignments WHERE company_id = $1', [companyId]);
  await client.query('DELETE FROM scheduled_evaluations WHERE company_id = $1', [companyId]);
  await client.query('DELETE FROM assignment_decisions WHERE company_id = $1', [companyId]);
  await client.query('DELETE FROM reconciliation_jobs WHERE company_id = $1', [companyId]);
  await client.query('DELETE FROM manual_overrides WHERE company_id = $1', [companyId]);
  await client.query('DELETE FROM rules WHERE company_id = $1', [companyId]);
  await client.query('DELETE FROM policy_categories WHERE company_id = $1', [companyId]);
  await client.query('DELETE FROM groups WHERE company_id = $1', [companyId]);
  await client.query('UPDATE employees SET current_version_id = NULL WHERE company_id = $1', [companyId]);
  await client.query('DELETE FROM employee_versions WHERE company_id = $1', [companyId]);
  await client.query(
    `INSERT INTO employee_versions
       (company_id, employee_id, version, valid_from, display_name, location, department,
        employment_type, is_manager, hire_date, attributes, changed_fields, created_by)
     SELECT $1, records.employee_id, 1, $2::date,
            records.normalized_facts ->> 'displayName',
            records.normalized_facts ->> 'location',
            records.normalized_facts ->> 'department',
            records.normalized_facts ->> 'employmentType', false,
            (records.normalized_facts ->> 'hireDate')::date,
            records.normalized_facts -> 'attributes', ARRAY['evaluation_reset'], 'policy-regression-eval'
       FROM evaluation_employee_reset records ORDER BY records.employee_id`,
    [companyId, baselineDate],
  );
  await client.query(
    `UPDATE employees e SET current_version_id = versions.id, updated_at = now()
       FROM employee_versions versions
      WHERE e.company_id = $1 AND versions.company_id = e.company_id
        AND versions.employee_id = e.id AND versions.version = 1`,
    [companyId],
  );
}
