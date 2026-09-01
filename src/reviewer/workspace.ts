import type { RuleCondition } from '../domain/rules.js';

export const REVIEWER_WORKSPACE_NAME = 'NYC Open Data Policy Workspace';
export const REVIEWER_POLICY_CONFIGURATION_LABEL = 'Evaluation / demonstration policy configuration';

export interface ReviewerObservedFacts {
  employmentTypes: string[];
  primaryLocation: string;
  secondaryLocation: string | null;
  primaryDepartment: string;
}

export const reviewerCategories = [
  { key: 'demo-compensation-review', name: 'Compensation review (demonstration)', cardinality: 'SINGLE' as const },
  { key: 'demo-workplace-notices', name: 'Workplace notices (demonstration)', cardinality: 'MULTIPLE' as const },
  { key: 'demo-learning', name: 'Learning (demonstration)', cardinality: 'MULTIPLE' as const },
  { key: 'demo-access', name: 'Access (demonstration)', cardinality: 'MULTIPLE' as const },
] as const;

export const reviewerPolicies = [
  {
    key: 'demo-general-compensation-review',
    category: 'demo-compensation-review',
    name: 'General compensation review — demonstration',
    description: 'A demonstration fallback used to explain single-policy conflict resolution. This is not an NYC policy.',
  },
  {
    key: 'demo-primary-pay-basis-review',
    category: 'demo-compensation-review',
    name: 'Primary pay-basis review — demonstration',
    description: 'A demonstration assignment based on an observed payroll pay basis. This is not an NYC policy.',
  },
  {
    key: 'demo-secondary-pay-basis-review',
    category: 'demo-compensation-review',
    name: 'Secondary pay-basis review — demonstration',
    description: 'A demonstration assignment based on another observed payroll pay basis. This is not an NYC policy.',
  },
  {
    key: 'demo-source-data-orientation',
    category: 'demo-learning',
    name: 'Source-data orientation — demonstration',
    description: 'A demonstration learning assignment for the imported employee population. This is not an NYC policy.',
  },
  {
    key: 'demo-long-service-refresher',
    category: 'demo-learning',
    name: 'Long-service refresher — demonstration',
    description: 'A demonstration tenure-based assignment. This is not an NYC policy.',
  },
  {
    key: 'demo-primary-location-notice',
    category: 'demo-workplace-notices',
    name: 'Primary location notice — demonstration',
    description: 'A demonstration location-based notice. This is not an official NYC workplace notice.',
  },
  {
    key: 'demo-secondary-location-notice',
    category: 'demo-workplace-notices',
    name: 'Secondary location notice — demonstration',
    description: 'A demonstration location-based notice. This is not an official NYC workplace notice.',
  },
  {
    key: 'demo-department-workflow-access',
    category: 'demo-access',
    name: 'Department workflow access — demonstration',
    description: 'A demonstration group-based access assignment. This is not an NYC access policy.',
  },
  {
    key: 'demo-manager-review-access',
    category: 'demo-access',
    name: 'Manager review access — demonstration',
    description: 'A demonstration manager-status assignment useful when previewing employee edits. This is not an NYC policy.',
  },
] as const;

export const reviewerGroups = [
  {
    key: 'demo-observed-department-cohort',
    name: 'Observed department cohort (demonstration)',
    description: 'A demonstration cohort populated from one department observed in the imported NYC source facts.',
  },
] as const;

export interface ReviewerRuleDefinition {
  key: string;
  policy: string;
  priority: number;
  condition: RuleCondition;
}

const employeeEquals = (
  field: 'location' | 'department' | 'employment_type' | 'is_manager',
  value: string | boolean,
): RuleCondition => ({ type: 'comparison', fact: { kind: 'employee', field }, operator: 'EQ', value });

export function reviewerRules(
  facts: ReviewerObservedFacts,
  groups: ReadonlyMap<string, string>,
): ReviewerRuleDefinition[] {
  if (facts.employmentTypes.length === 0) throw new Error('Reviewer rules require at least one observed employment type');
  const rules: ReviewerRuleDefinition[] = [
    {
      key: 'demo-general-compensation-review',
      policy: 'demo-general-compensation-review',
      priority: 10,
      condition: { type: 'comparison', fact: { kind: 'as_of_date' }, operator: 'GTE', value: '2000-01-01' },
    },
    {
      key: 'demo-primary-pay-basis-review',
      policy: 'demo-primary-pay-basis-review',
      priority: 100,
      condition: employeeEquals('employment_type', facts.employmentTypes[0]!),
    },
    {
      key: 'demo-source-data-orientation',
      policy: 'demo-source-data-orientation',
      priority: 50,
      condition: { type: 'comparison', fact: { kind: 'as_of_date' }, operator: 'GTE', value: '2000-01-01' },
    },
    {
      key: 'demo-long-service-refresher',
      policy: 'demo-long-service-refresher',
      priority: 80,
      condition: { type: 'comparison', fact: { kind: 'tenure_days' }, operator: 'GTE', value: 1_825 },
    },
    {
      key: 'demo-primary-location-notice',
      policy: 'demo-primary-location-notice',
      priority: 60,
      condition: employeeEquals('location', facts.primaryLocation),
    },
    {
      key: 'demo-department-workflow-access',
      policy: 'demo-department-workflow-access',
      priority: 70,
      condition: {
        type: 'group',
        groupId: groups.get('demo-observed-department-cohort')!,
        operator: 'MEMBER_OF',
      },
    },
    {
      key: 'demo-manager-review-access',
      policy: 'demo-manager-review-access',
      priority: 90,
      condition: employeeEquals('is_manager', true),
    },
  ];
  if (facts.employmentTypes[1] !== undefined) {
    rules.push({
      key: 'demo-secondary-pay-basis-review',
      policy: 'demo-secondary-pay-basis-review',
      priority: 100,
      condition: employeeEquals('employment_type', facts.employmentTypes[1]),
    });
  }
  if (facts.secondaryLocation !== null) {
    rules.push({
      key: 'demo-secondary-location-notice',
      policy: 'demo-secondary-location-notice',
      priority: 60,
      condition: employeeEquals('location', facts.secondaryLocation),
    });
  }
  return rules;
}
