import { describe, expect, it } from 'vitest';
import {
  REVIEWER_POLICY_CONFIGURATION_LABEL,
  REVIEWER_WORKSPACE_NAME,
  reviewerCategories,
  reviewerGroups,
  reviewerPolicies,
  reviewerRules,
} from '../../src/reviewer/workspace.js';

const facts = {
  employmentTypes: ['Per Annum', 'Per Hour'],
  primaryLocation: 'MANHATTAN',
  secondaryLocation: 'QUEENS',
  primaryDepartment: 'DEPARTMENT OF EDUCATION ADMIN',
};

describe('NYC Open Data reviewer workspace', () => {
  it('contains only clearly labelled demonstration policy configuration', () => {
    expect(REVIEWER_WORKSPACE_NAME).toBe('NYC Open Data Policy Workspace');
    expect(REVIEWER_POLICY_CONFIGURATION_LABEL).toBe('Evaluation / demonstration policy configuration');
    expect(reviewerCategories).toHaveLength(4);
    expect(reviewerPolicies).toHaveLength(9);
    expect(reviewerGroups).toHaveLength(1);
    expect(reviewerPolicies.every((policy) => policy.name.includes('demonstration'))).toBe(true);
    expect(reviewerPolicies.every((policy) => policy.description.includes('not') && policy.description.includes('NYC'))).toBe(true);
  });

  it('builds explainable conflicts and rules from observed source values', () => {
    const groupId = crypto.randomUUID();
    const rules = reviewerRules(facts, new Map([['demo-observed-department-cohort', groupId]]));
    expect(rules).toHaveLength(9);
    expect(rules.filter((rule) => [
      'demo-general-compensation-review',
      'demo-primary-pay-basis-review',
      'demo-secondary-pay-basis-review',
    ].includes(rule.policy)).map((rule) => rule.priority).sort((left, right) => left - right))
      .toEqual([10, 100, 100]);
    expect(rules.some((rule) => JSON.stringify(rule.condition).includes('MANHATTAN'))).toBe(true);
    expect(rules.some((rule) => JSON.stringify(rule.condition).includes('Per Annum'))).toBe(true);
    expect(rules.some((rule) => JSON.stringify(rule.condition).includes(groupId))).toBe(true);
    expect(rules.some((rule) => JSON.stringify(rule.condition).includes('tenure_days'))).toBe(true);
    expect(rules.some((rule) => JSON.stringify(rule.condition).includes('is_manager'))).toBe(true);
  });

  it('uses unique stable policy and rule identifiers with valid category references', () => {
    const unique = (values: string[]): boolean => new Set(values).size === values.length;
    const rules = reviewerRules(facts, new Map([['demo-observed-department-cohort', crypto.randomUUID()]]));
    expect(unique(reviewerPolicies.map((policy) => policy.key))).toBe(true);
    expect(unique(rules.map((rule) => rule.key))).toBe(true);
    expect(reviewerPolicies.every((policy) => reviewerCategories.some((category) => category.key === policy.category))).toBe(true);
    expect(rules.every((rule) => reviewerPolicies.some((policy) => policy.key === rule.policy))).toBe(true);
  });
});
