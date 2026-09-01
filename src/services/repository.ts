import type { Cardinality } from '../domain/resolution.js';
import type { EmployeeSnapshot, RuleCondition } from '../domain/rules.js';
import type { Queryable } from '../db.js';
import type { EvaluatableOverride, EvaluatableRule } from './evaluation.js';

interface EmployeeSnapshotRow {
  id: string;
  company_id: string;
  version_id: string;
  external_id: string;
  email: string | null;
  location: string | null;
  department: string | null;
  employment_type: string | null;
  is_manager: boolean;
  hire_date: string | null;
  attributes: Record<string, unknown>;
  group_ids: string[] | null;
}

export interface CategoryRecord {
  id: string;
  cardinality: Cardinality;
  key: string;
  name: string;
}

interface RuleRow {
  rule_id: string;
  rule_version_id: string;
  policy_id: string;
  category_id: string;
  priority: number;
  enabled: boolean;
  valid_from: string;
  valid_to: string | null;
  condition: RuleCondition;
  content_hash: string;
  specificity: number;
  policy_enabled: boolean;
}

interface OverrideRow {
  id: string;
  policy_id: string;
  category_id: string;
  action: 'ASSIGN' | 'EXCLUDE';
  priority: number;
  reason: string;
  valid_from: string;
  valid_to: string | null;
}

export async function loadEmployeeSnapshot(
  db: Queryable,
  companyId: string,
  employeeId: string,
  asOfDate: string,
): Promise<EmployeeSnapshot | null> {
  const result = await db.query<EmployeeSnapshotRow>(
    `SELECT e.id,
            e.company_id,
            ev.id AS version_id,
            e.external_id,
            ev.email,
            ev.location,
            ev.department,
            ev.employment_type,
            ev.is_manager,
            ev.hire_date::text,
            ev.attributes,
            COALESCE(array_agg(gm.group_id::text ORDER BY gm.group_id)
              FILTER (WHERE gm.group_id IS NOT NULL), '{}') AS group_ids
       FROM employees e
       JOIN employee_versions ev
         ON ev.company_id = e.company_id
        AND ev.employee_id = e.id
        AND ev.valid_from <= $3::date
        AND (ev.valid_to IS NULL OR ev.valid_to > $3::date)
       LEFT JOIN group_memberships gm
         ON gm.company_id = e.company_id
        AND gm.employee_id = e.id
        AND gm.valid_from <= $3::date
        AND (gm.valid_to IS NULL OR gm.valid_to > $3::date)
      WHERE e.company_id = $1 AND e.id = $2
      GROUP BY e.id, ev.id`,
    [companyId, employeeId, asOfDate],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    versionId: row.version_id,
    externalId: row.external_id,
    email: row.email,
    location: row.location,
    department: row.department,
    employmentType: row.employment_type,
    isManager: row.is_manager,
    hireDate: row.hire_date,
    attributes: row.attributes,
    groupIds: new Set(row.group_ids ?? []),
    asOfDate,
  };
}

export async function loadEmployeeSnapshots(
  db: Queryable,
  companyId: string,
  employeeIds: readonly string[],
  asOfDate: string,
): Promise<Map<string, EmployeeSnapshot>> {
  const snapshots = new Map<string, EmployeeSnapshot>();
  const uniqueIds = [...new Set(employeeIds)];
  for (let offset = 0; offset < uniqueIds.length; offset += 1_000) {
    const result = await db.query<EmployeeSnapshotRow>(
      `SELECT e.id,
              e.company_id,
              ev.id AS version_id,
              e.external_id,
              ev.email,
              ev.location,
              ev.department,
              ev.employment_type,
              ev.is_manager,
              ev.hire_date::text,
              ev.attributes,
              COALESCE(array_agg(gm.group_id::text ORDER BY gm.group_id)
                FILTER (WHERE gm.group_id IS NOT NULL), '{}') AS group_ids
         FROM employees e
         JOIN employee_versions ev
           ON ev.company_id = e.company_id
          AND ev.employee_id = e.id
          AND ev.valid_from <= $3::date
          AND (ev.valid_to IS NULL OR ev.valid_to > $3::date)
         LEFT JOIN group_memberships gm
           ON gm.company_id = e.company_id
          AND gm.employee_id = e.id
          AND gm.valid_from <= $3::date
          AND (gm.valid_to IS NULL OR gm.valid_to > $3::date)
        WHERE e.company_id = $1 AND e.id = ANY($2::uuid[])
        GROUP BY e.id, ev.id
        ORDER BY e.id`,
      [companyId, uniqueIds.slice(offset, offset + 1_000), asOfDate],
    );
    for (const row of result.rows) {
      snapshots.set(row.id, {
        id: row.id,
        companyId: row.company_id,
        versionId: row.version_id,
        externalId: row.external_id,
        email: row.email,
        location: row.location,
        department: row.department,
        employmentType: row.employment_type,
        isManager: row.is_manager,
        hireDate: row.hire_date,
        attributes: row.attributes,
        groupIds: new Set(row.group_ids ?? []),
        asOfDate,
      });
    }
  }
  return snapshots;
}

export async function loadCategory(db: Queryable, companyId: string, categoryId: string): Promise<CategoryRecord | null> {
  const result = await db.query<CategoryRecord>(
    `SELECT id, cardinality, key, name
       FROM policy_categories
      WHERE company_id = $1 AND id = $2`,
    [companyId, categoryId],
  );
  return result.rows[0] ?? null;
}

export async function listCategoryIds(db: Queryable, companyId: string): Promise<string[]> {
  const result = await db.query<{ id: string }>(
    'SELECT id FROM policy_categories WHERE company_id = $1 ORDER BY id',
    [companyId],
  );
  return result.rows.map((row) => row.id);
}

export async function loadRulesForCategory(
  db: Queryable,
  companyId: string,
  categoryId: string,
  asOfDate: string,
): Promise<EvaluatableRule[]> {
  const result = await db.query<RuleRow>(
    `SELECT rv.rule_id,
            rv.id AS rule_version_id,
            rv.policy_id,
            p.category_id,
            rv.priority,
            rv.enabled,
            rv.valid_from::text,
            rv.valid_to::text,
            rv.condition,
            rv.content_hash,
            rv.specificity,
            COALESCE(pv.enabled, false) AS policy_enabled
       FROM rule_versions rv
       JOIN policies p
         ON p.company_id = rv.company_id AND p.id = rv.policy_id
       LEFT JOIN policy_versions pv
         ON pv.company_id = p.company_id
        AND pv.policy_id = p.id
        AND pv.valid_from <= $3::date
        AND (pv.valid_to IS NULL OR pv.valid_to > $3::date)
      WHERE rv.company_id = $1
        AND p.category_id = $2
        AND rv.status = 'PUBLISHED'
        AND (rv.valid_to IS NULL OR rv.valid_to > $3::date)
      ORDER BY rv.id`,
    [companyId, categoryId, asOfDate],
  );
  return result.rows.map((row) => ({
    ruleId: row.rule_id,
    ruleVersionId: row.rule_version_id,
    policyId: row.policy_id,
    categoryId: row.category_id,
    priority: row.priority,
    enabled: row.enabled,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    condition: row.condition,
    contentHash: row.content_hash,
    specificity: row.specificity,
    policyEnabled: row.policy_enabled,
  }));
}

export async function loadOverridesForCategory(
  db: Queryable,
  companyId: string,
  employeeId: string,
  categoryId: string,
  asOfDate: string,
): Promise<EvaluatableOverride[]> {
  const result = await db.query<OverrideRow>(
    `SELECT mo.id,
            mo.policy_id,
            p.category_id,
            mo.action,
            mo.priority,
            mo.reason,
            mo.valid_from::text,
            mo.valid_to::text
       FROM manual_overrides mo
       JOIN policies p ON p.company_id = mo.company_id AND p.id = mo.policy_id
      WHERE mo.company_id = $1
        AND mo.employee_id = $2
        AND p.category_id = $3
        AND mo.revoked_at IS NULL
        AND (mo.valid_to IS NULL OR mo.valid_to > $4::date)
      ORDER BY mo.id`,
    [companyId, employeeId, categoryId, asOfDate],
  );
  return result.rows.map((row) => ({
    id: row.id,
    policyId: row.policy_id,
    categoryId: row.category_id,
    action: row.action,
    priority: row.priority,
    reason: row.reason,
    validFrom: row.valid_from,
    validTo: row.valid_to,
  }));
}

export async function loadOverridesForScopes(
  db: Queryable,
  companyId: string,
  employeeIds: readonly string[],
  asOfDate: string,
): Promise<Map<string, EvaluatableOverride[]>> {
  const grouped = new Map<string, EvaluatableOverride[]>();
  const uniqueIds = [...new Set(employeeIds)];
  for (let offset = 0; offset < uniqueIds.length; offset += 1_000) {
    const result = await db.query<OverrideRow & { employee_id: string }>(
      `SELECT mo.id,
              mo.employee_id,
              mo.policy_id,
              p.category_id,
              mo.action,
              mo.priority,
              mo.reason,
              mo.valid_from::text,
              mo.valid_to::text
         FROM manual_overrides mo
         JOIN policies p ON p.company_id = mo.company_id AND p.id = mo.policy_id
        WHERE mo.company_id = $1
          AND mo.employee_id = ANY($2::uuid[])
          AND mo.revoked_at IS NULL
          AND (mo.valid_to IS NULL OR mo.valid_to > $3::date)
        ORDER BY mo.employee_id, p.category_id, mo.id`,
      [companyId, uniqueIds.slice(offset, offset + 1_000), asOfDate],
    );
    for (const row of result.rows) {
      const key = `${row.employee_id}:${row.category_id}`;
      const values = grouped.get(key) ?? [];
      values.push({
        id: row.id,
        policyId: row.policy_id,
        categoryId: row.category_id,
        action: row.action,
        priority: row.priority,
        reason: row.reason,
        validFrom: row.valid_from,
        validTo: row.valid_to,
      });
      grouped.set(key, values);
    }
  }
  return grouped;
}
