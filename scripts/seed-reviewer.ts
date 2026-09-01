import { compileRule } from '../src/domain/rules.js';
import { loadConfig } from '../src/config.js';
import { createPool, inTransaction, type DbClient } from '../src/db.js';
import { insertRuleDependencies } from '../src/api/helpers.js';
import { NYC_DATASET_ID, NYC_EVALUATION_TENANT_KEY, NYC_IMPORT_COUNT } from '../src/eval/nyc.js';
import {
  REVIEWER_POLICY_CONFIGURATION_LABEL,
  REVIEWER_WORKSPACE_NAME,
  reviewerCategories,
  reviewerGroups,
  reviewerPolicies,
  reviewerRules,
  type ReviewerObservedFacts,
} from '../src/reviewer/workspace.js';
import { enqueueJob } from '../src/services/jobs.js';
import { ReconciliationWorker } from '../src/services/worker.js';

interface SourceImport {
  source_company_id: string;
  source_import_id: string;
  imported_rows: number;
  checksum: string;
  fiscal_year: string;
}

interface ReviewerWorkspace {
  company_id: string;
  source_import_id: string;
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
          ORDER BY completed_at DESC, id DESC
          LIMIT 1
       ) imported ON true
      WHERE evaluation.key = $1`,
    [NYC_EVALUATION_TENANT_KEY, NYC_DATASET_ID],
  );
  const source = result.rows[0];
  if (source === undefined) {
    throw new Error('NYC source facts are not present in PostgreSQL; run npm run data:nyc once before seeding the reviewer workspace');
  }
  if (source.imported_rows !== NYC_IMPORT_COUNT || !/^\d{4}$/.test(source.fiscal_year)) {
    throw new Error(`NYC source import must contain exactly ${NYC_IMPORT_COUNT.toLocaleString()} rows with fiscal-year provenance`);
  }
  const records = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM employee_import_records
      WHERE company_id = $1 AND import_id = $2`,
    [source.source_company_id, source.source_import_id],
  );
  if (records.rows[0]?.count !== NYC_IMPORT_COUNT) {
    throw new Error(`NYC source provenance contains ${records.rows[0]?.count ?? 0} employee records; expected ${NYC_IMPORT_COUNT}`);
  }
  return source;
}

async function observedFacts(source: SourceImport): Promise<ReviewerObservedFacts> {
  const values = async (path: 'employmentType' | 'location' | 'department'): Promise<string[]> => {
    const result = await pool.query<{ value: string }>(
      `SELECT normalized_facts ->> $3 AS value
         FROM employee_import_records
        WHERE company_id = $1 AND import_id = $2
          AND NULLIF(normalized_facts ->> $3, '') IS NOT NULL
        GROUP BY normalized_facts ->> $3
        ORDER BY count(*) DESC, normalized_facts ->> $3`,
      [source.source_company_id, source.source_import_id, path],
    );
    return result.rows.map((row) => row.value);
  };
  const [employmentTypes, locations, departments] = await Promise.all([
    values('employmentType'),
    values('location'),
    values('department'),
  ]);
  if (employmentTypes.length === 0 || locations.length === 0 || departments.length === 0) {
    throw new Error('NYC source facts do not contain the distributions needed for reviewer policy configuration');
  }
  return {
    employmentTypes,
    primaryLocation: locations[0]!,
    secondaryLocation: locations[1] ?? null,
    primaryDepartment: departments[0]!,
  };
}

async function findReviewerWorkspace(): Promise<ReviewerWorkspace | null> {
  const result = await pool.query<ReviewerWorkspace>(
    `SELECT company_id, source_import_id
       FROM reviewer_workspaces
      WHERE dataset_id = $1
      ORDER BY created_at, company_id
      LIMIT 1`,
    [NYC_DATASET_ID],
  );
  return result.rows[0] ?? null;
}

async function verifyReviewerWorkspace(companyId: string): Promise<void> {
  const result = await pool.query<{
    employees: number;
    imported_records: number;
    imported_version_ones: number;
    categories: number;
    policies: number;
    rules: number;
    dead_jobs: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM employees WHERE company_id = $1) AS employees,
       (SELECT count(*)::int FROM employee_import_records WHERE company_id = $1) AS imported_records,
       (SELECT count(*)::int FROM employee_versions
         WHERE company_id = $1 AND version = 1 AND created_by = 'nyc-open-data-reviewer-copy') AS imported_version_ones,
       (SELECT count(*)::int FROM policy_categories WHERE company_id = $1) AS categories,
       (SELECT count(*)::int FROM policies WHERE company_id = $1) AS policies,
       (SELECT count(*)::int FROM rules WHERE company_id = $1) AS rules,
       (SELECT count(*)::int FROM reconciliation_jobs WHERE company_id = $1 AND status = 'DEAD') AS dead_jobs`,
    [companyId],
  );
  const row = result.rows[0]!;
  if (
    row.employees < NYC_IMPORT_COUNT
    || row.imported_records !== NYC_IMPORT_COUNT
    || row.imported_version_ones !== NYC_IMPORT_COUNT
    || row.categories < reviewerCategories.length
    || row.policies < reviewerPolicies.length
    || row.rules < 7
    || row.dead_jobs !== 0
  ) {
    throw new Error(`${REVIEWER_WORKSPACE_NAME} exists but is incomplete; preserve it for diagnosis rather than overwriting reviewer edits`);
  }
}

async function createReviewerWorkspace(source: SourceImport, facts: ReviewerObservedFacts): Promise<string> {
  return inTransaction(pool, async (client) => {
    await client.query(
      `DELETE FROM companies legacy
        WHERE legacy.name = 'Policy Assignment Demo'
          AND NOT EXISTS (SELECT 1 FROM evaluation_tenants evaluation WHERE evaluation.company_id = legacy.id)`,
    );
    const conflicting = await client.query<{ id: string }>(
      `SELECT id FROM companies
        WHERE name = $1
          AND NOT EXISTS (SELECT 1 FROM reviewer_workspaces reviewer WHERE reviewer.company_id = companies.id)
        FOR UPDATE`,
      [REVIEWER_WORKSPACE_NAME],
    );
    if (conflicting.rowCount !== 0) {
      throw new Error(`A non-reviewer company already uses the name ${REVIEWER_WORKSPACE_NAME}`);
    }
    const company = await client.query<{ id: string }>(
      'INSERT INTO companies (name) VALUES ($1) RETURNING id',
      [REVIEWER_WORKSPACE_NAME],
    );
    const companyId = company.rows[0]!.id;
    const reviewerImport = await client.query<{ id: string }>(
      `INSERT INTO dataset_imports
         (company_id, dataset_id, source_url, source_query, fetched_at, completed_at,
          requested_rows, fetched_rows, imported_rows, skipped_rows, checksum, skipped_reasons, metadata)
       SELECT $1, dataset_id, source_url, source_query, fetched_at, now(),
              requested_rows, fetched_rows, imported_rows, skipped_rows, checksum, skipped_reasons,
              metadata || jsonb_build_object(
                'purpose', 'reviewer-workspace',
                'sourceImportId', id,
                'policyConfiguration', $3::text
              )
         FROM dataset_imports
        WHERE company_id = $2 AND id = $4
       RETURNING id`,
      [companyId, source.source_company_id, REVIEWER_POLICY_CONFIGURATION_LABEL, source.source_import_id],
    );
    const reviewerImportId = reviewerImport.rows[0]?.id;
    if (reviewerImportId === undefined) throw new Error('NYC source import disappeared while creating the reviewer workspace');
    await client.query(
      `INSERT INTO reviewer_workspaces
         (company_id, source_company_id, source_import_id, reviewer_import_id,
          dataset_id, imported_employee_count, policy_configuration_kind)
       VALUES ($1, $2, $3, $4, $5, $6, 'EVALUATION_DEMONSTRATION')`,
      [companyId, source.source_company_id, source.source_import_id, reviewerImportId, NYC_DATASET_ID, NYC_IMPORT_COUNT],
    );
    await copyImportedEmployees(client, companyId, reviewerImportId, source);
    await createPolicyConfiguration(client, companyId, `${source.fiscal_year}-06-30`, facts);
    await enqueueJob(client, {
      companyId,
      eventType: 'REVIEWER_WORKSPACE_INITIALIZED',
      scope: 'FULL',
      payload: {
        datasetId: NYC_DATASET_ID,
        sourceImportId: source.source_import_id,
        importedEmployees: NYC_IMPORT_COUNT,
        policyConfiguration: 'EVALUATION_DEMONSTRATION',
      },
      dedupeKey: `reviewer-workspace:${source.source_import_id}:${source.checksum}`,
      priority: 100,
    });
    return companyId;
  });
}

async function copyImportedEmployees(
  client: DbClient,
  companyId: string,
  reviewerImportId: string,
  source: SourceImport,
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
            records.normalized_facts ->> 'employmentType',
            false,
            (records.normalized_facts ->> 'hireDate')::date,
            records.normalized_facts -> 'attributes',
            ARRAY['created', 'dataset_import'],
            'nyc-open-data-reviewer-copy'
       FROM employee_import_records records
       JOIN employees employee
         ON employee.company_id = $1
        AND employee.external_id = records.normalized_facts ->> 'externalId'
      WHERE records.company_id = $2 AND records.import_id = $3
      ORDER BY employee.id`,
    [companyId, source.source_company_id, source.source_import_id, `${source.fiscal_year}-06-30`],
  );
  await client.query(
    `UPDATE employees employee
        SET current_version_id = version.id, updated_at = now()
       FROM employee_versions version
      WHERE employee.company_id = $1
        AND version.company_id = employee.company_id
        AND version.employee_id = employee.id
        AND version.version = 1`,
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
         ON employee.company_id = $1
        AND employee.external_id = records.normalized_facts ->> 'externalId'
      WHERE records.company_id = $3 AND records.import_id = $4
      ORDER BY employee.id`,
    [companyId, reviewerImportId, source.source_company_id, source.source_import_id],
  );
}

async function createPolicyConfiguration(
  client: DbClient,
  companyId: string,
  validFrom: string,
  facts: ReviewerObservedFacts,
): Promise<void> {
  const categoryIds = new Map<string, string>();
  for (const category of reviewerCategories) {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO policy_categories (company_id, key, name, cardinality)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [companyId, category.key, category.name, category.cardinality],
    );
    categoryIds.set(category.key, inserted.rows[0]!.id);
  }
  const policyIds = new Map<string, string>();
  for (const policy of reviewerPolicies) {
    const identity = await client.query<{ id: string }>(
      `INSERT INTO policies (company_id, category_id, key)
       VALUES ($1, $2, $3) RETURNING id`,
      [companyId, categoryIds.get(policy.category), policy.key],
    );
    const policyId = identity.rows[0]!.id;
    const version = await client.query<{ id: string }>(
      `INSERT INTO policy_versions
         (company_id, policy_id, version, valid_from, name, description, enabled, metadata)
       VALUES ($1, $2, 1, $3::date, $4, $5, true,
               jsonb_build_object(
                 'configurationKind', 'EVALUATION_DEMONSTRATION',
                 'notOfficialNycPolicy', true
               ))
       RETURNING id`,
      [companyId, policyId, validFrom, policy.name, policy.description],
    );
    await client.query(
      'UPDATE policies SET current_version_id = $3 WHERE company_id = $1 AND id = $2',
      [companyId, policyId, version.rows[0]!.id],
    );
    policyIds.set(policy.key, policyId);
  }
  const groupIds = new Map<string, string>();
  for (const group of reviewerGroups) {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO groups (company_id, slug, name, description)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [companyId, group.key, group.name, `${group.description} Source value: ${facts.primaryDepartment}.`],
    );
    groupIds.set(group.key, inserted.rows[0]!.id);
  }
  await client.query(
    `INSERT INTO group_memberships
       (company_id, group_id, employee_id, valid_from, created_by)
     SELECT $1, $2, employee.id, $3::date, 'nyc-open-data-reviewer-copy'
       FROM employees employee
       JOIN employee_versions version
         ON version.company_id = employee.company_id AND version.id = employee.current_version_id
      WHERE employee.company_id = $1 AND version.department = $4
      ORDER BY employee.id`,
    [companyId, groupIds.get('demo-observed-department-cohort'), validFrom, facts.primaryDepartment],
  );
  for (const rule of reviewerRules(facts, groupIds)) {
    const compiled = compileRule(rule.condition);
    const identity = await client.query<{ id: string }>(
      'INSERT INTO rules (company_id, key) VALUES ($1, $2) RETURNING id',
      [companyId, rule.key],
    );
    const version = await client.query<{ id: string }>(
      `INSERT INTO rule_versions
         (company_id, rule_id, policy_id, version, status, priority, enabled,
          valid_from, valid_to, condition, specificity, content_hash, published_at)
       VALUES ($1, $2, $3, 1, 'PUBLISHED', $4, true,
               $5::date, NULL, $6::jsonb, $7, $8, now())
       RETURNING id`,
      [
        companyId,
        identity.rows[0]!.id,
        policyIds.get(rule.policy),
        rule.priority,
        validFrom,
        JSON.stringify(compiled.condition),
        compiled.specificity,
        compiled.contentHash,
      ],
    );
    await client.query(
      'UPDATE rules SET current_version_id = $3 WHERE company_id = $1 AND id = $2',
      [companyId, identity.rows[0]!.id, version.rows[0]!.id],
    );
    await insertRuleDependencies(client, companyId, version.rows[0]!.id, compiled.dependencies);
  }
}

async function drainReviewerJobs(companyId: string): Promise<number> {
  const worker = new ReconciliationWorker(pool, config, () => new Date(), companyId);
  let jobs = 0;
  while (await worker.processOne()) {
    jobs += 1;
    if (jobs > 100) throw new Error('Reviewer reconciliation queue did not drain');
  }
  return jobs;
}

try {
  await lockClient.query('SELECT pg_advisory_lock(hashtext($1))', ['nyc-reviewer-workspace-seed']);
  const source = await loadSourceImport();
  const facts = await observedFacts(source);
  await pool.query(
    `DELETE FROM companies legacy
      WHERE legacy.name = 'Policy Assignment Demo'
        AND NOT EXISTS (SELECT 1 FROM evaluation_tenants evaluation WHERE evaluation.company_id = legacy.id)`,
  );
  const existing = await findReviewerWorkspace();
  let companyId: string;
  if (existing !== null) {
    if (existing.source_import_id !== source.source_import_id) {
      throw new Error(`${REVIEWER_WORKSPACE_NAME} points to a different NYC source import; refusing to overwrite reviewer state`);
    }
    companyId = existing.company_id;
    await verifyReviewerWorkspace(companyId);
  } else {
    companyId = await createReviewerWorkspace(source, facts);
  }
  const jobs = await drainReviewerJobs(companyId);
  await verifyReviewerWorkspace(companyId);
  const assignments = await pool.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM materialized_assignments WHERE company_id = $1',
    [companyId],
  );
  if ((assignments.rows[0]?.count ?? 0) === 0) throw new Error('Reviewer workspace has no materialized policy assignments');
  process.stdout.write(
    `${REVIEWER_WORKSPACE_NAME} ready (${companyId}): ${NYC_IMPORT_COUNT.toLocaleString()} imported NYC employee facts, `
    + `${reviewerPolicies.length} demonstration policies, ${jobs} reconciliation jobs processed.\n`,
  );
} finally {
  await lockClient.query('SELECT pg_advisory_unlock(hashtext($1))', ['nyc-reviewer-workspace-seed']).catch(() => undefined);
  lockClient.release();
  await pool.end();
}
