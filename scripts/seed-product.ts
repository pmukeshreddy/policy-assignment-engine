import { loadConfig } from '../src/config.js';
import { createPool, inTransaction, type DbClient } from '../src/db.js';
import {
  CERTIFIED_RULE_COUNT,
  CERTIFIED_RULE_SEED,
  certifiedBaselineSemantics,
  createCertifiedBaseline,
} from '../src/baseline/certified-universe.js';
import { NYC_DATASET_ID, NYC_EVALUATION_TENANT_KEY, NYC_IMPORT_COUNT } from '../src/eval/nyc.js';
import { enqueueJob } from '../src/services/jobs.js';
import { ReconciliationWorker } from '../src/services/worker.js';

const PRODUCT_WORKSPACE_NAME = 'NYC Open Data Policy Workspace';

interface SourceImport {
  source_company_id: string;
  source_import_id: string;
  imported_rows: number;
  checksum: string;
  fiscal_year: string;
}

interface ProductWorkspace {
  company_id: string;
  source_import_id: string;
  baseline_fingerprint: string | null;
}

const config = loadConfig();
const pool = createPool(config);
const lockClient = await pool.connect();

async function loadSourceImport(): Promise<SourceImport> {
  const result = await pool.query<SourceImport>(
    `SELECT evaluation.company_id AS source_company_id,
            imported.id AS source_import_id,
            imported.imported_rows,
            imported.checksum,
            imported.metadata ->> 'fiscalYear' AS fiscal_year
       FROM evaluation_tenants evaluation
       JOIN LATERAL (
         SELECT id, imported_rows, checksum, metadata
           FROM dataset_imports
          WHERE company_id = evaluation.company_id AND dataset_id = $2
          ORDER BY completed_at DESC, id DESC LIMIT 1
       ) imported ON true
      WHERE evaluation.key = $1`,
    [NYC_EVALUATION_TENANT_KEY, NYC_DATASET_ID],
  );
  const source = result.rows[0];
  if (source === undefined) {
    throw new Error('NYC source facts are not present in PostgreSQL; run npm run data:nyc once before seeding the product workspace');
  }
  if (source.imported_rows !== NYC_IMPORT_COUNT || !/^\d{4}$/.test(source.fiscal_year)) {
    throw new Error(`NYC source import must contain exactly ${NYC_IMPORT_COUNT.toLocaleString()} rows with fiscal-year provenance`);
  }
  const records = await pool.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM employee_import_records WHERE company_id = $1 AND import_id = $2',
    [source.source_company_id, source.source_import_id],
  );
  if (records.rows[0]?.count !== NYC_IMPORT_COUNT) {
    throw new Error(`NYC source provenance contains ${records.rows[0]?.count ?? 0} employee records; expected ${NYC_IMPORT_COUNT}`);
  }
  return source;
}

async function findProductWorkspace(): Promise<ProductWorkspace | null> {
  const result = await pool.query<ProductWorkspace>(
    `SELECT company_id, source_import_id, baseline_fingerprint
       FROM product_workspaces
      WHERE dataset_id = $1
      ORDER BY created_at, company_id LIMIT 1`,
    [NYC_DATASET_ID],
  );
  return result.rows[0] ?? null;
}

async function removeObsoleteWorkspace(companyId: string): Promise<void> {
  await inTransaction(pool, async (client) => {
    const workspace = await client.query<{ baseline_fingerprint: string | null }>(
      'SELECT baseline_fingerprint FROM product_workspaces WHERE company_id = $1 FOR UPDATE', [companyId],
    );
    if (workspace.rows[0]?.baseline_fingerprint !== null) {
      throw new Error('Refusing to replace an initialized product workspace');
    }
    await client.query('DELETE FROM companies WHERE id = $1', [companyId]);
  });
}

async function createProductWorkspace(source: SourceImport): Promise<string> {
  return inTransaction(pool, async (client) => {
    await client.query(
      `DELETE FROM companies legacy
        WHERE legacy.name = 'Policy Assignment Demo'
          AND NOT EXISTS (SELECT 1 FROM evaluation_tenants evaluation WHERE evaluation.company_id = legacy.id)`,
    );
    const conflicting = await client.query<{ id: string }>(
      `SELECT id FROM companies
        WHERE name = $1
          AND NOT EXISTS (SELECT 1 FROM product_workspaces workspace WHERE workspace.company_id = companies.id)
        FOR UPDATE`,
      [PRODUCT_WORKSPACE_NAME],
    );
    if (conflicting.rowCount !== 0) throw new Error(`A standard company already uses the name ${PRODUCT_WORKSPACE_NAME}`);
    const company = await client.query<{ id: string }>(
      'INSERT INTO companies (name) VALUES ($1) RETURNING id', [PRODUCT_WORKSPACE_NAME],
    );
    const companyId = company.rows[0]!.id;
    const productImport = await client.query<{ id: string }>(
      `INSERT INTO dataset_imports
         (company_id, dataset_id, source_url, source_query, fetched_at, completed_at,
          requested_rows, fetched_rows, imported_rows, skipped_rows, checksum, skipped_reasons, metadata)
       SELECT $1, dataset_id, source_url, source_query, fetched_at, now(),
              requested_rows, fetched_rows, imported_rows, skipped_rows, checksum, skipped_reasons,
              metadata || jsonb_build_object(
                'purpose', 'product-workspace',
                'sourceImportId', id,
                'semanticBaseline', 'certified-production-baseline'
              )
         FROM dataset_imports
        WHERE company_id = $2 AND id = $3
       RETURNING id`,
      [companyId, source.source_company_id, source.source_import_id],
    );
    const productImportId = productImport.rows[0]?.id;
    if (productImportId === undefined) throw new Error('NYC source import disappeared while creating the product workspace');
    await client.query(
      `INSERT INTO product_workspaces
         (company_id, source_company_id, source_import_id, product_import_id,
          dataset_id, imported_employee_count)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [companyId, source.source_company_id, source.source_import_id, productImportId, NYC_DATASET_ID, NYC_IMPORT_COUNT],
    );
    const baselineDate = `${source.fiscal_year}-06-30`;
    await copyImportedEmployees(client, companyId, productImportId, source, baselineDate);
    const baseline = await createCertifiedBaseline(client, {
      companyId,
      baselineDate,
      idNamespace: `product:${companyId}`,
      createdBy: 'nyc-open-data-product-baseline',
      ruleCount: CERTIFIED_RULE_COUNT,
    });
    const semantics = await certifiedBaselineSemantics(client, companyId);
    await client.query(
      `UPDATE product_workspaces
          SET baseline_fingerprint = $2, baseline_rule_seed = $3,
              baseline_rule_count = $4, baseline_created_at = now()
        WHERE company_id = $1`,
      [companyId, semantics.fingerprint, CERTIFIED_RULE_SEED, baseline.ruleCount],
    );
    await enqueueJob(client, {
      companyId,
      eventType: 'PRODUCT_BASELINE_INITIALIZED',
      scope: 'FULL',
      payload: {
        datasetId: NYC_DATASET_ID,
        sourceImportId: source.source_import_id,
        importedEmployees: NYC_IMPORT_COUNT,
        semanticFingerprint: semantics.fingerprint,
        ruleSeed: CERTIFIED_RULE_SEED,
        ruleCount: baseline.ruleCount,
      },
      dedupeKey: `product-baseline:${source.source_import_id}:${source.checksum}:${semantics.fingerprint}`,
      priority: 100,
    });
    return companyId;
  });
}

async function copyImportedEmployees(
  client: DbClient,
  companyId: string,
  productImportId: string,
  source: SourceImport,
  baselineDate: string,
): Promise<void> {
  await client.query(
    `INSERT INTO employees (company_id, external_id)
     SELECT $1, records.normalized_facts ->> 'externalId'
       FROM employee_import_records records
      WHERE records.company_id = $2 AND records.import_id = $3
      ORDER BY records.source_row_id`,
    [companyId, source.source_company_id, source.source_import_id],
  );
  await client.query(
    `INSERT INTO employee_versions
       (company_id, employee_id, version, valid_from, display_name, location, department,
        employment_type, is_manager, hire_date, attributes, changed_fields, created_by)
     SELECT $1, employee.id, 1, $4::date,
            records.normalized_facts ->> 'displayName',
            records.normalized_facts ->> 'location',
            records.normalized_facts ->> 'department',
            records.normalized_facts ->> 'employmentType', false,
            (records.normalized_facts ->> 'hireDate')::date,
            records.normalized_facts -> 'attributes',
            ARRAY['created', 'dataset_import'], 'nyc-open-data-product-baseline'
       FROM employee_import_records records
       JOIN employees employee
         ON employee.company_id = $1 AND employee.external_id = records.normalized_facts ->> 'externalId'
      WHERE records.company_id = $2 AND records.import_id = $3
      ORDER BY employee.id`,
    [companyId, source.source_company_id, source.source_import_id, baselineDate],
  );
  await client.query(
    `UPDATE employees employee SET current_version_id = version.id, updated_at = now()
       FROM employee_versions version
      WHERE employee.company_id = $1 AND version.company_id = employee.company_id
        AND version.employee_id = employee.id AND version.version = 1`,
    [companyId],
  );
  await client.query(
    `INSERT INTO employee_import_records
       (company_id, employee_id, import_id, dataset_id, source_row_id,
        source_record_checksum, normalized_facts)
     SELECT $1, employee.id, $2, records.dataset_id, records.source_row_id,
            records.source_record_checksum, records.normalized_facts
       FROM employee_import_records records
       JOIN employees employee
         ON employee.company_id = $1 AND employee.external_id = records.normalized_facts ->> 'externalId'
      WHERE records.company_id = $3 AND records.import_id = $4
      ORDER BY employee.id`,
    [companyId, productImportId, source.source_company_id, source.source_import_id],
  );
}

async function verifyProductWorkspace(companyId: string): Promise<void> {
  const result = await pool.query<{
    employees: number; imported_records: number; imported_version_ones: number;
    categories: number; policies: number; rules: number; groups: number; dead_jobs: number;
    baseline_fingerprint: string | null; baseline_rule_seed: number | null; baseline_rule_count: number | null;
  }>(
    `SELECT
       (SELECT count(*)::int FROM employees WHERE company_id = $1) AS employees,
       (SELECT count(*)::int FROM employee_import_records WHERE company_id = $1) AS imported_records,
       (SELECT count(*)::int FROM employee_versions
         WHERE company_id = $1 AND version = 1 AND created_by = 'nyc-open-data-product-baseline') AS imported_version_ones,
       (SELECT count(*)::int FROM policy_categories WHERE company_id = $1) AS categories,
       (SELECT count(*)::int FROM policies WHERE company_id = $1) AS policies,
       (SELECT count(*)::int FROM rules WHERE company_id = $1) AS rules,
       (SELECT count(*)::int FROM groups WHERE company_id = $1) AS groups,
       (SELECT count(*)::int FROM reconciliation_jobs WHERE company_id = $1 AND status = 'DEAD') AS dead_jobs,
       workspace.baseline_fingerprint, workspace.baseline_rule_seed, workspace.baseline_rule_count
      FROM product_workspaces workspace WHERE workspace.company_id = $1`,
    [companyId],
  );
  const row = result.rows[0];
  if (row === undefined
    || row.employees < NYC_IMPORT_COUNT
    || row.imported_records !== NYC_IMPORT_COUNT
    || row.imported_version_ones !== NYC_IMPORT_COUNT
    || row.categories < 6 || row.policies < 48 || row.rules < CERTIFIED_RULE_COUNT || row.groups < 8
    || row.dead_jobs !== 0 || row.baseline_fingerprint === null
    || row.baseline_rule_seed !== CERTIFIED_RULE_SEED || row.baseline_rule_count !== CERTIFIED_RULE_COUNT) {
    throw new Error(`${PRODUCT_WORKSPACE_NAME} exists but its certified product baseline is incomplete`);
  }
}

async function drainProductJobs(companyId: string): Promise<number> {
  const worker = new ReconciliationWorker(pool, config, () => new Date(), companyId);
  let jobs = 0;
  while (await worker.processOne()) {
    jobs += 1;
    if (jobs > 100) throw new Error('Product reconciliation queue did not drain');
  }
  return jobs;
}

try {
  await lockClient.query('SELECT pg_advisory_lock(hashtext($1))', ['nyc-product-workspace-seed']);
  const source = await loadSourceImport();
  let existing = await findProductWorkspace();
  if (existing !== null && existing.baseline_fingerprint === null) {
    await removeObsoleteWorkspace(existing.company_id);
    existing = null;
  }
  let companyId: string;
  if (existing === null) {
    companyId = await createProductWorkspace(source);
  } else {
    if (existing.source_import_id !== source.source_import_id) {
      throw new Error(`${PRODUCT_WORKSPACE_NAME} points to a different NYC source import; refusing to overwrite product edits`);
    }
    companyId = existing.company_id;
  }
  await verifyProductWorkspace(companyId);
  const jobs = await drainProductJobs(companyId);
  await verifyProductWorkspace(companyId);
  const assignments = await pool.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM materialized_assignments WHERE company_id = $1', [companyId],
  );
  if ((assignments.rows[0]?.count ?? 0) === 0) throw new Error('Product workspace has no materialized policy assignments');
  process.stdout.write(
    `${PRODUCT_WORKSPACE_NAME} ready (${companyId}): ${NYC_IMPORT_COUNT.toLocaleString()} imported NYC employee facts, `
    + `6 categories, 48 policies, ${CERTIFIED_RULE_COUNT} certified-baseline rules, ${jobs} reconciliation jobs processed.\n`,
  );
} finally {
  await lockClient.query('SELECT pg_advisory_unlock(hashtext($1))', ['nyc-product-workspace-seed']).catch(() => undefined);
  lockClient.release();
  await pool.end();
}
