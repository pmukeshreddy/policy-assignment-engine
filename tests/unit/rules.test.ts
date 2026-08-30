import { describe, expect, it } from 'vitest';
import { compileRule, RuleCompilerCache, type EmployeeSnapshot } from '../../src/domain/rules.js';

const snapshot: EmployeeSnapshot = {
  id: 'employee-1',
  companyId: 'company-1',
  versionId: 'version-1',
  externalId: 'E-1',
  email: 'employee@example.test',
  location: 'CA',
  department: 'Engineering',
  employmentType: 'full_time',
  isManager: false,
  hireDate: '2024-01-01',
  attributes: { level: 4, country: 'US', tags: ['on-call'] },
  groupIds: new Set(['00000000-0000-4000-8000-000000000001']),
  asOfDate: '2025-12-30',
};

describe('typed rule compiler and evaluator', () => {
  it('evaluates nested boolean conditions with an inspectable trace', () => {
    const rule = compileRule({
      type: 'and',
      conditions: [
        { type: 'comparison', fact: { kind: 'employee', field: 'location' }, operator: 'EQ', value: 'CA' },
        {
          type: 'or',
          conditions: [
            { type: 'comparison', fact: { kind: 'attribute', key: 'level' }, operator: 'GTE', value: 4 },
            { type: 'comparison', fact: { kind: 'employee', field: 'is_manager' }, operator: 'EQ', value: true },
          ],
        },
        {
          type: 'not',
          condition: { type: 'comparison', fact: { kind: 'employee', field: 'employment_type' }, operator: 'EQ', value: 'contractor' },
        },
      ],
    });
    const result = rule.evaluate(snapshot);
    expect(result.matched).toBe(true);
    expect(result.trace).toEqual(expect.arrayContaining([
      expect.objectContaining({ fact: 'employee.location', actual: 'CA', matched: true }),
      expect.objectContaining({ fact: 'employee.attributes.level', actual: 4, matched: true }),
    ]));
  });

  it('supports IN, group membership, and treats missing values explicitly as non-matches', () => {
    expect(compileRule({
      type: 'comparison', fact: { kind: 'employee', field: 'location' }, operator: 'IN', value: ['CA', 'NY'],
    }).evaluate(snapshot).matched).toBe(true);
    expect(compileRule({
      type: 'group', groupId: '00000000-0000-4000-8000-000000000001', operator: 'MEMBER_OF',
    }).evaluate(snapshot).matched).toBe(true);
    expect(compileRule({
      type: 'comparison', fact: { kind: 'attribute', key: 'missing' }, operator: 'NE', value: 'anything',
    }).evaluate(snapshot).matched).toBe(false);
  });

  it('extracts complete dependencies and only sound mandatory selectors', () => {
    const rule = compileRule({
      type: 'and',
      conditions: [
        { type: 'comparison', fact: { kind: 'employee', field: 'department' }, operator: 'EQ', value: 'Engineering' },
        {
          type: 'or',
          conditions: [
            { type: 'comparison', fact: { kind: 'employee', field: 'location' }, operator: 'EQ', value: 'CA' },
            { type: 'comparison', fact: { kind: 'employee', field: 'location' }, operator: 'EQ', value: 'NY' },
          ],
        },
        { type: 'comparison', fact: { kind: 'tenure_days' }, operator: 'GTE', value: 730 },
      ],
    });
    expect(rule.dependencies.map((dependency) => `${dependency.type}:${dependency.key}`)).toEqual([
      'FIELD:department', 'FIELD:hire_date', 'FIELD:location', 'TIME:tenure_days',
    ]);
    expect(rule.dependencies.find((dependency) => dependency.key === 'department')?.mandatorySelector).toBe(true);
    expect(rule.dependencies.find((dependency) => dependency.key === 'location')?.mandatorySelector).toBe(false);
  });

  it('schedules the exact next tenure transition without a source row mutation', () => {
    const result = compileRule({
      type: 'comparison', fact: { kind: 'tenure_days' }, operator: 'GTE', value: 730,
    }).evaluate(snapshot);
    expect(result.matched).toBe(false);
    expect(result.nextTransitionDate).toBe('2025-12-31');
  });

  it('schedules calendar-date comparisons without a source row mutation', () => {
    const result = compileRule({
      type: 'comparison', fact: { kind: 'as_of_date' }, operator: 'GTE', value: '2026-01-15',
    }).evaluate(snapshot);
    expect(result.matched).toBe(false);
    expect(result.nextTransitionDate).toBe('2026-01-15');
  });

  it('rejects executable or malformed rules and detects mutated immutable versions', () => {
    expect(() => compileRule({ type: 'javascript', source: 'return true' })).toThrow();
    const one = compileRule({
      type: 'comparison', fact: { kind: 'employee', field: 'location' }, operator: 'EQ', value: 'CA',
    });
    const cache = new RuleCompilerCache();
    cache.get('version-1', one.condition, one.contentHash);
    expect(() => cache.get('version-1', one.condition, 'wrong-hash')).toThrow(/content hash changed/);
  });
});
