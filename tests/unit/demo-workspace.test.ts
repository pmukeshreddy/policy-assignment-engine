import { describe, expect, it } from 'vitest';
import {
  DEMO_WORKSPACE_NAME,
  demoCategories,
  demoEmployees,
  demoGroups,
  demoOverrides,
  demoPolicies,
  demoRules,
} from '../../src/demo/workspace.js';

describe('reviewer demo workspace', () => {
  it('stays small, clearly labeled, and focused on the challenge workflows', () => {
    expect(DEMO_WORKSPACE_NAME).toBe('Policy Assignment Demo');
    expect(demoEmployees.length).toBeGreaterThanOrEqual(20);
    expect(demoEmployees.length).toBeLessThanOrEqual(40);
    expect(demoCategories).toHaveLength(6);
    expect(demoPolicies.length).toBeGreaterThanOrEqual(10);
    expect(demoPolicies.length).toBeLessThanOrEqual(15);
    expect(demoRules.length).toBeGreaterThanOrEqual(10);
    expect(demoRules.length).toBeLessThanOrEqual(20);
    expect(demoGroups).toHaveLength(4);
    expect(demoOverrides).toHaveLength(2);
  });

  it('contains deterministic conflicts, group rules, tenure, and both manual actions', () => {
    const vacationRules = demoRules.filter((rule) => ['standard-pto', 'five-year-pto', 'executive-pto'].includes(rule.policy));
    expect(vacationRules.map((rule) => rule.priority).sort((left, right) => left - right)).toEqual([100, 160, 220]);
    expect(demoRules.some((rule) => JSON.stringify(rule.condition(new Map(demoGroups.map((group) => [group.key, crypto.randomUUID()])))).includes('tenure_days'))).toBe(true);
    expect(demoRules.filter((rule) => rule.key.includes('engineering') || rule.key.includes('people-manager')).length).toBeGreaterThan(1);
    expect(new Set(demoOverrides.map((override) => override.action))).toEqual(new Set(['ASSIGN', 'EXCLUDE']));
  });

  it('uses unique stable identifiers and valid references', () => {
    const unique = (values: string[]): boolean => new Set(values).size === values.length;
    expect(unique(demoEmployees.map((employee) => employee.externalId))).toBe(true);
    expect(unique(demoPolicies.map((policy) => policy.key))).toBe(true);
    expect(unique(demoRules.map((rule) => rule.key))).toBe(true);
    expect(demoPolicies.every((policy) => demoCategories.some((category) => category.key === policy.category))).toBe(true);
    expect(demoRules.every((rule) => demoPolicies.some((policy) => policy.key === rule.policy))).toBe(true);
    expect(demoEmployees.flatMap((employee) => employee.groups).every((key) => demoGroups.some((group) => group.key === key))).toBe(true);
  });
});
