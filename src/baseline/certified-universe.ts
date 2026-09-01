import type { DbClient, DbPool } from '../db.js';
import { compileRule, fingerprint, type RuleCondition } from '../domain/rules.js';
import { insertRuleDependencies } from '../api/helpers.js';
import { deterministicUuid } from '../eval/deterministic.js';
import { NYC_DATASET_ID } from '../eval/nyc.js';

export const CERTIFIED_RULE_SEED = 482_901;
export const CERTIFIED_RULE_COUNT = 300;

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

export interface CertifiedCategory {
  id: string;
  key: string;
  cardinality: 'SINGLE' | 'MULTIPLE';
  policyIds: string[];
}

export interface CertifiedBaseline {
  ruleCount: number;
  categories: CertifiedCategory[];
  groupIds: string[];
}

export const certifiedCategoryDefinitions = [
  { key: 'eval-department-placement', cardinality: 'SINGLE' as const },
  { key: 'eval-location-compliance', cardinality: 'MULTIPLE' as const },
  { key: 'eval-employment-program', cardinality: 'SINGLE' as const },
  { key: 'eval-title-access', cardinality: 'MULTIPLE' as const },
  { key: 'eval-tenure-benefit', cardinality: 'SINGLE' as const },
  { key: 'eval-cross-functional', cardinality: 'MULTIPLE' as const },
] as const;

/**
 * The single starting business universe used by certification and the product.
 * `idNamespace` changes tenant-local UUIDs only; all semantic inputs are shared.
 */
export async function createCertifiedBaseline(
  client: DbClient,
  input: {
    companyId: string;
    baselineDate: string;
    idNamespace: string;
    createdBy: string;
    ruleCount?: number;
  },
): Promise<CertifiedBaseline> {
  const ruleCount = input.ruleCount ?? CERTIFIED_RULE_COUNT;
  if (!Number.isInteger(ruleCount) || ruleCount < 200 || ruleCount > 500) {
    throw new Error('Certified baseline rule count must be between 200 and 500');
  }
  const distribution = await observedDistribution(client, input.companyId, input.baselineDate);
  const groupIds = await createObservedGroups(client, input, distribution);
  const categories = await createPolicies(client, input);
  const rulesPerCategory = Math.floor(ruleCount / categories.length);
  let createdRules = 0;
  for (let categoryIndex = 0; categoryIndex < categories.length; categoryIndex += 1) {
    const category = categories[categoryIndex]!;
    const categoryRuleCount = rulesPerCategory + (categoryIndex < ruleCount % categories.length ? 1 : 0);
    for (let index = 0; index < categoryRuleCount; index += 1) {
      const condition = certifiedCondition(categoryIndex, index, distribution, groupIds);
      const priority = ((index * 17 + categoryIndex * 13) % 101) - 20;
      const enabled = index % 37 !== 0;
      await insertCertifiedRule(client, {
        ...input,
        category,
        categoryIndex,
        index,
        priority,
        enabled,
        condition,
      });
      createdRules += 1;
    }
  }
  return { ruleCount: createdRules, categories, groupIds };
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
  input: { companyId: string; baselineDate: string; idNamespace: string; createdBy: string },
  distribution: ObservedDistribution,
): Promise<string[]> {
  const selected = distribution.departments.slice(0, 8);
  const groupIds: string[] = [];
  for (let index = 0; index < selected.length; index += 1) {
    const department = selected[index]!;
    const groupId = deterministicUuid(`${input.idNamespace}:${CERTIFIED_RULE_SEED}:group:${index}:${department.value}`);
    groupIds.push(groupId);
    await client.query(
      `INSERT INTO groups (id, company_id, slug, name, description)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        groupId,
        input.companyId,
        `eval-observed-department-${index + 1}`,
        `Evaluation observed department cohort ${index + 1}`,
        `Evaluation-only cohort derived from an observed department with ${department.count} imported records; not an NYC policy group.`,
      ],
    );
    await client.query(
      `INSERT INTO group_memberships
         (company_id, group_id, employee_id, valid_from, created_by)
       SELECT $1, $2, ev.employee_id, $3::date, $5
         FROM employee_versions ev
        WHERE ev.company_id = $1
          AND ev.valid_from <= $3::date AND (ev.valid_to IS NULL OR ev.valid_to > $3::date)
          AND ev.department = $4
        ORDER BY ev.employee_id`,
      [input.companyId, groupId, input.baselineDate, department.value, input.createdBy],
    );
  }
  if (groupIds.length === 0) throw new Error('Certified baseline requires at least one observed cohort group');
  return groupIds;
}

async function createPolicies(
  client: DbClient,
  input: { companyId: string; baselineDate: string; idNamespace: string; createdBy: string },
): Promise<CertifiedCategory[]> {
  const categories: CertifiedCategory[] = [];
  for (let categoryIndex = 0; categoryIndex < certifiedCategoryDefinitions.length; categoryIndex += 1) {
    const definition = certifiedCategoryDefinitions[categoryIndex]!;
    const categoryId = deterministicUuid(`${input.idNamespace}:${CERTIFIED_RULE_SEED}:category:${definition.key}`);
    await client.query(
      `INSERT INTO policy_categories (id, company_id, key, name, cardinality)
       VALUES ($1, $2, $3, $4, $5)`,
      [categoryId, input.companyId, definition.key, `Evaluation category ${categoryIndex + 1}`, definition.cardinality],
    );
    const policyIds: string[] = [];
    for (let policyIndex = 0; policyIndex < 8; policyIndex += 1) {
      const policyId = deterministicUuid(`${input.idNamespace}:${CERTIFIED_RULE_SEED}:policy:${definition.key}:${policyIndex}`);
      const versionId = deterministicUuid(`${input.idNamespace}:${CERTIFIED_RULE_SEED}:policy-version:${definition.key}:${policyIndex}:1`);
      policyIds.push(policyId);
      await client.query(
        `INSERT INTO policies (id, company_id, category_id, key)
         VALUES ($1, $2, $3, $4)`,
        [policyId, input.companyId, categoryId, `${definition.key}-option-${policyIndex + 1}`],
      );
      await client.query(
        `INSERT INTO policy_versions
           (id, company_id, policy_id, version, valid_from, name, description, enabled, metadata, created_by)
         VALUES ($1, $2, $3, 1, $4::date, $5, $6, true, $7::jsonb, $8)`,
        [
          versionId,
          input.companyId,
          policyId,
          input.baselineDate,
          `Evaluation policy ${categoryIndex + 1}.${policyIndex + 1}`,
          'Evaluation-only policy generated for engine regression coverage; not an actual NYC policy.',
          JSON.stringify({ evaluationOnly: true, actualNycPolicy: false, datasetId: NYC_DATASET_ID, ruleSeed: CERTIFIED_RULE_SEED }),
          input.createdBy,
        ],
      );
      await client.query('UPDATE policies SET current_version_id = $3 WHERE company_id = $1 AND id = $2', [
        input.companyId,
        policyId,
        versionId,
      ]);
    }
    categories.push({ id: categoryId, key: definition.key, cardinality: definition.cardinality, policyIds });
  }
  return categories;
}

function certifiedCondition(
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

async function insertCertifiedRule(
  client: DbClient,
  input: {
    companyId: string;
    baselineDate: string;
    idNamespace: string;
    createdBy: string;
    category: CertifiedCategory;
    categoryIndex: number;
    index: number;
    priority: number;
    enabled: boolean;
    condition: RuleCondition;
  },
): Promise<void> {
  const ruleId = deterministicUuid(`${input.idNamespace}:${CERTIFIED_RULE_SEED}:rule:${input.category.key}:${input.index}`);
  const versionId = deterministicUuid(`${input.idNamespace}:${CERTIFIED_RULE_SEED}:rule-version:${input.category.key}:${input.index}:1`);
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
             $8::jsonb, $9, $10, now(), $11)`,
    [
      versionId,
      input.companyId,
      ruleId,
      policyId,
      input.priority,
      input.enabled,
      input.baselineDate,
      JSON.stringify(compiled.condition),
      compiled.specificity,
      compiled.contentHash,
      input.createdBy,
    ],
  );
  await insertRuleDependencies(client, input.companyId, versionId, compiled.dependencies);
  await client.query('UPDATE rules SET current_version_id = $3 WHERE company_id = $1 AND id = $2', [
    input.companyId,
    ruleId,
    versionId,
  ]);
}

function normalizeCondition(value: unknown, groupKeys: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeCondition(item, groupKeys));
  if (value === null || typeof value !== 'object') return value;
  const normalized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    normalized[key] = key === 'groupId' && typeof item === 'string'
      ? groupKeys.get(item) ?? item
      : normalizeCondition(item, groupKeys);
  }
  return normalized;
}

export async function certifiedBaselineSemantics(client: DbClient | DbPool, companyId: string): Promise<{
  fingerprint: string;
  content: unknown;
  counts: { categories: number; policies: number; rules: number; groups: number };
}> {
  const categories = await client.query<{ key: string; name: string; cardinality: string }>(
      'SELECT key, name, cardinality FROM policy_categories WHERE company_id = $1 ORDER BY key', [companyId],
    );
  const policies = await client.query<{
      key: string; category_key: string; version: number; valid_from: string; valid_to: string | null;
      name: string; description: string | null; enabled: boolean; metadata: unknown;
    }>(
      `SELECT p.key, pc.key AS category_key, pv.version, pv.valid_from::text, pv.valid_to::text,
              pv.name, pv.description, pv.enabled, pv.metadata
         FROM policies p
         JOIN policy_categories pc ON pc.company_id = p.company_id AND pc.id = p.category_id
         JOIN policy_versions pv ON pv.company_id = p.company_id AND pv.id = p.current_version_id
        WHERE p.company_id = $1 ORDER BY p.key`,
      [companyId],
    );
  const groups = await client.query<{
      id: string; key: string; name: string; description: string | null; member_count: number;
    }>(
      `SELECT g.id, g.slug AS key, g.name, g.description,
              count(gm.employee_id)::int AS member_count
         FROM groups g
         LEFT JOIN group_memberships gm ON gm.company_id = g.company_id AND gm.group_id = g.id
        WHERE g.company_id = $1
        GROUP BY g.id ORDER BY g.slug`,
      [companyId],
    );
  const rules = await client.query<{
      key: string; policy_key: string; version: number; status: string; priority: number; enabled: boolean;
      valid_from: string; valid_to: string | null; condition: unknown; specificity: number;
    }>(
      `SELECT r.key, p.key AS policy_key, rv.version, rv.status, rv.priority, rv.enabled,
              rv.valid_from::text, rv.valid_to::text, rv.condition, rv.specificity
         FROM rules r
         JOIN rule_versions rv ON rv.company_id = r.company_id AND rv.id = r.current_version_id
         JOIN policies p ON p.company_id = rv.company_id AND p.id = rv.policy_id
        WHERE r.company_id = $1 ORDER BY r.key`,
      [companyId],
    );
  const groupKeys = new Map(groups.rows.map((group) => [group.id, group.key]));
  const content = {
    categories: categories.rows,
    policies: policies.rows,
    groups: groups.rows.map(({ id: _id, ...group }) => group),
    rules: rules.rows.map((rule) => ({ ...rule, condition: normalizeCondition(rule.condition, groupKeys) })),
  };
  return {
    fingerprint: fingerprint(content),
    content,
    counts: {
      categories: categories.rows.length,
      policies: policies.rows.length,
      rules: rules.rows.length,
      groups: groups.rows.length,
    },
  };
}
