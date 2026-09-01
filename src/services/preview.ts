import type { DbPool } from '../db.js';
import { AppError, notFound } from '../errors.js';
import { compileRule, type ConditionTrace, type EmployeeSnapshot, type RuleCondition } from '../domain/rules.js';
import { PolicyEvaluator, type EvaluatableOverride, type EvaluatableRule } from './evaluation.js';
import {
  listCategoryIds,
  loadCategory,
  loadEmployeeSnapshot,
  loadOverridesForCategory,
  loadRulesForCategory,
} from './repository.js';

interface EmployeeRow {
  id: string;
  company_id: string;
  version_id: string;
  external_id: string;
  display_name: string;
  email: string | null;
  location: string | null;
  department: string | null;
  employment_type: string | null;
  is_manager: boolean;
  hire_date: string | null;
  attributes: Record<string, unknown>;
  group_ids: string[];
}

interface OverrideRow {
  id: string;
  employee_id: string;
  policy_id: string;
  category_id: string;
  action: 'ASSIGN' | 'EXCLUDE';
  priority: number;
  reason: string;
  valid_from: string;
  valid_to: string | null;
}

export interface PreviewResult {
  employeesEvaluated: number;
  affectedEmployees: number;
  assignmentsAdded: number;
  assignmentsRemoved: number;
  assignmentsChanged: number;
  unchangedEmployees: number;
  examples: Array<{
    employeeId: string;
    displayName: string;
    beforePolicyIds: string[];
    afterPolicyIds: string[];
    addedPolicyIds: string[];
    removedPolicyIds: string[];
  }>;
}

interface PreviewPolicy {
  id: string;
  key: string;
  name: string;
  categoryId: string;
  categoryKey: string;
  categoryName: string;
}

interface PreviewCandidate extends PreviewPolicy {
  candidateId: string;
  source: 'RULE' | 'MANUAL';
  action: 'ASSIGN' | 'EXCLUDE';
  priority: number;
  specificity: number;
  ruleId?: string;
  ruleVersionId?: string;
  overrideId?: string;
  trace?: readonly ConditionTrace[];
  reason?: string;
}

export interface EmployeeAssignmentPreviewResult {
  asOfDate: string;
  employeeId: string | null;
  summary: {
    categoriesChanged: number;
    assignmentsAdded: number;
    assignmentsRemoved: number;
    assignmentsReplaced: number;
    assignmentsUnchanged: number;
  };
  categories: Array<{
    id: string;
    key: string;
    name: string;
    cardinality: 'SINGLE' | 'MULTIPLE';
    changed: boolean;
    before: PreviewPolicy[];
    after: PreviewCandidate[];
    candidates: PreviewCandidate[];
    rejected: Array<{ candidate: PreviewCandidate; reason: string; wonByCandidateId?: string }>;
  }>;
}

export class PreviewService {
  constructor(
    private readonly pool: DbPool,
    private readonly maxEmployees: number,
    private readonly evaluator = new PolicyEvaluator(),
  ) {}

  async previewEmployee(input: {
    companyId: string;
    asOfDate: string;
    employeeId?: string;
    externalId?: string;
    email?: string | null;
    location?: string | null;
    department?: string | null;
    employmentType?: string | null;
    isManager?: boolean;
    hireDate?: string | null;
    attributes?: Record<string, unknown>;
    groupIds?: string[];
  }): Promise<EmployeeAssignmentPreviewResult> {
    const existing = input.employeeId === undefined
      ? null
      : await loadEmployeeSnapshot(this.pool, input.companyId, input.employeeId, input.asOfDate);
    if (input.employeeId !== undefined && existing === null) throw notFound('Employee');
    const groupIds = input.groupIds === undefined ? [...(existing?.groupIds ?? [])] : [...new Set(input.groupIds)];
    if (groupIds.length > 0) {
      const groups = await this.pool.query<{ id: string }>(
        'SELECT id FROM groups WHERE company_id = $1 AND id = ANY($2::uuid[])',
        [input.companyId, groupIds],
      );
      if (groups.rowCount !== groupIds.length) throw new AppError('One or more groups do not belong to this company', 422, 'INVALID_REFERENCE');
    }
    const snapshot: EmployeeSnapshot = {
      id: existing?.id ?? 'preview-employee',
      companyId: input.companyId,
      versionId: existing?.versionId ?? 'preview-version',
      externalId: input.externalId ?? existing?.externalId ?? 'preview-employee',
      email: input.email === undefined ? existing?.email ?? null : input.email,
      location: input.location === undefined ? existing?.location ?? null : input.location,
      department: input.department === undefined ? existing?.department ?? null : input.department,
      employmentType: input.employmentType === undefined ? existing?.employmentType ?? null : input.employmentType,
      isManager: input.isManager ?? existing?.isManager ?? false,
      hireDate: input.hireDate === undefined ? existing?.hireDate ?? null : input.hireDate,
      attributes: input.attributes ?? existing?.attributes ?? {},
      groupIds: new Set(groupIds),
      asOfDate: input.asOfDate,
    };
    const [categoryIds, policyResult, assignmentResult] = await Promise.all([
      listCategoryIds(this.pool, input.companyId),
      this.pool.query<{
        id: string; key: string; name: string; category_id: string; category_key: string; category_name: string;
      }>(
        `SELECT p.id, p.key, pv.name, p.category_id, pc.key AS category_key, pc.name AS category_name
           FROM policies p
           JOIN policy_categories pc ON pc.company_id = p.company_id AND pc.id = p.category_id
           JOIN policy_versions pv ON pv.company_id = p.company_id AND pv.policy_id = p.id
            AND pv.valid_from <= $2::date AND (pv.valid_to IS NULL OR pv.valid_to > $2::date)
          WHERE p.company_id = $1
          ORDER BY pc.name, pv.name, p.id`,
        [input.companyId, input.asOfDate],
      ),
      input.employeeId === undefined
        ? Promise.resolve({ rows: [] } as { rows: Array<{ category_id: string; policy_id: string }> })
        : this.pool.query<{ category_id: string; policy_id: string }>(
          `SELECT category_id, policy_id
             FROM materialized_assignments
            WHERE company_id = $1 AND employee_id = $2
            ORDER BY category_id, policy_id`,
          [input.companyId, input.employeeId],
        ),
    ]);
    const policies = new Map<string, PreviewPolicy>(policyResult.rows.map((row) => [row.id, {
      id: row.id,
      key: row.key,
      name: row.name,
      categoryId: row.category_id,
      categoryKey: row.category_key,
      categoryName: row.category_name,
    }]));
    const beforeByCategory = groupRows(assignmentResult.rows, (row) => row.category_id);
    const categories: EmployeeAssignmentPreviewResult['categories'] = [];
    let assignmentsAdded = 0;
    let assignmentsRemoved = 0;
    let assignmentsReplaced = 0;
    let assignmentsUnchanged = 0;
    for (const categoryId of categoryIds) {
      const [category, rules, overrides] = await Promise.all([
        loadCategory(this.pool, input.companyId, categoryId),
        loadRulesForCategory(this.pool, input.companyId, categoryId, input.asOfDate),
        input.employeeId === undefined
          ? Promise.resolve([])
          : loadOverridesForCategory(this.pool, input.companyId, input.employeeId, categoryId, input.asOfDate),
      ]);
      if (category === null) continue;
      const evaluation = this.evaluator.evaluateCategory({
        snapshot,
        categoryId,
        cardinality: category.cardinality,
        rules,
        overrides,
      });
      const before = (beforeByCategory.get(categoryId) ?? [])
        .map((row) => policies.get(row.policy_id))
        .filter((policy): policy is PreviewPolicy => policy !== undefined)
        .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
      const enrich = (candidate: (typeof evaluation.candidates)[number]): PreviewCandidate => {
        const policy = policies.get(candidate.policyId);
        if (policy === undefined) throw new Error(`Preview candidate references unknown policy ${candidate.policyId}`);
        return {
          ...policy,
          candidateId: candidate.candidateId,
          source: candidate.source,
          action: candidate.action,
          priority: candidate.priority,
          specificity: candidate.specificity,
          ...(candidate.ruleId === undefined ? {} : { ruleId: candidate.ruleId }),
          ...(candidate.ruleVersionId === undefined ? {} : { ruleVersionId: candidate.ruleVersionId }),
          ...(candidate.overrideId === undefined ? {} : { overrideId: candidate.overrideId }),
          ...(candidate.trace === undefined ? {} : { trace: candidate.trace }),
          ...(candidate.reason === undefined ? {} : { reason: candidate.reason }),
        };
      };
      const after = evaluation.winners.map(enrich);
      const beforeIds = new Set(before.map((policy) => policy.id));
      const afterIds = new Set(after.map((policy) => policy.id));
      const added = after.filter((policy) => !beforeIds.has(policy.id)).length;
      const removed = before.filter((policy) => !afterIds.has(policy.id)).length;
      const unchanged = after.filter((policy) => beforeIds.has(policy.id)).length;
      const changed = added > 0 || removed > 0;
      assignmentsAdded += added;
      assignmentsRemoved += removed;
      assignmentsUnchanged += unchanged;
      if (category.cardinality === 'SINGLE' && added > 0 && removed > 0) assignmentsReplaced += 1;
      categories.push({
        id: category.id,
        key: category.key,
        name: category.name,
        cardinality: category.cardinality,
        changed,
        before,
        after,
        candidates: evaluation.candidates.map(enrich),
        rejected: evaluation.rejected.map((item) => ({
          candidate: enrich(item.candidate),
          reason: item.reason,
          ...(item.wonByCandidateId === undefined ? {} : { wonByCandidateId: item.wonByCandidateId }),
        })),
      });
    }
    return {
      asOfDate: input.asOfDate,
      employeeId: input.employeeId ?? null,
      summary: {
        categoriesChanged: categories.filter((category) => category.changed).length,
        assignmentsAdded,
        assignmentsRemoved,
        assignmentsReplaced,
        assignmentsUnchanged,
      },
      categories,
    };
  }

  async previewRule(input: {
    companyId: string;
    asOfDate: string;
    ruleId?: string;
    policyId: string;
    priority: number;
    enabled: boolean;
    validFrom: string;
    validTo: string | null;
    condition: RuleCondition;
    exampleLimit?: number;
  }): Promise<PreviewResult> {
    const policyResult = await this.pool.query<{ category_id: string }>(
      'SELECT category_id FROM policies WHERE company_id = $1 AND id = $2',
      [input.companyId, input.policyId],
    );
    const categoryId = policyResult.rows[0]?.category_id;
    if (categoryId === undefined) throw notFound('Policy');
    if (input.ruleId !== undefined) {
      const identityCategory = await this.pool.query<{ category_id: string }>(
        `SELECT p.category_id
           FROM rule_versions rv
           JOIN policies p ON p.company_id = rv.company_id AND p.id = rv.policy_id
          WHERE rv.company_id = $1 AND rv.rule_id = $2
          ORDER BY rv.version
          LIMIT 1`,
        [input.companyId, input.ruleId],
      );
      const existingCategoryId = identityCategory.rows[0]?.category_id;
      if (existingCategoryId === undefined) throw notFound('Rule');
      if (existingCategoryId !== categoryId) {
        throw new AppError(
          'A rule identity cannot move between policy categories; create a new rule identity',
          422,
          'RULE_CATEGORY_IMMUTABLE',
        );
      }
    }
    const category = await loadCategory(this.pool, input.companyId, categoryId);
    if (category === null) throw notFound('Policy category');
    const countResult = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM employees e
        JOIN employee_versions ev ON ev.company_id = e.company_id AND ev.employee_id = e.id
          AND ev.valid_from <= $2::date AND (ev.valid_to IS NULL OR ev.valid_to > $2::date)
        WHERE e.company_id = $1`,
      [input.companyId, input.asOfDate],
    );
    const employeeCount = Number(countResult.rows[0]?.count ?? 0);
    if (employeeCount > this.maxEmployees) {
      throw new AppError(
        `Preview population ${employeeCount} exceeds configured limit ${this.maxEmployees}`,
        422,
        'PREVIEW_POPULATION_LIMIT',
      );
    }
    const compiled = compileRule(input.condition);
    const existingRules = await loadRulesForCategory(this.pool, input.companyId, categoryId, input.asOfDate);
    const rules = existingRules.filter((rule) => input.ruleId === undefined || rule.ruleId !== input.ruleId);
    const proposed: EvaluatableRule = {
      ruleId: input.ruleId ?? '00000000-0000-0000-0000-000000000000',
      ruleVersionId: `preview-${compiled.contentHash}`,
      policyId: input.policyId,
      categoryId,
      priority: input.priority,
      enabled: input.enabled,
      validFrom: input.validFrom,
      validTo: input.validTo,
      condition: compiled.condition,
      contentHash: compiled.contentHash,
      specificity: compiled.specificity,
      policyEnabled: true,
    };
    rules.push(proposed);

    const totals: PreviewResult = {
      employeesEvaluated: 0,
      affectedEmployees: 0,
      assignmentsAdded: 0,
      assignmentsRemoved: 0,
      assignmentsChanged: 0,
      unchangedEmployees: 0,
      examples: [],
    };
    const exampleLimit = input.exampleLimit ?? 20;
    const ids = await this.pool.query<{ id: string }>(
      `SELECT e.id FROM employees e
        JOIN employee_versions ev ON ev.company_id = e.company_id AND ev.employee_id = e.id
          AND ev.valid_from <= $2::date AND (ev.valid_to IS NULL OR ev.valid_to > $2::date)
        WHERE e.company_id = $1 ORDER BY e.id`,
      [input.companyId, input.asOfDate],
    );
    for (let offset = 0; offset < ids.rows.length; offset += 500) {
      const batchIds = ids.rows.slice(offset, offset + 500).map((row) => row.id);
      await this.evaluateBatch({
        ...input,
        categoryId,
        cardinality: category.cardinality,
        rules,
        employeeIds: batchIds,
        totals,
        exampleLimit,
      });
    }
    return totals;
  }

  private async evaluateBatch(input: {
    companyId: string;
    asOfDate: string;
    categoryId: string;
    cardinality: 'SINGLE' | 'MULTIPLE';
    rules: EvaluatableRule[];
    employeeIds: string[];
    totals: PreviewResult;
    exampleLimit: number;
  }): Promise<void> {
    if (input.employeeIds.length === 0) return;
    const [employeeResult, overrideResult, assignmentResult] = await Promise.all([
      this.pool.query<EmployeeRow>(
        `SELECT e.id, e.company_id, ev.id AS version_id, e.external_id, ev.display_name,
                ev.email, ev.location, ev.department, ev.employment_type, ev.is_manager,
                ev.hire_date::text, ev.attributes,
                COALESCE(array_agg(gm.group_id::text ORDER BY gm.group_id)
                  FILTER (WHERE gm.group_id IS NOT NULL), '{}') AS group_ids
           FROM employees e
           JOIN employee_versions ev
             ON ev.company_id = e.company_id AND ev.employee_id = e.id
            AND ev.valid_from <= $3::date AND (ev.valid_to IS NULL OR ev.valid_to > $3::date)
           LEFT JOIN group_memberships gm
             ON gm.company_id = e.company_id AND gm.employee_id = e.id
            AND gm.valid_from <= $3::date AND (gm.valid_to IS NULL OR gm.valid_to > $3::date)
          WHERE e.company_id = $1 AND e.id = ANY($2::uuid[])
          GROUP BY e.id, ev.id
          ORDER BY e.id`,
        [input.companyId, input.employeeIds, input.asOfDate],
      ),
      this.pool.query<OverrideRow>(
        `SELECT mo.id, mo.employee_id, mo.policy_id, p.category_id, mo.action, mo.priority,
                mo.reason, mo.valid_from::text, mo.valid_to::text
           FROM manual_overrides mo
           JOIN policies p ON p.company_id = mo.company_id AND p.id = mo.policy_id
          WHERE mo.company_id = $1 AND mo.employee_id = ANY($2::uuid[])
            AND p.category_id = $3
            AND mo.revoked_at IS NULL
            AND (mo.valid_to IS NULL OR mo.valid_to > $4::date)
          ORDER BY mo.employee_id, mo.id`,
        [input.companyId, input.employeeIds, input.categoryId, input.asOfDate],
      ),
      this.pool.query<{ employee_id: string; policy_id: string }>(
        `SELECT employee_id, policy_id
           FROM materialized_assignments
          WHERE company_id = $1 AND employee_id = ANY($2::uuid[]) AND category_id = $3
          ORDER BY employee_id, policy_id`,
        [input.companyId, input.employeeIds, input.categoryId],
      ),
    ]);
    const overrides = groupRows(overrideResult.rows, (row) => row.employee_id);
    const assignments = groupRows(assignmentResult.rows, (row) => row.employee_id);
    for (const row of employeeResult.rows) {
      const snapshot: EmployeeSnapshot = {
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
        groupIds: new Set(row.group_ids),
        asOfDate: input.asOfDate,
      };
      const employeeOverrides: EvaluatableOverride[] = (overrides.get(row.id) ?? []).map((override) => ({
        id: override.id,
        policyId: override.policy_id,
        categoryId: override.category_id,
        action: override.action,
        priority: override.priority,
        reason: override.reason,
        validFrom: override.valid_from,
        validTo: override.valid_to,
      }));
      const evaluation = this.evaluator.evaluateCategory({
        snapshot,
        categoryId: input.categoryId,
        cardinality: input.cardinality,
        rules: input.rules,
        overrides: employeeOverrides,
      });
      const before = (assignments.get(row.id) ?? []).map((assignment) => assignment.policy_id).sort();
      const after = evaluation.winners.map((winner) => winner.policyId).sort();
      const beforeSet = new Set(before);
      const afterSet = new Set(after);
      const added = after.filter((policyId) => !beforeSet.has(policyId));
      const removed = before.filter((policyId) => !afterSet.has(policyId));
      input.totals.employeesEvaluated += 1;
      input.totals.assignmentsAdded += added.length;
      input.totals.assignmentsRemoved += removed.length;
      if (added.length === 0 && removed.length === 0) {
        input.totals.unchangedEmployees += 1;
        continue;
      }
      input.totals.affectedEmployees += 1;
      if (added.length > 0 && removed.length > 0) input.totals.assignmentsChanged += 1;
      if (input.totals.examples.length < input.exampleLimit) {
        input.totals.examples.push({
          employeeId: row.id,
          displayName: row.display_name,
          beforePolicyIds: before,
          afterPolicyIds: after,
          addedPolicyIds: added,
          removedPolicyIds: removed,
        });
      }
    }
  }
}

function groupRows<Row>(rows: readonly Row[], key: (row: Row) => string): Map<string, Row[]> {
  const grouped = new Map<string, Row[]>();
  for (const row of rows) grouped.set(key(row), [...(grouped.get(key(row)) ?? []), row]);
  return grouped;
}
