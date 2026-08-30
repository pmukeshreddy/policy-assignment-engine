import { z } from 'zod';
import type { DbPool, Queryable } from '../db.js';
import { todayUtc } from '../domain/dates.js';
import type { ReconciliationJob } from './jobs.js';
import { listCategoryIds } from './repository.js';

export interface ReconciliationScope {
  employeeId: string;
  categoryId: string;
}

const employeePayloadSchema = z.object({
  employeeId: z.string().uuid(),
  changedFields: z.array(z.string()).optional(),
  categoryIds: z.array(z.string().uuid()).optional(),
});
const groupPayloadSchema = z.object({ employeeId: z.string().uuid(), groupId: z.string().uuid() });
const rulePayloadSchema = z.object({
  ruleVersionId: z.string().uuid(),
  previousRuleVersionId: z.string().uuid().optional(),
});
const policyPayloadSchema = z.object({ policyId: z.string().uuid() });
const directPayloadSchema = z.object({ employeeId: z.string().uuid(), categoryId: z.string().uuid() });

interface DependencyRow {
  dependency_type: 'FIELD' | 'ATTRIBUTE' | 'GROUP';
  dependency_key: string;
  operator: string | null;
  selector_value: unknown;
}

export class ImpactAnalyzer {
  constructor(
    private readonly pool: DbPool,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async analyze(job: ReconciliationJob): Promise<ReconciliationScope[]> {
    const date = todayUtc(this.clock);
    if (job.scope === 'EMPLOYEE') return this.employeeImpact(job.companyId, employeePayloadSchema.parse(job.payload), date);
    if (job.scope === 'GROUP') return this.groupImpact(job.companyId, groupPayloadSchema.parse(job.payload), date);
    if (job.scope === 'RULE') return this.ruleImpact(job.companyId, rulePayloadSchema.parse(job.payload), date);
    if (job.scope === 'POLICY') return this.policyImpact(job.companyId, policyPayloadSchema.parse(job.payload), date);
    if (job.scope === 'OVERRIDE' || job.scope === 'TEMPORAL') {
      const payload = directPayloadSchema.parse(job.payload);
      return [{ employeeId: payload.employeeId, categoryId: payload.categoryId }];
    }
    if (job.scope === 'FULL') return this.fullCompanyImpact(job.companyId, date);
    throw new Error(`Unsupported reconciliation scope: ${job.scope satisfies never}`);
  }

  async candidateEmployeesForRuleVersion(
    db: Queryable,
    companyId: string,
    ruleVersionId: string,
    asOfDate: string,
  ): Promise<string[]> {
    const dependencies = await db.query<DependencyRow>(
      `SELECT dependency_type, dependency_key, operator, selector_value
         FROM rule_dependencies
        WHERE company_id = $1 AND rule_version_id = $2 AND mandatory_selector
        ORDER BY CASE dependency_type WHEN 'GROUP' THEN 0 WHEN 'FIELD' THEN 1 ELSE 2 END,
                 dependency_key`,
      [companyId, ruleVersionId],
    );
    if (dependencies.rows.length === 0) return this.allEmployeeIds(db, companyId, asOfDate);

    let intersection: Set<string> | null = null;
    for (const dependency of dependencies.rows) {
      const selected = await this.applySelector(db, companyId, dependency, asOfDate);
      if (selected === null) continue;
      if (intersection === null) {
        intersection = new Set(selected);
      } else {
        const selectedSet = new Set(selected);
        intersection = new Set<string>(
          [...(intersection as Set<string>)].filter((employeeId: string) => selectedSet.has(employeeId)),
        );
      }
      if (intersection.size === 0) return [];
    }
    return intersection === null ? this.allEmployeeIds(db, companyId, asOfDate) : [...intersection].sort();
  }

  private async employeeImpact(
    companyId: string,
    payload: z.infer<typeof employeePayloadSchema>,
    asOfDate: string,
  ): Promise<ReconciliationScope[]> {
    if (payload.categoryIds !== undefined) {
      return payload.categoryIds.map((categoryId) => ({ employeeId: payload.employeeId, categoryId }));
    }
    if (payload.changedFields === undefined || payload.changedFields.length === 0) {
      const categories = await listCategoryIds(this.pool, companyId);
      return categories.map((categoryId) => ({ employeeId: payload.employeeId, categoryId }));
    }
    const fields = payload.changedFields.filter((field) => !field.startsWith('attributes.'));
    const attributes = payload.changedFields
      .filter((field) => field.startsWith('attributes.'))
      .map((field) => field.slice('attributes.'.length));
    const result = await this.pool.query<{ category_id: string }>(
      `SELECT DISTINCT p.category_id
         FROM rule_dependencies rd
         JOIN rule_versions rv ON rv.company_id = rd.company_id AND rv.id = rd.rule_version_id
         JOIN policies p ON p.company_id = rv.company_id AND p.id = rv.policy_id
        WHERE rd.company_id = $1
          AND rv.status = 'PUBLISHED'
          AND rv.valid_from <= $4::date
          AND (rv.valid_to IS NULL OR rv.valid_to > $4::date)
          AND (
            (rd.dependency_type = 'FIELD' AND rd.dependency_key = ANY($2::text[]))
            OR (rd.dependency_type = 'ATTRIBUTE' AND rd.dependency_key = ANY($3::text[]))
          )
        ORDER BY p.category_id`,
      [companyId, fields, attributes, asOfDate],
    );
    return result.rows.map((row) => ({ employeeId: payload.employeeId, categoryId: row.category_id }));
  }

  private async groupImpact(
    companyId: string,
    payload: z.infer<typeof groupPayloadSchema>,
    asOfDate: string,
  ): Promise<ReconciliationScope[]> {
    const result = await this.pool.query<{ category_id: string }>(
      `SELECT DISTINCT p.category_id
         FROM rule_dependencies rd
         JOIN rule_versions rv ON rv.company_id = rd.company_id AND rv.id = rd.rule_version_id
         JOIN policies p ON p.company_id = rv.company_id AND p.id = rv.policy_id
        WHERE rd.company_id = $1
          AND rd.dependency_type = 'GROUP'
          AND rd.dependency_key = $2
          AND rv.status = 'PUBLISHED'
          AND rv.valid_from <= $3::date
          AND (rv.valid_to IS NULL OR rv.valid_to > $3::date)
        ORDER BY p.category_id`,
      [companyId, payload.groupId, asOfDate],
    );
    return result.rows.map((row) => ({ employeeId: payload.employeeId, categoryId: row.category_id }));
  }

  private async ruleImpact(
    companyId: string,
    payload: z.infer<typeof rulePayloadSchema>,
    asOfDate: string,
  ): Promise<ReconciliationScope[]> {
    const versionIds = [payload.ruleVersionId, payload.previousRuleVersionId].filter((id): id is string => id !== undefined);
    const categoryResult = await this.pool.query<{ id: string; category_id: string }>(
      `SELECT rv.id, p.category_id
         FROM rule_versions rv
         JOIN policies p ON p.company_id = rv.company_id AND p.id = rv.policy_id
        WHERE rv.company_id = $1 AND rv.id = ANY($2::uuid[])`,
      [companyId, versionIds],
    );
    if (categoryResult.rows.length !== versionIds.length) throw new Error('Rule impact references a missing or cross-tenant version');
    const employees = new Map<string, Set<string>>();
    for (const version of categoryResult.rows) {
      const ids = await this.candidateEmployeesForRuleVersion(this.pool, companyId, version.id, asOfDate);
      for (const employeeId of ids) {
        const categories = employees.get(employeeId) ?? new Set<string>();
        categories.add(version.category_id);
        employees.set(employeeId, categories);
      }
    }
    return [...employees.entries()]
      .flatMap(([employeeId, categoryIds]) => [...categoryIds].map((categoryId) => ({ employeeId, categoryId })))
      .sort(scopeOrder);
  }

  private async policyImpact(
    companyId: string,
    payload: z.infer<typeof policyPayloadSchema>,
    asOfDate: string,
  ): Promise<ReconciliationScope[]> {
    const category = await this.pool.query<{ category_id: string }>(
      'SELECT category_id FROM policies WHERE company_id = $1 AND id = $2',
      [companyId, payload.policyId],
    );
    const categoryId = category.rows[0]?.category_id;
    if (categoryId === undefined) throw new Error('Policy impact references a missing or cross-tenant policy');
    const employeeIds = new Set<string>();
    const assigned = await this.pool.query<{ employee_id: string }>(
      `SELECT employee_id FROM materialized_assignments
        WHERE company_id = $1 AND policy_id = $2`,
      [companyId, payload.policyId],
    );
    assigned.rows.forEach((row) => employeeIds.add(row.employee_id));
    const versions = await this.pool.query<{ id: string }>(
      `SELECT id FROM rule_versions
        WHERE company_id = $1 AND policy_id = $2 AND status = 'PUBLISHED'
          AND (valid_to IS NULL OR valid_to > $3::date)`,
      [companyId, payload.policyId, asOfDate],
    );
    for (const version of versions.rows) {
      const candidates = await this.candidateEmployeesForRuleVersion(this.pool, companyId, version.id, asOfDate);
      candidates.forEach((employeeId) => employeeIds.add(employeeId));
    }
    return [...employeeIds].sort().map((employeeId) => ({ employeeId, categoryId }));
  }

  private async fullCompanyImpact(companyId: string, asOfDate: string): Promise<ReconciliationScope[]> {
    const result = await this.pool.query<{ employee_id: string; category_id: string }>(
      `SELECT e.id AS employee_id, pc.id AS category_id
         FROM employees e
         JOIN employee_versions ev
           ON ev.company_id = e.company_id AND ev.employee_id = e.id
          AND ev.valid_from <= $2::date AND (ev.valid_to IS NULL OR ev.valid_to > $2::date)
         CROSS JOIN policy_categories pc
        WHERE e.company_id = $1 AND pc.company_id = $1
        ORDER BY e.id, pc.id`,
      [companyId, asOfDate],
    );
    return result.rows.map((row) => ({ employeeId: row.employee_id, categoryId: row.category_id }));
  }

  private async allEmployeeIds(db: Queryable, companyId: string, asOfDate: string): Promise<string[]> {
    const result = await db.query<{ id: string }>(
      `SELECT e.id FROM employees e
        JOIN employee_versions ev ON ev.company_id = e.company_id AND ev.employee_id = e.id
          AND ev.valid_from <= $2::date AND (ev.valid_to IS NULL OR ev.valid_to > $2::date)
        WHERE e.company_id = $1 ORDER BY e.id`,
      [companyId, asOfDate],
    );
    return result.rows.map((row) => row.id);
  }

  private async applySelector(
    db: Queryable,
    companyId: string,
    dependency: DependencyRow,
    asOfDate: string,
  ): Promise<string[] | null> {
    if (dependency.dependency_type === 'GROUP' && dependency.operator === 'MEMBER_OF') {
      const result = await db.query<{ employee_id: string }>(
        `SELECT gm.employee_id
           FROM group_memberships gm
           JOIN employee_versions ev
             ON ev.company_id = gm.company_id AND ev.employee_id = gm.employee_id
            AND ev.valid_from <= $3::date AND (ev.valid_to IS NULL OR ev.valid_to > $3::date)
          WHERE gm.company_id = $1 AND gm.group_id = $2
            AND gm.valid_from <= $3::date AND (gm.valid_to IS NULL OR gm.valid_to > $3::date)
          ORDER BY gm.employee_id`,
        [companyId, dependency.dependency_key, asOfDate],
      );
      return result.rows.map((row) => row.employee_id);
    }
    if (dependency.operator !== 'EQ' && dependency.operator !== 'IN') return null;
    const columns: Readonly<Record<string, string>> = {
      external_id: 'e.external_id',
      email: 'ev.email',
      location: 'ev.location',
      department: 'ev.department',
      employment_type: 'ev.employment_type',
      is_manager: 'ev.is_manager',
      hire_date: 'ev.hire_date',
    };
    let expression: string;
    const parameters: unknown[] = [companyId, asOfDate, JSON.stringify(dependency.selector_value)];
    if (dependency.dependency_type === 'FIELD') {
      const column = columns[dependency.dependency_key];
      if (column === undefined) return null;
      expression = `to_jsonb(${column})`;
    } else if (dependency.dependency_type === 'ATTRIBUTE') {
      expression = 'ev.attributes -> $4';
      parameters.push(dependency.dependency_key);
    } else {
      return null;
    }
    const predicate = dependency.operator === 'EQ'
      ? `${expression} = $3::jsonb`
      : `$3::jsonb @> jsonb_build_array(${expression})`;
    const result = await db.query<{ id: string }>(
      `SELECT e.id
         FROM employees e
         JOIN employee_versions ev
           ON ev.company_id = e.company_id AND ev.employee_id = e.id
          AND ev.valid_from <= $2::date AND (ev.valid_to IS NULL OR ev.valid_to > $2::date)
        WHERE e.company_id = $1 AND ${predicate}
        ORDER BY e.id`,
      parameters,
    );
    return result.rows.map((row) => row.id);
  }
}

function scopeOrder(left: ReconciliationScope, right: ReconciliationScope): number {
  return left.employeeId.localeCompare(right.employeeId) || left.categoryId.localeCompare(right.categoryId);
}
