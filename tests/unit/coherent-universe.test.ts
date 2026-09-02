import { describe, expect, it } from 'vitest';
import { fingerprint } from '../../src/domain/rules.js';
import {
  buildCoherentBaselineBlueprint,
  coherentCategoryDefinitions,
  type ObservedEmployeeFact,
  type ObservedGroupDefinition,
} from '../../src/baseline/coherent-universe.js';

const baselineDate = '2026-06-30';

function population(): ObservedEmployeeFact[] {
  const roleWords = ['Analyst', 'Attorney', 'Clerk', 'Coordinator', 'Engineer', 'Investigator', 'Nurse', 'Planner'];
  return Array.from({ length: 240 }, (_, index) => {
    const employmentType = `Pay segment ${index % 4}`;
    return {
      employeeId: `employee-${index.toString().padStart(3, '0')}`,
      location: `Location ${index % 6}`,
      department: `Department ${index % 44}`,
      employmentType,
      payBasis: employmentType,
      employmentStatus: `Status ${index % 5}`,
      jobTitle: `${roleWords[index % roleWords.length]} Specialty ${index % 80}`,
      hireDate: [`2025-08-01`, `2023-01-01`, `2019-01-01`, `2010-01-01`][index % 4]!,
      isManager: false,
    };
  });
}

function groups(facts: readonly ObservedEmployeeFact[]): ObservedGroupDefinition[] {
  return Array.from({ length: 8 }, (_, index) => {
    const department = `Department ${index}`;
    return {
      id: `00000000-0000-4000-8000-${(index + 1).toString().padStart(12, '0')}`,
      key: `observed-department-${index}`,
      name: `${department} cohort`,
      department,
      memberCount: facts.filter((fact) => fact.department === department).length,
    };
  });
}

describe('coherent policy-universe builder', () => {
  it('deterministically builds six meaningful domains with exactly 50 rules each', () => {
    const facts = population();
    const forward = buildCoherentBaselineBlueprint(facts, groups(facts), baselineDate);
    const reverse = buildCoherentBaselineBlueprint([...facts].reverse(), groups(facts), baselineDate);

    expect(forward.ruleCount).toBe(300);
    expect(forward.categories.map((domain) => domain.rules.length)).toEqual([50, 50, 50, 50, 50, 50]);
    expect(forward.categories.map(({ key, name, cardinality }) => ({ key, name, cardinality })))
      .toEqual([...coherentCategoryDefinitions]);
    expect(fingerprint(reverse)).toBe(fingerprint(forward));
    expect(JSON.stringify(forward)).not.toContain('Evaluation policy');
    expect(JSON.stringify(forward)).not.toContain('work-context-requirements');
  });

  it('covers every observed replacement segment without title or location gaps', () => {
    const facts = population();
    const blueprint = buildCoherentBaselineBlueprint(facts, groups(facts), baselineDate);
    const byKey = new Map(blueprint.categories.map((domain) => [domain.key, domain]));

    const departments = new Set(facts.map((fact) => fact.department));
    const departmentPolicies = byKey.get('department-workflow-access')!.policies
      .filter((policy) => policy.metadata['segmentType'] === 'department');
    expect(new Set(departmentPolicies.map((policy) => policy.metadata['segmentValue']))).toEqual(departments);

    const locations = new Set(facts.map((fact) => fact.location));
    const locationPolicies = byKey.get('workplace-requirements')!.policies
      .filter((policy) => policy.metadata['segmentType'] === 'location');
    expect(new Set(locationPolicies.map((policy) => policy.metadata['segmentValue']))).toEqual(locations);

    const employmentTypes = new Set(facts.map((fact) => fact.employmentType));
    const compensationPolicies = byKey.get('compensation-program')!.policies;
    expect(new Set(compensationPolicies.map((policy) => policy.metadata['segmentValue']))).toEqual(employmentTypes);

    const coveredTitles = blueprint.roleFamilies.flatMap((family) => family.titles);
    expect(coveredTitles).toHaveLength(new Set(coveredTitles).size);
    expect(new Set(coveredTitles)).toEqual(new Set(facts.map((fact) => fact.jobTitle)));

    const tenurePolicies = byKey.get('tenure-benefits')!.policies;
    expect(tenurePolicies.map((policy) => policy.metadata['minDays'])).toEqual([0, 730, 1_825, 3_650]);
    expect(tenurePolicies.map((policy) => policy.metadata['maxDays'])).toEqual([730, 1_825, 3_650, null]);
  });
});
