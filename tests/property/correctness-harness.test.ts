import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { AssignmentCandidate, Cardinality } from '../../src/domain/resolution.js';
import { compileRule, type EmployeeSnapshot, type RuleCondition } from '../../src/domain/rules.js';
import { PolicyEvaluator, type EvaluatableOverride, type EvaluatableRule } from '../../src/services/evaluation.js';

interface Model {
  date: string;
  employees: EmployeeSnapshot[];
  categories: Map<string, Cardinality>;
  rules: EvaluatableRule[];
  overrides: Map<string, EvaluatableOverride[]>;
  incremental: Map<string, string[]>;
}

const evaluator = new PolicyEvaluator();
const groupId = '00000000-0000-4000-8000-000000000001';

describe('randomized incremental reconciliation correctness harness', () => {
  it('matches an independent full-recomputation oracle after every random mutation', () => {
    fc.assert(
      fc.property(fc.array(fc.integer(), { minLength: 30, maxLength: 60 }), (mutations) => {
        const model = initialModel();
        reconcileIncremental(model, allScopes(model));
        expectStateToMatchOracle(model);
        for (const mutation of mutations) {
          const scopes = applyMutation(model, Math.abs(mutation));
          reconcileIncremental(model, scopes);
          expectStateToMatchOracle(model);
          const beforeRetry = serialize(model.incremental);
          reconcileIncremental(model, scopes);
          expect(serialize(model.incremental)).toBe(beforeRetry);
        }
      }),
      { numRuns: 100, seed: 20_260_830, endOnFailure: true },
    );
  });

  it('does not evaluate an unrelated category for an unrelated attribute change', () => {
    const model = initialModel();
    reconcileIncremental(model, allScopes(model));
    model.employees[0] = { ...model.employees[0]!, attributes: { ...model.employees[0]!.attributes, favorite_color: 'green' } };
    const affected = employeeDependencyScopes(model, model.employees[0]!.id, 'ATTRIBUTE', 'favorite_color');
    expect(affected).toEqual([]);
    expectStateToMatchOracle(model);
  });
});

function initialModel(): Model {
  const categories = new Map<string, Cardinality>([['single', 'SINGLE'], ['multiple', 'MULTIPLE']]);
  const locations = ['CA', 'NY', 'TX'];
  const employees = Array.from({ length: 8 }, (_, index): EmployeeSnapshot => ({
    id: `employee-${index}`,
    companyId: 'company',
    versionId: `version-${index}-0`,
    externalId: `E-${index}`,
    email: null,
    location: locations[index % locations.length]!,
    department: index % 2 === 0 ? 'Engineering' : 'Sales',
    employmentType: index % 3 === 0 ? 'contractor' : 'full_time',
    isManager: index % 4 === 0,
    hireDate: addDays('2026-01-01', -(index * 160)),
    attributes: { country: 'US', level: index },
    groupIds: index % 2 === 0 ? new Set([groupId]) : new Set(),
    asOfDate: '2026-08-01',
  }));
  const rules = [
    makeRule('r0', 'single', 'standard', 10, { type: 'comparison', fact: { kind: 'as_of_date' }, operator: 'GTE', value: '2000-01-01' }),
    makeRule('r1', 'single', 'enhanced', 20, { type: 'comparison', fact: { kind: 'employee', field: 'location' }, operator: 'EQ', value: 'CA' }),
    makeRule('r2', 'single', 'enhanced', 15, { type: 'comparison', fact: { kind: 'tenure_days' }, operator: 'GTE', value: 730 }),
    makeRule('r3', 'multiple', 'github', 10, { type: 'comparison', fact: { kind: 'employee', field: 'department' }, operator: 'EQ', value: 'Engineering' }),
    makeRule('r4', 'multiple', 'training', 20, { type: 'comparison', fact: { kind: 'employee', field: 'is_manager' }, operator: 'EQ', value: true }),
    makeRule('r5', 'multiple', 'on-call', 30, { type: 'group', groupId, operator: 'MEMBER_OF' }),
    makeRule('r6', 'multiple', 'us-access', 5, { type: 'comparison', fact: { kind: 'attribute', key: 'country' }, operator: 'EQ', value: 'US' }),
  ];
  return { date: '2026-08-01', employees, categories, rules, overrides: new Map(), incremental: new Map() };
}

function makeRule(
  id: string,
  categoryId: string,
  policyId: string,
  priority: number,
  condition: RuleCondition,
): EvaluatableRule {
  const compiled = compileRule(condition);
  return {
    ruleId: id,
    ruleVersionId: `${id}-v1`,
    policyId,
    categoryId,
    priority,
    enabled: true,
    validFrom: '2020-01-01',
    validTo: null,
    condition: compiled.condition,
    contentHash: compiled.contentHash,
    specificity: compiled.specificity,
    policyEnabled: true,
  };
}

function applyMutation(model: Model, seed: number): Array<[string, string]> {
  const employee = model.employees[seed % model.employees.length]!;
  const operation = seed % 7;
  if (operation === 0) {
    const locations = ['CA', 'NY', 'TX'];
    employee.location = locations[(locations.indexOf(employee.location ?? 'CA') + 1) % locations.length]!;
    employee.versionId = `${employee.versionId}-l`;
    return employeeDependencyScopes(model, employee.id, 'FIELD', 'location');
  }
  if (operation === 1) {
    employee.department = employee.department === 'Engineering' ? 'Sales' : 'Engineering';
    employee.versionId = `${employee.versionId}-d`;
    return employeeDependencyScopes(model, employee.id, 'FIELD', 'department');
  }
  if (operation === 2) {
    employee.groupIds = employee.groupIds.has(groupId) ? new Set() : new Set([groupId]);
    employee.versionId = `${employee.versionId}-g`;
    return employeeDependencyScopes(model, employee.id, 'GROUP', groupId);
  }
  if (operation === 3) {
    const rule = model.rules[seed % model.rules.length]!;
    rule.priority = ((rule.priority + seed) % 41) - 10;
    return model.employees.map((item) => [item.id, rule.categoryId]);
  }
  if (operation === 4) {
    const rule = model.rules[seed % model.rules.length]!;
    rule.enabled = !rule.enabled;
    return model.employees.map((item) => [item.id, rule.categoryId]);
  }
  if (operation === 5) {
    const key = `${employee.id}:single`;
    if ((model.overrides.get(key) ?? []).length > 0) {
      model.overrides.delete(key);
    } else {
      model.overrides.set(key, [{
        id: `override-${employee.id}-${seed}`,
        policyId: seed % 2 === 0 ? 'standard' : 'enhanced',
        categoryId: 'single',
        action: seed % 3 === 0 ? 'EXCLUDE' : 'ASSIGN',
        priority: seed % 10,
        reason: 'randomized test override',
        validFrom: '2020-01-01',
        validTo: null,
      }]);
    }
    return [[employee.id, 'single']];
  }
  model.date = addDays(model.date, 1 + (seed % 45));
  model.employees = model.employees.map((item) => ({ ...item, asOfDate: model.date }));
  return allScopes(model);
}

function employeeDependencyScopes(
  model: Model,
  employeeId: string,
  type: 'FIELD' | 'ATTRIBUTE' | 'GROUP',
  key: string,
): Array<[string, string]> {
  return [...new Set(model.rules.filter((rule) => {
    const compiled = compileRule(rule.condition);
    return compiled.dependencies.some((dependency) => dependency.type === type && dependency.key === key);
  }).map((rule) => rule.categoryId))].map((categoryId) => [employeeId, categoryId]);
}

function allScopes(model: Model): Array<[string, string]> {
  return model.employees.flatMap((employee) => [...model.categories.keys()].map((categoryId): [string, string] => [employee.id, categoryId]));
}

function reconcileIncremental(model: Model, scopes: Array<[string, string]>): void {
  for (const scopeKey of new Set(scopes.map(([employee, category]) => `${employee}|${category}`))) {
    const [parsedEmployeeId, parsedCategoryId] = scopeKey.split('|') as [string, string];
    const employee = model.employees.find((item) => item.id === parsedEmployeeId)!;
    const result = evaluator.evaluateCategory({
      snapshot: employee,
      categoryId: parsedCategoryId,
      cardinality: model.categories.get(parsedCategoryId)!,
      rules: model.rules.filter((rule) => rule.categoryId === parsedCategoryId),
      overrides: model.overrides.get(`${parsedEmployeeId}:${parsedCategoryId}`) ?? [],
    });
    model.incremental.set(`${parsedEmployeeId}:${parsedCategoryId}`, result.winners.map((winner) => winner.policyId).sort());
  }
}

function expectStateToMatchOracle(model: Model): void {
  const oracle = fullOracle(model);
  expect(serialize(model.incremental)).toBe(serialize(oracle));
  for (const employee of model.employees) {
    expect(model.incremental.get(`${employee.id}:single`)?.length ?? 0).toBeLessThanOrEqual(1);
  }
}

function fullOracle(model: Model): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const employee of model.employees) {
    for (const [categoryId, cardinality] of model.categories) {
      const candidates: AssignmentCandidate[] = [];
      for (const rule of model.rules.filter((item) => item.categoryId === categoryId)) {
        if (!rule.enabled || rule.validFrom > model.date || (rule.validTo !== null && rule.validTo <= model.date)) continue;
        if (!oracleMatches(rule.condition, employee)) continue;
        candidates.push({
          candidateId: `rule:${rule.ruleVersionId}`, categoryId, policyId: rule.policyId, source: 'RULE', action: 'ASSIGN',
          priority: rule.priority, specificity: oracleSpecificity(rule.condition),
        });
      }
      for (const override of model.overrides.get(`${employee.id}:${categoryId}`) ?? []) {
        candidates.push({
          candidateId: `manual:${override.id}`, categoryId, policyId: override.policyId, source: 'MANUAL',
          action: override.action, priority: override.priority, specificity: Number.MAX_SAFE_INTEGER,
        });
      }
      result.set(`${employee.id}:${categoryId}`, oracleResolve(cardinality, candidates));
    }
  }
  return result;
}

function oracleMatches(condition: RuleCondition, employee: EmployeeSnapshot): boolean {
  if (condition.type === 'and') return condition.conditions.every((child) => oracleMatches(child, employee));
  if (condition.type === 'or') return condition.conditions.some((child) => oracleMatches(child, employee));
  if (condition.type === 'not') return !oracleMatches(condition.condition, employee);
  if (condition.type === 'group') {
    const member = employee.groupIds.has(condition.groupId);
    return condition.operator === 'MEMBER_OF' ? member : !member;
  }
  let actual: unknown;
  if (condition.fact.kind === 'employee') {
    const facts: Record<string, unknown> = {
      external_id: employee.externalId, email: employee.email, location: employee.location,
      department: employee.department, employment_type: employee.employmentType,
      is_manager: employee.isManager, hire_date: employee.hireDate,
    };
    actual = facts[condition.fact.field];
  } else if (condition.fact.kind === 'attribute') actual = employee.attributes[condition.fact.key];
  else if (condition.fact.kind === 'as_of_date') actual = employee.asOfDate;
  else actual = employee.hireDate === null ? undefined : day(employee.asOfDate) - day(employee.hireDate);
  if (actual === undefined) return false;
  const expected = condition.value;
  if (condition.operator === 'IN' || condition.operator === 'NOT_IN') {
    const includes = (expected as unknown[]).some((item) => JSON.stringify(item) === JSON.stringify(actual));
    return condition.operator === 'IN' ? includes : !includes;
  }
  if (condition.operator === 'EQ') return actual === expected;
  if (condition.operator === 'NE') return actual !== expected;
  if ((typeof actual !== 'number' && typeof actual !== 'string') || typeof actual !== typeof expected) return false;
  const comparison = typeof actual === 'number'
    ? actual - (expected as number)
    : actual.localeCompare(expected as string);
  if (condition.operator === 'GT') return comparison > 0;
  if (condition.operator === 'GTE') return comparison >= 0;
  if (condition.operator === 'LT') return comparison < 0;
  return comparison <= 0;
}

function oracleResolve(cardinality: Cardinality, candidates: AssignmentCandidate[]): string[] {
  const byPolicy = new Map<string, AssignmentCandidate[]>();
  for (const item of candidates) byPolicy.set(item.policyId, [...(byPolicy.get(item.policyId) ?? []), item]);
  const eligible: AssignmentCandidate[] = [];
  for (const values of byPolicy.values()) {
    values.sort(oraclePrecedence);
    if (values[0]?.action === 'ASSIGN') eligible.push(values[0]);
  }
  eligible.sort(oraclePrecedence);
  return (cardinality === 'SINGLE' ? eligible.slice(0, 1) : eligible).map((item) => item.policyId).sort();
}

function oraclePrecedence(left: AssignmentCandidate, right: AssignmentCandidate): number {
  if (left.source !== right.source) return left.source === 'MANUAL' ? -1 : 1;
  if (left.priority !== right.priority) return right.priority - left.priority;
  if (left.specificity !== right.specificity) return right.specificity - left.specificity;
  return left.candidateId < right.candidateId ? -1 : left.candidateId > right.candidateId ? 1 : left.policyId.localeCompare(right.policyId);
}

function oracleSpecificity(condition: RuleCondition): number {
  if (condition.type === 'comparison' || condition.type === 'group') return 1;
  if (condition.type === 'not') return oracleSpecificity(condition.condition);
  return condition.conditions.reduce((sum, child) => sum + oracleSpecificity(child), 0);
}

function serialize(value: Map<string, string[]>): string {
  return JSON.stringify([...value.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function day(date: string): number { return Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000); }
function addDays(date: string, days: number): string { return new Date((day(date) + days) * 86_400_000).toISOString().slice(0, 10); }
