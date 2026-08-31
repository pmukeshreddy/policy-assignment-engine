import { describe, expect, it } from 'vitest';
import type { RuleCondition } from '../../src/domain/rules.js';
import { oracleMatchesCondition, oracleResolvePolicyIds, type OracleEmployeeSnapshot } from '../../src/eval/oracle.js';

const employee: OracleEmployeeSnapshot = {
  id: 'employee',
  externalId: 'external',
  email: null,
  location: 'QUEENS',
  department: 'AGENCY',
  employmentType: 'per Annum',
  isManager: false,
  hireDate: '2020-01-01',
  attributes: { job_title: 'ANALYST', employment_status: 'ACTIVE' },
  groupIds: new Set(['00000000-0000-4000-8000-000000000001']),
  asOfDate: '2025-06-30',
};

describe('independent full-recompute oracle', () => {
  it('evaluates nested facts, tenure, and groups without the production compiler', () => {
    const condition: RuleCondition = {
      type: 'and',
      conditions: [
        { type: 'comparison', fact: { kind: 'employee', field: 'location' }, operator: 'EQ', value: 'QUEENS' },
        { type: 'comparison', fact: { kind: 'attribute', key: 'job_title' }, operator: 'EQ', value: 'ANALYST' },
        { type: 'comparison', fact: { kind: 'tenure_days' }, operator: 'GTE', value: 1_000 },
        { type: 'group', groupId: '00000000-0000-4000-8000-000000000001', operator: 'MEMBER_OF' },
      ],
    };
    expect(oracleMatchesCondition(condition, employee)).toBe(true);
  });

  it('independently applies manual precedence, exclusions, and cardinality', () => {
    const candidates = [
      { candidateId: 'rule:a', policyId: 'one', categoryId: 'category', source: 'RULE' as const, action: 'ASSIGN' as const, priority: 100, specificity: 1 },
      { candidateId: 'manual:b', policyId: 'two', categoryId: 'category', source: 'MANUAL' as const, action: 'ASSIGN' as const, priority: -100, specificity: Number.MAX_SAFE_INTEGER },
      { candidateId: 'manual:c', policyId: 'one', categoryId: 'category', source: 'MANUAL' as const, action: 'EXCLUDE' as const, priority: 0, specificity: Number.MAX_SAFE_INTEGER },
    ];
    expect(oracleResolvePolicyIds('SINGLE', candidates)).toEqual(['two']);
    expect(oracleResolvePolicyIds('MULTIPLE', candidates)).toEqual(['two']);
  });
});
