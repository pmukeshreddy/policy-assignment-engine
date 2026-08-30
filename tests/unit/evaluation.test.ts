import { describe, expect, it } from 'vitest';
import { compileRule, type EmployeeSnapshot } from '../../src/domain/rules.js';
import { PolicyEvaluator, type EvaluatableRule } from '../../src/services/evaluation.js';

const snapshot: EmployeeSnapshot = {
  id: 'e', companyId: 'c', versionId: 'v', externalId: 'E', email: null, location: 'CA', department: null,
  employmentType: 'full_time', isManager: false, hireDate: '2024-01-01', attributes: {}, groupIds: new Set(),
  asOfDate: '2025-12-30',
};

function rule(id: string, policyId: string, priority: number, condition: unknown): EvaluatableRule {
  const compiled = compileRule(condition);
  return {
    ruleId: id, ruleVersionId: id, policyId, categoryId: 'cat', priority, enabled: true,
    validFrom: '2020-01-01', validTo: null, condition: compiled.condition, contentHash: compiled.contentHash,
    specificity: compiled.specificity, policyEnabled: true,
  };
}

describe('production category evaluation', () => {
  it('separates matching from resolution and retains trace for rejected competitors', () => {
    const evaluator = new PolicyEvaluator();
    const result = evaluator.evaluateCategory({ snapshot, categoryId: 'cat', cardinality: 'SINGLE', rules: [
      rule('r1', 'standard', 10, { type: 'comparison', fact: { kind: 'as_of_date' }, operator: 'GTE', value: '2000-01-01' }),
      rule('r2', 'enhanced', 20, { type: 'comparison', fact: { kind: 'employee', field: 'location' }, operator: 'EQ', value: 'CA' }),
    ], overrides: [] });
    expect(result.candidates).toHaveLength(2);
    expect(result.winners[0]?.policyId).toBe('enhanced');
    expect(result.rejected[0]?.reason).toMatch(/higher priority/);
    expect(result.candidates[0]?.trace?.length).toBeGreaterThan(0);
  });

  it('schedules future tenure and override boundaries', () => {
    const evaluator = new PolicyEvaluator();
    const result = evaluator.evaluateCategory({ snapshot, categoryId: 'cat', cardinality: 'SINGLE', rules: [
      rule('r-tenure', 'enhanced', 20, { type: 'comparison', fact: { kind: 'tenure_days' }, operator: 'GTE', value: 730 }),
    ], overrides: [{ id: 'override', policyId: 'standard', categoryId: 'cat', action: 'ASSIGN', priority: 1, reason: 'temporary', validFrom: '2026-01-05', validTo: '2026-02-01' }] });
    expect(result.nextTransitionDate).toBe('2025-12-31');
    expect(result.transitions.map((transition) => transition.date)).toEqual(['2025-12-31', '2026-01-05', '2026-02-01']);
  });
});
