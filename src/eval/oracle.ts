import type { DbPool } from '../db.js';
import { ruleConditionSchema, type RuleCondition } from '../domain/rules.js';

interface OracleCategory {
  id: string;
  cardinality: 'SINGLE' | 'MULTIPLE';
}

interface OracleRule {
  ruleVersionId: string;
  policyId: string;
  categoryId: string;
  priority: number;
  enabled: boolean;
  validFrom: string;
  validTo: string | null;
  policyEnabled: boolean;
  condition: RuleCondition;
}

interface OracleOverride {
  id: string;
  employeeId: string;
  policyId: string;
  categoryId: string;
  action: 'ASSIGN' | 'EXCLUDE';
  priority: number;
  validFrom: string;
  validTo: string | null;
}

export interface OracleEmployeeSnapshot {
  id: string;
  externalId: string;
  email: string | null;
  location: string | null;
  department: string | null;
  employmentType: string | null;
  isManager: boolean;
  hireDate: string | null;
  attributes: Record<string, unknown>;
  groupIds: Set<string>;
  asOfDate: string;
}

interface OracleCandidate {
  candidateId: string;
  policyId: string;
  categoryId: string;
  source: 'RULE' | 'MANUAL';
  action: 'ASSIGN' | 'EXCLUDE';
  priority: number;
  specificity: number;
}

export interface OracleResult {
  assignments: Map<string, string[]>;
  rulesEvaluated: number;
  deterministicFailures: number;
}

interface EmployeeRow {
  id: string;
  external_id: string;
  email: string | null;
  location: string | null;
  department: string | null;
  employment_type: string | null;
  is_manager: boolean;
  hire_date: string | null;
  attributes: Record<string, unknown>;
  group_ids: string[];
}

export class DatabaseFullRecomputeOracle {
  constructor(private readonly pool: DbPool) {}

  async recompute(companyId: string, employeeIds: readonly string[], asOfDate: string): Promise<OracleResult> {
    if (employeeIds.length === 0) return { assignments: new Map(), rulesEvaluated: 0, deterministicFailures: 0 };
    const [categories, rules, employees, overrides] = await Promise.all([
      this.loadCategories(companyId),
      this.loadRules(companyId, asOfDate),
      this.loadEmployees(companyId, employeeIds, asOfDate),
      this.loadOverrides(companyId, employeeIds, asOfDate),
    ]);
    if (employees.length !== new Set(employeeIds).size) {
      throw new Error(`Oracle loaded ${employees.length} of ${new Set(employeeIds).size} requested source-of-truth employees`);
    }
    const overridesByEmployee = groupBy(overrides, (override) => override.employeeId);
    const assignments = new Map<string, string[]>();
    let rulesEvaluated = 0;
    let deterministicFailures = 0;
    for (const employee of employees) {
      const forward = fullRecomputeEmployee(employee, categories, rules, overridesByEmployee.get(employee.id) ?? []);
      const reverse = fullRecomputeEmployee(employee, categories, [...rules].reverse(), [...(overridesByEmployee.get(employee.id) ?? [])].reverse());
      rulesEvaluated += rules.length;
      if (serializeAssignments(forward) !== serializeAssignments(reverse)) deterministicFailures += 1;
      for (const category of categories) {
        assignments.set(`${employee.id}:${category.id}`, forward.get(category.id) ?? []);
      }
    }
    return { assignments, rulesEvaluated, deterministicFailures };
  }

  private async loadCategories(companyId: string): Promise<OracleCategory[]> {
    const result = await this.pool.query<OracleCategory>(
      'SELECT id, cardinality FROM policy_categories WHERE company_id = $1 ORDER BY id',
      [companyId],
    );
    return result.rows;
  }

  private async loadRules(companyId: string, asOfDate: string): Promise<OracleRule[]> {
    const result = await this.pool.query<{
      rule_version_id: string;
      policy_id: string;
      category_id: string;
      priority: number;
      enabled: boolean;
      valid_from: string;
      valid_to: string | null;
      policy_enabled: boolean;
      condition: unknown;
    }>(
      `SELECT rv.id AS rule_version_id,
              rv.policy_id,
              p.category_id,
              rv.priority,
              rv.enabled,
              rv.valid_from::text,
              rv.valid_to::text,
              COALESCE(pv.enabled, false) AS policy_enabled,
              rv.condition
         FROM rule_versions rv
         JOIN policies p ON p.company_id = rv.company_id AND p.id = rv.policy_id
         LEFT JOIN policy_versions pv
           ON pv.company_id = p.company_id
          AND pv.policy_id = p.id
          AND pv.valid_from <= $2::date
          AND (pv.valid_to IS NULL OR pv.valid_to > $2::date)
        WHERE rv.company_id = $1
          AND rv.status = 'PUBLISHED'
          AND (rv.valid_to IS NULL OR rv.valid_to > $2::date)
        ORDER BY rv.id`,
      [companyId, asOfDate],
    );
    return result.rows.map((row) => ({
      ruleVersionId: row.rule_version_id,
      policyId: row.policy_id,
      categoryId: row.category_id,
      priority: row.priority,
      enabled: row.enabled,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      policyEnabled: row.policy_enabled,
      condition: ruleConditionSchema.parse(row.condition),
    }));
  }

  private async loadEmployees(companyId: string, employeeIds: readonly string[], asOfDate: string): Promise<OracleEmployeeSnapshot[]> {
    const uniqueIds = [...new Set(employeeIds)];
    const rows: EmployeeRow[] = [];
    for (let offset = 0; offset < uniqueIds.length; offset += 1_000) {
      const batch = uniqueIds.slice(offset, offset + 1_000);
      const result = await this.pool.query<EmployeeRow>(
        `SELECT e.id,
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
        [companyId, batch, asOfDate],
      );
      rows.push(...result.rows);
    }
    return rows.map((row) => ({
      id: row.id,
      externalId: row.external_id,
      email: row.email,
      location: row.location,
      department: row.department,
      employmentType: row.employment_type,
      isManager: row.is_manager,
      hireDate: row.hire_date,
      attributes: row.attributes,
      groupIds: new Set(row.group_ids),
      asOfDate,
    }));
  }

  private async loadOverrides(companyId: string, employeeIds: readonly string[], asOfDate: string): Promise<OracleOverride[]> {
    const uniqueIds = [...new Set(employeeIds)];
    const rows: OracleOverride[] = [];
    for (let offset = 0; offset < uniqueIds.length; offset += 1_000) {
      const batch = uniqueIds.slice(offset, offset + 1_000);
      const result = await this.pool.query<{
        id: string;
        employee_id: string;
        policy_id: string;
        category_id: string;
        action: 'ASSIGN' | 'EXCLUDE';
        priority: number;
        valid_from: string;
        valid_to: string | null;
      }>(
        `SELECT mo.id,
                mo.employee_id,
                mo.policy_id,
                p.category_id,
                mo.action,
                mo.priority,
                mo.valid_from::text,
                mo.valid_to::text
           FROM manual_overrides mo
           JOIN policies p ON p.company_id = mo.company_id AND p.id = mo.policy_id
          WHERE mo.company_id = $1
            AND mo.employee_id = ANY($2::uuid[])
            AND mo.revoked_at IS NULL
            AND (mo.valid_to IS NULL OR mo.valid_to > $3::date)
          ORDER BY mo.employee_id, mo.id`,
        [companyId, batch, asOfDate],
      );
      rows.push(...result.rows.map((row) => ({
        id: row.id,
        employeeId: row.employee_id,
        policyId: row.policy_id,
        categoryId: row.category_id,
        action: row.action,
        priority: row.priority,
        validFrom: row.valid_from,
        validTo: row.valid_to,
      })));
    }
    return rows;
  }
}

export function oracleMatchesCondition(condition: RuleCondition, employee: OracleEmployeeSnapshot): boolean {
  if (condition.type === 'and') return condition.conditions.every((child) => oracleMatchesCondition(child, employee));
  if (condition.type === 'or') return condition.conditions.some((child) => oracleMatchesCondition(child, employee));
  if (condition.type === 'not') return !oracleMatchesCondition(condition.condition, employee);
  if (condition.type === 'group') {
    const member = employee.groupIds.has(condition.groupId);
    return condition.operator === 'MEMBER_OF' ? member : !member;
  }
  let actual: unknown;
  if (condition.fact.kind === 'employee') {
    const values: Record<string, unknown> = {
      external_id: employee.externalId,
      email: employee.email,
      location: employee.location,
      department: employee.department,
      employment_type: employee.employmentType,
      is_manager: employee.isManager,
      hire_date: employee.hireDate,
    };
    actual = values[condition.fact.field];
  } else if (condition.fact.kind === 'attribute') {
    actual = employee.attributes[condition.fact.key];
  } else if (condition.fact.kind === 'as_of_date') {
    actual = employee.asOfDate;
  } else {
    actual = employee.hireDate === null ? undefined : Math.max(0, epochDay(employee.asOfDate) - epochDay(employee.hireDate));
  }
  if (actual === undefined) return false;
  const expected = condition.value;
  if (condition.operator === 'IN' || condition.operator === 'NOT_IN') {
    const found = (expected as unknown[]).some((value) => scalarEqual(actual, value));
    return condition.operator === 'IN' ? found : !found;
  }
  if (condition.operator === 'EQ') return scalarEqual(actual, expected);
  if (condition.operator === 'NE') return !scalarEqual(actual, expected);
  if (actual === null || expected === null || Array.isArray(expected) || typeof actual !== typeof expected) return false;
  if (typeof actual !== 'number' && typeof actual !== 'string') return false;
  if (condition.operator === 'GT') return actual > expected;
  if (condition.operator === 'GTE') return actual >= expected;
  if (condition.operator === 'LT') return actual < expected;
  return actual <= expected;
}

function fullRecomputeEmployee(
  employee: OracleEmployeeSnapshot,
  categories: readonly OracleCategory[],
  rules: readonly OracleRule[],
  overrides: readonly OracleOverride[],
): Map<string, string[]> {
  const candidates = new Map<string, OracleCandidate[]>();
  for (const category of categories) candidates.set(category.id, []);
  for (const rule of rules) {
    const matched = oracleMatchesCondition(rule.condition, employee);
    if (!rule.enabled || !rule.policyEnabled || !activeOn(rule.validFrom, rule.validTo, employee.asOfDate) || !matched) continue;
    const values = candidates.get(rule.categoryId);
    if (values === undefined) throw new Error(`Oracle rule references missing category ${rule.categoryId}`);
    values.push({
      candidateId: `rule:${rule.ruleVersionId}`,
      policyId: rule.policyId,
      categoryId: rule.categoryId,
      source: 'RULE',
      action: 'ASSIGN',
      priority: rule.priority,
      specificity: oracleSpecificity(rule.condition),
    });
  }
  for (const override of overrides) {
    if (!activeOn(override.validFrom, override.validTo, employee.asOfDate)) continue;
    const values = candidates.get(override.categoryId);
    if (values === undefined) throw new Error(`Oracle override references missing category ${override.categoryId}`);
    values.push({
      candidateId: `manual:${override.id}`,
      policyId: override.policyId,
      categoryId: override.categoryId,
      source: 'MANUAL',
      action: override.action,
      priority: override.priority,
      specificity: Number.MAX_SAFE_INTEGER,
    });
  }
  const result = new Map<string, string[]>();
  for (const category of categories) {
    result.set(category.id, oracleResolvePolicyIds(category.cardinality, candidates.get(category.id) ?? []));
  }
  return result;
}

export function oracleResolvePolicyIds(
  cardinality: 'SINGLE' | 'MULTIPLE',
  candidates: readonly OracleCandidate[],
): string[] {
  const byPolicy = groupBy(candidates, (candidate) => candidate.policyId);
  const eligible: OracleCandidate[] = [];
  for (const policyCandidates of byPolicy.values()) {
    const ordered = [...policyCandidates].sort(oraclePrecedence);
    if (ordered[0]?.action === 'ASSIGN') eligible.push(ordered[0]);
  }
  eligible.sort(oraclePrecedence);
  return (cardinality === 'SINGLE' ? eligible.slice(0, 1) : eligible).map((candidate) => candidate.policyId).sort();
}

function oraclePrecedence(left: OracleCandidate, right: OracleCandidate): number {
  if (left.source !== right.source) return left.source === 'MANUAL' ? -1 : 1;
  if (left.priority !== right.priority) return right.priority - left.priority;
  if (left.specificity !== right.specificity) return right.specificity - left.specificity;
  const candidate = left.candidateId.localeCompare(right.candidateId);
  return candidate === 0 ? left.policyId.localeCompare(right.policyId) : candidate;
}

function oracleSpecificity(condition: RuleCondition): number {
  if (condition.type === 'comparison' || condition.type === 'group') return 1;
  if (condition.type === 'not') return oracleSpecificity(condition.condition);
  return condition.conditions.reduce((total, child) => total + oracleSpecificity(child), 0);
}

function scalarEqual(left: unknown, right: unknown): boolean {
  return left === right || (left !== undefined && right !== undefined && JSON.stringify(left) === JSON.stringify(right));
}

function activeOn(validFrom: string, validTo: string | null, asOfDate: string): boolean {
  return validFrom <= asOfDate && (validTo === null || validTo > asOfDate);
}

function epochDay(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

function groupBy<T>(values: readonly T[], key: (value: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) grouped.set(key(value), [...(grouped.get(key(value)) ?? []), value]);
  return grouped;
}

function serializeAssignments(value: Map<string, string[]>): string {
  return JSON.stringify([...value.entries()].sort(([left], [right]) => left.localeCompare(right)));
}
