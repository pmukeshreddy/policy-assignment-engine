import type { DbClient, DbPool } from '../db.js';
import { compileRule, fingerprint } from '../domain/rules.js';
import { insertRuleDependencies } from '../api/helpers.js';
import { deterministicUuid } from '../eval/deterministic.js';
import { NYC_DATASET_ID } from '../eval/nyc.js';
import {
  buildCoherentBaselineBlueprint,
  coherentCategoryDefinitions,
  type BaselineDomainBlueprint,
  type BaselineRuleDefinition,
  type CoherentBaselineBlueprint,
  type ObservedEmployeeFact,
  type ObservedGroupDefinition,
} from './coherent-universe.js';

/** A version marker used only for deterministic IDs and provenance, never for rule semantics. */
export const CERTIFIED_RULE_SEED = 923_001;
export const CERTIFIED_RULE_COUNT = 300;
export const CERTIFIED_GROUP_COUNT = 8;

export interface CertifiedCategory {
  id: string;
  key: string;
  cardinality: 'SINGLE' | 'MULTIPLE';
  policyIds: string[];
}

export interface CertifiedBaseline {
  ruleCount: number;
  policyCount: number;
  categories: CertifiedCategory[];
  groupIds: string[];
  blueprint: CoherentBaselineBlueprint;
}

export const certifiedCategoryDefinitions = coherentCategoryDefinitions;

/**
 * The single company-policy universe used by product initialization and certification.
 * Tenant namespaces affect UUIDs only. Every category, policy, rule, priority, and
 * condition is built deterministically from the observed employee population.
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
  if (ruleCount !== CERTIFIED_RULE_COUNT) {
    throw new Error(`The coherent baseline contains exactly ${CERTIFIED_RULE_COUNT} rules`);
  }
  const facts = await loadObservedFacts(client, input.companyId, input.baselineDate);
  const groups = await createObservedGroups(client, input, facts);
  const blueprint = buildCoherentBaselineBlueprint(facts, groups, input.baselineDate);
  if (blueprint.ruleCount !== CERTIFIED_RULE_COUNT) {
    throw new Error(`Coherent baseline generated ${blueprint.ruleCount} rules; expected ${CERTIFIED_RULE_COUNT}`);
  }
  const categories: CertifiedCategory[] = [];
  for (const domain of blueprint.categories) categories.push(await insertDomain(client, input, domain));
  return {
    ruleCount: blueprint.ruleCount,
    policyCount: blueprint.policyCount,
    categories,
    groupIds: groups.map((group) => group.id),
    blueprint,
  };
}

async function loadObservedFacts(
  client: DbClient,
  companyId: string,
  asOfDate: string,
): Promise<ObservedEmployeeFact[]> {
  const result = await client.query<{
    employee_id: string;
    location: string | null;
    department: string | null;
    employment_type: string | null;
    pay_basis: string | null;
    employment_status: string | null;
    job_title: string | null;
    hire_date: string | null;
    is_manager: boolean;
  }>(
    `SELECT ev.employee_id, ev.location, ev.department, ev.employment_type,
            ev.attributes ->> 'pay_basis' AS pay_basis,
            ev.attributes ->> 'employment_status' AS employment_status,
            ev.attributes ->> 'job_title' AS job_title,
            ev.hire_date::text, ev.is_manager
       FROM employee_versions ev
      WHERE ev.company_id = $1
        AND ev.valid_from <= $2::date
        AND (ev.valid_to IS NULL OR ev.valid_to > $2::date)
      ORDER BY ev.employee_id`,
    [companyId, asOfDate],
  );
  if (result.rows.length === 0) throw new Error('Coherent baseline requires an imported employee population');
  return result.rows.map((row) => {
    const required = {
      location: row.location,
      department: row.department,
      employmentType: row.employment_type,
      payBasis: row.pay_basis,
      employmentStatus: row.employment_status,
      jobTitle: row.job_title,
      hireDate: row.hire_date,
    };
    for (const [field, value] of Object.entries(required)) {
      if (value === null || value.trim() === '') {
        throw new Error(`Employee ${row.employee_id} has no usable ${field}; baseline construction requires complete observed facts`);
      }
    }
    return {
      employeeId: row.employee_id,
      location: required.location!,
      department: required.department!,
      employmentType: required.employmentType!,
      payBasis: required.payBasis!,
      employmentStatus: required.employmentStatus!,
      jobTitle: required.jobTitle!,
      hireDate: required.hireDate!,
      isManager: row.is_manager,
    };
  });
}

async function createObservedGroups(
  client: DbClient,
  input: { companyId: string; baselineDate: string; idNamespace: string; createdBy: string },
  facts: readonly ObservedEmployeeFact[],
): Promise<ObservedGroupDefinition[]> {
  const counts = new Map<string, number>();
  for (const fact of facts) counts.set(fact.department, (counts.get(fact.department) ?? 0) + 1);
  const selected = [...counts.entries()]
    .sort(([leftName, leftCount], [rightName, rightCount]) => rightCount - leftCount || leftName.localeCompare(rightName))
    .slice(0, CERTIFIED_GROUP_COUNT);
  if (selected.length !== CERTIFIED_GROUP_COUNT) {
    throw new Error(`Coherent baseline requires at least ${CERTIFIED_GROUP_COUNT} observed departments for cohort coverage`);
  }
  const groups: ObservedGroupDefinition[] = [];
  for (const [department, memberCount] of selected) {
    const semanticKey = derivedSemanticKey('observed-department-cohort', department);
    const groupId = deterministicUuid(`${input.idNamespace}:${CERTIFIED_RULE_SEED}:group:${semanticKey}`);
    const name = `${humanize(department)} Operating Cohort`;
    await client.query(
      `INSERT INTO groups (id, company_id, slug, name, description)
       VALUES ($1, $2, $3, $4, $5)`,
      [groupId, input.companyId, semanticKey, name,
        `Fictional company operating cohort derived from the observed ${humanize(department)} department (${memberCount.toLocaleString()} employees); not an official NYC group or policy.`],
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
      [input.companyId, groupId, input.baselineDate, department, input.createdBy],
    );
    groups.push({ id: groupId, key: semanticKey, name, department, memberCount });
  }
  return groups;
}

async function insertDomain(
  client: DbClient,
  input: { companyId: string; baselineDate: string; idNamespace: string; createdBy: string },
  domain: BaselineDomainBlueprint,
): Promise<CertifiedCategory> {
  const categoryId = deterministicUuid(`${input.idNamespace}:${CERTIFIED_RULE_SEED}:category:${domain.key}`);
  await client.query(
    `INSERT INTO policy_categories (id, company_id, key, name, cardinality)
     VALUES ($1, $2, $3, $4, $5)`,
    [categoryId, input.companyId, domain.key, domain.name, domain.cardinality],
  );
  const policyIds: string[] = [];
  const policyIdByKey = new Map<string, string>();
  for (const definition of domain.policies) {
    const policyId = deterministicUuid(`${input.idNamespace}:${CERTIFIED_RULE_SEED}:policy:${definition.key}`);
    const versionId = deterministicUuid(`${input.idNamespace}:${CERTIFIED_RULE_SEED}:policy-version:${definition.key}:1`);
    policyIds.push(policyId);
    policyIdByKey.set(definition.key, policyId);
    await client.query(
      `INSERT INTO policies (id, company_id, category_id, key) VALUES ($1, $2, $3, $4)`,
      [policyId, input.companyId, categoryId, definition.key],
    );
    await client.query(
      `INSERT INTO policy_versions
         (id, company_id, policy_id, version, valid_from, name, description, enabled, metadata, created_by)
       VALUES ($1, $2, $3, 1, $4::date, $5, $6, true, $7::jsonb, $8)`,
      [versionId, input.companyId, policyId, input.baselineDate, definition.name, definition.description,
        JSON.stringify({ ...definition.metadata, datasetId: NYC_DATASET_ID, semanticVersion: CERTIFIED_RULE_SEED }), input.createdBy],
    );
    await client.query(
      'UPDATE policies SET current_version_id = $3 WHERE company_id = $1 AND id = $2',
      [input.companyId, policyId, versionId],
    );
  }
  for (const rule of domain.rules) {
    const policyId = policyIdByKey.get(rule.policyKey);
    if (policyId === undefined) throw new Error(`Rule ${rule.key} references unknown policy ${rule.policyKey}`);
    await insertCertifiedRule(client, input, policyId, rule);
  }
  return { id: categoryId, key: domain.key, cardinality: domain.cardinality, policyIds };
}

async function insertCertifiedRule(
  client: DbClient,
  input: { companyId: string; baselineDate: string; idNamespace: string; createdBy: string },
  policyId: string,
  definition: BaselineRuleDefinition,
): Promise<void> {
  const ruleId = deterministicUuid(`${input.idNamespace}:${CERTIFIED_RULE_SEED}:rule:${definition.key}`);
  const versionId = deterministicUuid(`${input.idNamespace}:${CERTIFIED_RULE_SEED}:rule-version:${definition.key}:1`);
  const compiled = compileRule(definition.condition);
  await client.query('INSERT INTO rules (id, company_id, key, current_version_id) VALUES ($1, $2, $3, NULL)',
    [ruleId, input.companyId, definition.key]);
  await client.query(
    `INSERT INTO rule_versions
       (id, company_id, rule_id, policy_id, version, status, priority, enabled, valid_from,
        condition, specificity, content_hash, published_at, created_by)
     VALUES ($1, $2, $3, $4, 1, 'PUBLISHED', $5, true, $6::date,
             $7::jsonb, $8, $9, now(), $10)`,
    [versionId, input.companyId, ruleId, policyId, definition.priority, input.baselineDate,
      JSON.stringify(compiled.condition), compiled.specificity, compiled.contentHash, input.createdBy],
  );
  await insertRuleDependencies(client, input.companyId, versionId, compiled.dependencies);
  await client.query('UPDATE rules SET current_version_id = $3 WHERE company_id = $1 AND id = $2',
    [input.companyId, ruleId, versionId]);
}

function derivedSemanticKey(prefix: string, value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'segment';
  return `${prefix}-${slug.slice(0, 58).replace(/-$/g, '')}-${fingerprint(value).slice(0, 8)}`;
}

function humanize(value: string): string {
  return value.toLowerCase().replace(/(^|[\s/_-])\w/g, (match) => match.toUpperCase());
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
      WHERE p.company_id = $1 ORDER BY p.key`, [companyId],
  );
  const groups = await client.query<{
    id: string; key: string; name: string; description: string | null; member_count: number;
  }>(
    `SELECT g.id, g.slug AS key, g.name, g.description,
            count(gm.employee_id)::int AS member_count
       FROM groups g
       LEFT JOIN group_memberships gm ON gm.company_id = g.company_id AND gm.group_id = g.id
      WHERE g.company_id = $1 GROUP BY g.id ORDER BY g.slug`, [companyId],
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
      WHERE r.company_id = $1 ORDER BY r.key`, [companyId],
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
