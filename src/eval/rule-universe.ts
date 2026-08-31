import type { DbClient, DbPool } from '../db.js';
import { inTransaction } from '../db.js';
import { compileRule, type RuleCondition } from '../domain/rules.js';
import { insertRuleDependencies } from '../api/helpers.js';
import { enqueueJob } from '../services/jobs.js';
import { deterministicUuid } from './deterministic.js';
import { NYC_DATASET_ID, NYC_EVALUATION_TENANT_KEY, NYC_IMPORT_COUNT } from './nyc.js';

export const EVALUATION_RULE_SEED = 482_901;
export const EVALUATION_RULE_COUNT = 300;

interface DistributionValue {
  value: string;
  count: number;
}

interface ObservedDistribution {
  departments: DistributionValue[];
  locations: DistributionValue[];
  employmentTypes: DistributionValue[];
  jobTitles: DistributionValue[];
  employmentStatuses: DistributionValue[];
  tenureThresholds: number[];
}

export interface EvaluationCategory {
  id: string;
  key: string;
  cardinality: 'SINGLE' | 'MULTIPLE';
  policyIds: string[];
}

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

const categoryDefinitions = [
  { key: 'eval-department-placement', cardinality: 'SINGLE' as const },
  { key: 'eval-location-compliance', cardinality: 'MULTIPLE' as const },
  { key: 'eval-employment-program', cardinality: 'SINGLE' as const },
  { key: 'eval-title-access', cardinality: 'MULTIPLE' as const },
  { key: 'eval-tenure-benefit', cardinality: 'SINGLE' as const },
  { key: 'eval-cross-functional', cardinality: 'MULTIPLE' as const },
] as const;

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
      'policy-regression-universe',
      NYC_DATASET_ID,
    ]);
    const tenant = await client.query<{ company_id: string }>(
      'SELECT company_id FROM evaluation_tenants WHERE key = $1 FOR UPDATE',
      [NYC_EVALUATION_TENANT_KEY],
    );
    const companyId = tenant.rows[0]?.company_id;
    if (companyId === undefined) throw new Error('NYC data is not imported; run npm run data:nyc first');
    const latestImport = await client.query<{
      id: string;
      checksum: string;
      imported_rows: number;
      fiscal_year: string;
    }>(
      `SELECT id, checksum, imported_rows, metadata ->> 'fiscalYear' AS fiscal_year
         FROM dataset_imports
        WHERE company_id = $1 AND dataset_id = $2
        ORDER BY completed_at DESC, id DESC
        LIMIT 1`,
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
    const distribution = await observedDistribution(client, companyId, baselineDate);
    const groupIds = await createObservedGroups(client, companyId, baselineDate, distribution);
    const categories = await createPolicies(client, companyId, baselineDate);
    const rulesPerCategory = Math.floor(ruleCount / categories.length);
    let createdRules = 0;
    for (let categoryIndex = 0; categoryIndex < categories.length; categoryIndex += 1) {
      const category = categories[categoryIndex]!;
      const categoryRuleCount = rulesPerCategory + (categoryIndex < ruleCount % categories.length ? 1 : 0);
      for (let index = 0; index < categoryRuleCount; index += 1) {
        const condition = evaluationCondition(categoryIndex, index, distribution, groupIds);
        const priority = ((index * 17 + categoryIndex * 13) % 101) - 20;
        const enabled = index % 37 !== 0;
        const validFrom = baselineDate;
        await insertEvaluationRule(client, {
          companyId,
          category,
          categoryIndex,
          index,
          priority,
          enabled,
          validFrom,
          condition,
        });
        createdRules += 1;
      }
    }
    const initialJobId = await enqueueJob(client, {
      companyId,
      eventType: 'EVALUATION_UNIVERSE_REBUILT',
      scope: 'FULL',
      payload: {
        datasetId: NYC_DATASET_ID,
        importId: imported.id,
        datasetChecksum: imported.checksum,
        ruleSeed: EVALUATION_RULE_SEED,
        ruleCount: createdRules,
      },
      dedupeKey: `evaluation-universe:${imported.id}:${imported.checksum}:${EVALUATION_RULE_SEED}:${createdRules}`,
      priority: 100,
    });
    return {
      companyId,
      importId: imported.id,
      datasetChecksum: imported.checksum,
      baselineDate,
      employeeCount: imported.imported_rows,
      ruleCount: createdRules,
      categories,
      groupIds,
      initialJobId,
    };
  });
}

/**
 * Loads a previously built, mutation-free evaluation universe and makes its baseline
 * FULL job eligible for an idempotent retry. This exists so a long certified run can
 * resume after a process or machine interruption without refetching NYC data or
 * rebuilding deterministic source state.
 */
export async function resumePreparedEvaluationUniverse(
  pool: DbPool,
  input: { ruleCount?: number; expectedEmployees?: number } = {},
): Promise<EvaluationUniverse> {
  const expectedRuleCount = input.ruleCount ?? EVALUATION_RULE_COUNT;
  const expectedEmployees = input.expectedEmployees ?? NYC_IMPORT_COUNT;
  return inTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
      'policy-regression-universe',
      NYC_DATASET_ID,
    ]);
    const tenant = await client.query<{ company_id: string }>(
      'SELECT company_id FROM evaluation_tenants WHERE key = $1 FOR UPDATE',
      [NYC_EVALUATION_TENANT_KEY],
    );
    const companyId = tenant.rows[0]?.company_id;
    if (companyId === undefined) throw new Error('NYC data is not imported; run npm run data:nyc first');
    const importedResult = await client.query<{
      id: string;
      checksum: string;
      imported_rows: number;
      fiscal_year: string;
    }>(
      `SELECT id, checksum, imported_rows, metadata ->> 'fiscalYear' AS fiscal_year
         FROM dataset_imports
        WHERE company_id = $1 AND dataset_id = $2
        ORDER BY completed_at DESC, id DESC
        LIMIT 1`,
      [companyId, NYC_DATASET_ID],
    );
    const imported = importedResult.rows[0];
    if (imported === undefined || !/^\d{4}$/.test(imported.fiscal_year)) {
      throw new Error('NYC import provenance is missing or invalid');
    }
    const baselineDate = `${imported.fiscal_year}-06-30`;
    const sourceState = await client.query<{
      employees: number;
      non_baseline_versions: number;
      manual_overrides: number;
      rules: number;
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
      id: string;
      key: string;
      cardinality: 'SINGLE' | 'MULTIPLE';
      policy_ids: string[];
    }>(
      `SELECT pc.id, pc.key, pc.cardinality,
              array_agg(p.id::text ORDER BY p.key) AS policy_ids
         FROM policy_categories pc
         JOIN policies p ON p.company_id = pc.company_id AND p.category_id = pc.id
        WHERE pc.company_id = $1 AND pc.key = ANY($2::text[])
        GROUP BY pc.id, pc.key, pc.cardinality`,
      [companyId, categoryDefinitions.map((definition) => definition.key)],
    );
    const byKey = new Map(categoryResult.rows.map((row) => [row.key, row]));
    const categories = categoryDefinitions.map((definition) => {
      const row = byKey.get(definition.key);
      if (row === undefined || row.cardinality !== definition.cardinality || row.policy_ids.length !== 8) {
        throw new Error(`Prepared evaluation category ${definition.key} is missing or invalid`);
      }
      return { id: row.id, key: row.key, cardinality: row.cardinality, policyIds: row.policy_ids };
    });
    const groups = await client.query<{ id: string }>(
      `SELECT id
         FROM groups
        WHERE company_id = $1 AND slug LIKE 'eval-observed-department-%'
        ORDER BY slug`,
      [companyId],
    );
    if (groups.rows.length !== 8) throw new Error('Prepared evaluation universe must contain exactly eight observed cohort groups');
    const jobs = await client.query<{ id: string; active_jobs: number }>(
      `WITH baseline AS (
         SELECT id
           FROM reconciliation_jobs
          WHERE company_id = $1 AND event_type = 'EVALUATION_UNIVERSE_REBUILT' AND scope = 'FULL'
          ORDER BY created_at DESC, id DESC
          LIMIT 1
       )
       SELECT baseline.id,
              (SELECT count(*)::int
                 FROM reconciliation_jobs jobs
                WHERE jobs.company_id = $1
                  AND jobs.id <> baseline.id
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
     SELECT e.id AS employee_id,
            e.external_id,
            records.dataset_id,
            records.source_row_id,
            records.source_record_checksum,
            records.normalized_facts
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
     SELECT $1,
            records.employee_id,
            1,
            $2::date,
            records.normalized_facts ->> 'displayName',
            records.normalized_facts ->> 'location',
            records.normalized_facts ->> 'department',
            records.normalized_facts ->> 'employmentType',
            false,
            (records.normalized_facts ->> 'hireDate')::date,
            records.normalized_facts -> 'attributes',
            ARRAY['evaluation_reset'],
            'policy-regression-eval'
       FROM evaluation_employee_reset records
      ORDER BY records.employee_id`,
    [companyId, baselineDate],
  );
  await client.query(
    `UPDATE employees e
        SET current_version_id = versions.id, updated_at = now()
       FROM employee_versions versions
      WHERE e.company_id = $1
        AND versions.company_id = e.company_id
        AND versions.employee_id = e.id
        AND versions.version = 1`,
    [companyId],
  );
}

async function observedDistribution(client: DbClient, companyId: string, asOfDate: string): Promise<ObservedDistribution> {
  const departments = await distributionQuery(client, companyId, asOfDate, 'ev.department', 40);
  const locations = await distributionQuery(client, companyId, asOfDate, 'ev.location', 20);
  const employmentTypes = await distributionQuery(client, companyId, asOfDate, 'ev.employment_type', 20);
  const jobTitles = await distributionQuery(client, companyId, asOfDate, `ev.attributes ->> 'job_title'`, 80);
  const employmentStatuses = await distributionQuery(client, companyId, asOfDate, `ev.attributes ->> 'employment_status'`, 20);
  const tenure = await client.query<{ percentile: string }>(
    `SELECT percentile_disc(percentile) WITHIN GROUP (
              ORDER BY GREATEST(0, $2::date - ev.hire_date)
            )::text AS percentile
       FROM employee_versions ev,
            unnest(ARRAY[0.10, 0.25, 0.50, 0.75, 0.90]::double precision[]) percentile
      WHERE ev.company_id = $1
        AND ev.valid_from <= $2::date AND (ev.valid_to IS NULL OR ev.valid_to > $2::date)
        AND ev.hire_date IS NOT NULL
      GROUP BY percentile
      ORDER BY percentile`,
    [companyId, asOfDate],
  );
  const values = { departments, locations, employmentTypes, jobTitles, employmentStatuses };
  for (const [name, distribution] of Object.entries(values)) {
    if (distribution.length === 0) throw new Error(`Imported dataset has no usable ${name} distribution`);
  }
  const tenureThresholds = [...new Set(tenure.rows.map((row) => Number(row.percentile)).filter(Number.isFinite))].sort((a, b) => a - b);
  if (tenureThresholds.length === 0) throw new Error('Imported dataset has no usable tenure distribution');
  return { ...values, tenureThresholds };
}

async function distributionQuery(
  client: DbClient,
  companyId: string,
  asOfDate: string,
  safeExpression: string,
  limit: number,
): Promise<DistributionValue[]> {
  const result = await client.query<{ value: string; count: number }>(
    `SELECT ${safeExpression} AS value, count(*)::int AS count
       FROM employee_versions ev
      WHERE ev.company_id = $1
        AND ev.valid_from <= $2::date AND (ev.valid_to IS NULL OR ev.valid_to > $2::date)
        AND ${safeExpression} IS NOT NULL
      GROUP BY ${safeExpression}
      ORDER BY count(*) DESC, ${safeExpression}
      LIMIT $3`,
    [companyId, asOfDate, limit],
  );
  return result.rows;
}

async function createObservedGroups(
  client: DbClient,
  companyId: string,
  baselineDate: string,
  distribution: ObservedDistribution,
): Promise<string[]> {
  const selected = distribution.departments.slice(0, 8);
  const groupIds: string[] = [];
  for (let index = 0; index < selected.length; index += 1) {
    const department = selected[index]!;
    const groupId = deterministicUuid(`eval:${EVALUATION_RULE_SEED}:group:${index}:${department.value}`);
    groupIds.push(groupId);
    await client.query(
      `INSERT INTO groups (id, company_id, slug, name, description)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        groupId,
        companyId,
        `eval-observed-department-${index + 1}`,
        `Evaluation observed department cohort ${index + 1}`,
        `Evaluation-only cohort derived from an observed department with ${department.count} imported records; not an NYC policy group.`,
      ],
    );
    await client.query(
      `INSERT INTO group_memberships
         (company_id, group_id, employee_id, valid_from, created_by)
       SELECT $1, $2, ev.employee_id, $3::date, 'policy-regression-eval'
         FROM employee_versions ev
        WHERE ev.company_id = $1
          AND ev.valid_from <= $3::date AND (ev.valid_to IS NULL OR ev.valid_to > $3::date)
          AND ev.department = $4
        ORDER BY ev.employee_id`,
      [companyId, groupId, baselineDate, department.value],
    );
  }
  if (groupIds.length === 0) throw new Error('Evaluation requires at least one observed cohort group');
  return groupIds;
}

async function createPolicies(client: DbClient, companyId: string, baselineDate: string): Promise<EvaluationCategory[]> {
  const categories: EvaluationCategory[] = [];
  for (let categoryIndex = 0; categoryIndex < categoryDefinitions.length; categoryIndex += 1) {
    const definition = categoryDefinitions[categoryIndex]!;
    const categoryId = deterministicUuid(`eval:${EVALUATION_RULE_SEED}:category:${definition.key}`);
    await client.query(
      `INSERT INTO policy_categories (id, company_id, key, name, cardinality)
       VALUES ($1, $2, $3, $4, $5)`,
      [categoryId, companyId, definition.key, `Evaluation category ${categoryIndex + 1}`, definition.cardinality],
    );
    const policyIds: string[] = [];
    for (let policyIndex = 0; policyIndex < 8; policyIndex += 1) {
      const policyId = deterministicUuid(`eval:${EVALUATION_RULE_SEED}:policy:${definition.key}:${policyIndex}`);
      const versionId = deterministicUuid(`eval:${EVALUATION_RULE_SEED}:policy-version:${definition.key}:${policyIndex}:1`);
      policyIds.push(policyId);
      await client.query(
        `INSERT INTO policies (id, company_id, category_id, key)
         VALUES ($1, $2, $3, $4)`,
        [policyId, companyId, categoryId, `${definition.key}-option-${policyIndex + 1}`],
      );
      await client.query(
        `INSERT INTO policy_versions
           (id, company_id, policy_id, version, valid_from, name, description, enabled, metadata, created_by)
         VALUES ($1, $2, $3, 1, $4::date, $5, $6, true, $7::jsonb, 'policy-regression-eval')`,
        [
          versionId,
          companyId,
          policyId,
          baselineDate,
          `Evaluation policy ${categoryIndex + 1}.${policyIndex + 1}`,
          'Evaluation-only policy generated for engine regression coverage; not an actual NYC policy.',
          JSON.stringify({ evaluationOnly: true, actualNycPolicy: false, datasetId: NYC_DATASET_ID, ruleSeed: EVALUATION_RULE_SEED }),
        ],
      );
      await client.query('UPDATE policies SET current_version_id = $3 WHERE company_id = $1 AND id = $2', [
        companyId,
        policyId,
        versionId,
      ]);
    }
    categories.push({ id: categoryId, key: definition.key, cardinality: definition.cardinality, policyIds });
  }
  return categories;
}

function evaluationCondition(
  categoryIndex: number,
  index: number,
  distribution: ObservedDistribution,
  groupIds: readonly string[],
): RuleCondition {
  const department = distribution.departments[index % distribution.departments.length]!.value;
  const location = distribution.locations[index % distribution.locations.length]!.value;
  const employmentType = distribution.employmentTypes[index % distribution.employmentTypes.length]!.value;
  const title = distribution.jobTitles[index % distribution.jobTitles.length]!.value;
  const status = distribution.employmentStatuses[index % distribution.employmentStatuses.length]!.value;
  const tenure = distribution.tenureThresholds[index % distribution.tenureThresholds.length]!;
  const groupId = groupIds[index % groupIds.length]!;
  const employee = (field: 'department' | 'location' | 'employment_type', value: string): RuleCondition => ({
    type: 'comparison', fact: { kind: 'employee', field }, operator: 'EQ', value,
  });
  const attribute = (key: 'job_title' | 'employment_status', value: string): RuleCondition => ({
    type: 'comparison', fact: { kind: 'attribute', key }, operator: 'EQ', value,
  });
  if (categoryIndex === 0) {
    return index % 3 === 0
      ? { type: 'group', groupId, operator: 'MEMBER_OF' }
      : index % 3 === 1
        ? employee('department', department)
        : { type: 'and', conditions: [employee('department', department), attribute('employment_status', status)] };
  }
  if (categoryIndex === 1) {
    const other = distribution.locations[(index + 1) % distribution.locations.length]!.value;
    return index % 2 === 0
      ? employee('location', location)
      : { type: 'comparison', fact: { kind: 'employee', field: 'location' }, operator: 'IN', value: [location, other] };
  }
  if (categoryIndex === 2) {
    return index % 2 === 0
      ? employee('employment_type', employmentType)
      : { type: 'and', conditions: [employee('employment_type', employmentType), attribute('employment_status', status)] };
  }
  if (categoryIndex === 3) {
    const other = distribution.jobTitles[(index + 7) % distribution.jobTitles.length]!.value;
    return index % 2 === 0
      ? attribute('job_title', title)
      : { type: 'or', conditions: [attribute('job_title', title), attribute('job_title', other)] };
  }
  if (categoryIndex === 4) {
    if (index >= 5) {
      return index % 2 === 0
        ? attribute('employment_status', status)
        : employee('employment_type', employmentType);
    }
    return index % 2 === 0
      ? { type: 'comparison', fact: { kind: 'tenure_days' }, operator: 'GTE', value: tenure }
      : {
          type: 'and',
          conditions: [
            { type: 'comparison', fact: { kind: 'tenure_days' }, operator: 'GTE', value: tenure },
            employee('employment_type', employmentType),
          ],
        };
  }
  const variants: RuleCondition[] = [
    { type: 'and', conditions: [employee('department', department), employee('location', location)] },
    { type: 'and', conditions: [attribute('job_title', title), employee('employment_type', employmentType)] },
    { type: 'and', conditions: [{ type: 'group', groupId, operator: 'MEMBER_OF' }, attribute('employment_status', status)] },
    {
      type: 'and',
      conditions: [
        employee('location', location),
        { type: 'comparison', fact: { kind: 'tenure_days' }, operator: 'GTE', value: tenure },
      ],
    },
    { type: 'not', condition: attribute('employment_status', status) },
  ];
  return variants[index % variants.length]!;
}

async function insertEvaluationRule(
  client: DbClient,
  input: {
    companyId: string;
    category: EvaluationCategory;
    categoryIndex: number;
    index: number;
    priority: number;
    enabled: boolean;
    validFrom: string;
    condition: RuleCondition;
  },
): Promise<void> {
  const ruleId = deterministicUuid(`eval:${EVALUATION_RULE_SEED}:rule:${input.category.key}:${input.index}`);
  const versionId = deterministicUuid(`eval:${EVALUATION_RULE_SEED}:rule-version:${input.category.key}:${input.index}:1`);
  const policyId = input.category.policyIds[(input.index * 3 + input.categoryIndex) % input.category.policyIds.length]!;
  const compiled = compileRule(input.condition);
  await client.query(
    `INSERT INTO rules (id, company_id, key, current_version_id)
     VALUES ($1, $2, $3, NULL)`,
    [ruleId, input.companyId, `eval-rule-${input.categoryIndex + 1}-${input.index + 1}`],
  );
  await client.query(
    `INSERT INTO rule_versions
       (id, company_id, rule_id, policy_id, version, status, priority, enabled, valid_from,
        condition, specificity, content_hash, published_at, created_by)
     VALUES ($1, $2, $3, $4, 1, 'PUBLISHED', $5, $6, $7::date,
             $8::jsonb, $9, $10, now(), 'policy-regression-eval')`,
    [
      versionId,
      input.companyId,
      ruleId,
      policyId,
      input.priority,
      input.enabled,
      input.validFrom,
      JSON.stringify(compiled.condition),
      compiled.specificity,
      compiled.contentHash,
    ],
  );
  await insertRuleDependencies(client, input.companyId, versionId, compiled.dependencies);
  await client.query('UPDATE rules SET current_version_id = $3 WHERE company_id = $1 AND id = $2', [
    input.companyId,
    ruleId,
    versionId,
  ]);
}
