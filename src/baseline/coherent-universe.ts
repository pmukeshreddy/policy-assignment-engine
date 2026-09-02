import { fingerprint, type RuleCondition } from '../domain/rules.js';

export const COHERENT_RULES_PER_DOMAIN = 50;

export const coherentCategoryDefinitions = [
  { key: 'department-workflow-access', name: 'Department workflow access', cardinality: 'SINGLE' as const },
  { key: 'workplace-requirements', name: 'Workplace requirements', cardinality: 'MULTIPLE' as const },
  { key: 'compensation-program', name: 'Employment and compensation program', cardinality: 'SINGLE' as const },
  { key: 'role-access-training', name: 'Job-role access and training', cardinality: 'SINGLE' as const },
  { key: 'tenure-benefits', name: 'Tenure benefits', cardinality: 'SINGLE' as const },
  { key: 'cross-functional-requirements', name: 'Cross-functional requirements', cardinality: 'MULTIPLE' as const },
] as const;

export interface ObservedEmployeeFact {
  employeeId: string;
  location: string;
  department: string;
  employmentType: string;
  payBasis: string;
  employmentStatus: string;
  jobTitle: string;
  hireDate: string;
  isManager: boolean;
}

export interface ObservedGroupDefinition {
  id: string;
  key: string;
  name: string;
  department: string;
  memberCount: number;
}

export interface BaselinePolicyDefinition {
  key: string;
  name: string;
  description: string;
  metadata: Record<string, unknown>;
}

export interface BaselineRuleDefinition {
  key: string;
  policyKey: string;
  priority: number;
  condition: RuleCondition;
  rationale: string;
}

export interface BaselineDomainBlueprint {
  key: string;
  name: string;
  cardinality: 'SINGLE' | 'MULTIPLE';
  policies: BaselinePolicyDefinition[];
  rules: BaselineRuleDefinition[];
}

export interface CoherentBaselineBlueprint {
  categories: BaselineDomainBlueprint[];
  ruleCount: number;
  policyCount: number;
  roleFamilies: Array<{ key: string; name: string; titles: string[]; employeeCount: number }>;
  observed: {
    employees: number;
    locations: Array<{ value: string; count: number }>;
    departments: Array<{ value: string; count: number }>;
    jobTitles: Array<{ value: string; count: number }>;
    employmentTypes: Array<{ value: string; count: number }>;
    payBases: Array<{ value: string; count: number }>;
    employmentStatuses: Array<{ value: string; count: number }>;
    managerTrue: number;
    payBasisMismatches: number;
    tenureBuckets: Array<{ key: string; name: string; count: number }>;
  };
}

interface CandidateRule extends BaselineRuleDefinition {
  count: number;
}

interface RoleFamily {
  key: string;
  name: string;
  titles: string[];
  employeeCount: number;
}

interface TenureTier {
  key: string;
  name: string;
  minDays: number;
  maxDays: number | null;
}

const tenureTiers: readonly TenureTier[] = [
  { key: 'foundation', name: 'Foundation Benefits — under 2 years', minDays: 0, maxDays: 730 },
  { key: 'established', name: 'Established Benefits — 2 to 5 years', minDays: 730, maxDays: 1_825 },
  { key: 'experienced', name: 'Experienced Benefits — 5 to 10 years', minDays: 1_825, maxDays: 3_650 },
  { key: 'long-service', name: 'Long-Service Benefits — 10+ years', minDays: 3_650, maxDays: null },
];

const genericRoleStopWords = new Set([
  'ADMIN', 'ADMINISTRATIVE', 'ASSISTANT', 'ASSOCIATE', 'CHIEF', 'DEPUTY', 'DIRECTOR', 'EXECUTIVE',
  'GENERAL', 'INTERNE', 'JUNIOR', 'LEAD', 'LEADER', 'LEVEL', 'MANAGER', 'MEMBER', 'NON', 'OFFICE',
  'OFFICER', 'PRINCIPAL', 'SENIOR', 'SPECIAL', 'STAFF', 'SUPERVISING', 'SUPERVISOR', 'THE', 'TO',
]);

const fictionalDisclaimer = 'Fictional company policy derived from observed workforce facts; not an official NYC policy or law.';

export function buildCoherentBaselineBlueprint(
  facts: readonly ObservedEmployeeFact[],
  groups: readonly ObservedGroupDefinition[],
  baselineDate: string,
): CoherentBaselineBlueprint {
  if (facts.length === 0) throw new Error('Coherent baseline requires observed employee facts');
  const locations = distribution(facts.map((fact) => fact.location));
  const departments = distribution(facts.map((fact) => fact.department));
  const jobTitles = distribution(facts.map((fact) => fact.jobTitle));
  const employmentTypes = distribution(facts.map((fact) => fact.employmentType));
  const payBases = distribution(facts.map((fact) => fact.payBasis));
  const employmentStatuses = distribution(facts.map((fact) => fact.employmentStatus));
  const roles = deriveRoleFamilies(jobTitles);
  const familyByTitle = new Map(roles.flatMap((family) => family.titles.map((title) => [title, family] as const)));
  const tierByEmployee = new Map(facts.map((fact) => [fact.employeeId, tierForFact(fact, baselineDate)]));

  const categories = [
    buildDepartmentDomain(facts, groups, departments),
    buildLocationDomain(facts, locations, employmentStatuses),
    buildEmploymentDomain(facts, employmentTypes, payBases),
    buildRoleDomain(facts, roles, familyByTitle),
    buildTenureDomain(facts, tierByEmployee),
    buildCrossFunctionalDomain(facts, groups, familyByTitle, tierByEmployee),
  ];
  for (const category of categories) {
    if (category.rules.length !== COHERENT_RULES_PER_DOMAIN) {
      throw new Error(`${category.key} generated ${category.rules.length} rules; expected ${COHERENT_RULES_PER_DOMAIN}`);
    }
  }
  const policyKeys = categories.flatMap((category) => category.policies.map((policy) => policy.key));
  const ruleKeys = categories.flatMap((category) => category.rules.map((rule) => rule.key));
  if (new Set(policyKeys).size !== policyKeys.length) throw new Error('Coherent baseline generated duplicate policy keys');
  if (new Set(ruleKeys).size !== ruleKeys.length) throw new Error('Coherent baseline generated duplicate rule keys');
  return {
    categories,
    ruleCount: categories.reduce((total, category) => total + category.rules.length, 0),
    policyCount: policyKeys.length,
    roleFamilies: roles,
    observed: {
      employees: facts.length,
      locations,
      departments,
      jobTitles,
      employmentTypes,
      payBases,
      employmentStatuses,
      managerTrue: facts.filter((fact) => fact.isManager).length,
      payBasisMismatches: facts.filter((fact) => fact.payBasis !== fact.employmentType).length,
      tenureBuckets: tenureTiers.map((tier) => ({
        key: tier.key,
        name: tier.name,
        count: [...tierByEmployee.values()].filter((candidate) => candidate.key === tier.key).length,
      })),
    },
  };
}

function buildDepartmentDomain(
  facts: readonly ObservedEmployeeFact[],
  groups: readonly ObservedGroupDefinition[],
  departments: readonly { value: string; count: number }[],
): BaselineDomainBlueprint {
  const definition = coherentCategoryDefinitions[0];
  const policies = departments.map(({ value, count }) => policy(
    derivedKey('dept-policy', [value]),
    `${humanize(value)} Workflow Access`,
    `Workflow and application access for the observed ${humanize(value)} department segment (${count.toLocaleString()} employees).`,
    definition.key,
    { segmentType: 'department', segmentValue: value, observedEmployees: count },
  ));
  const policyByDepartment = new Map(departments.map((item, index) => [item.value, policies[index]!]));
  const rules: BaselineRuleDefinition[] = departments.map(({ value }) => ({
    key: derivedKey('dept-primary', [value]),
    policyKey: policyByDepartment.get(value)!.key,
    priority: 400,
    condition: employeeEquals('department', value),
    rationale: `The employee belongs to the observed ${value} department.`,
  }));
  const candidates: CandidateRule[] = [];
  for (const group of [...groups].sort(compareGroup)) {
    candidates.push({
      key: derivedKey('dept-cohort', [group.key]),
      policyKey: policyByDepartment.get(group.department)!.key,
      priority: 320,
      condition: { type: 'group', groupId: group.id, operator: 'MEMBER_OF' },
      rationale: `Membership in ${group.name} is an alternate eligibility path to the same department access.`,
      count: group.memberCount,
    });
  }
  candidates.push(...departmentCandidates(facts, policyByDepartment, 'location', (fact) => fact.location, 280));
  candidates.push(...departmentCandidates(facts, policyByDepartment, 'employment-type', (fact) => fact.employmentType, 260));
  candidates.push(...departmentCandidates(facts, policyByDepartment, 'status', (fact) => fact.employmentStatus, 240));
  candidates.push(...departmentCandidates(facts, policyByDepartment, 'job-title', (fact) => fact.jobTitle, 220));
  fillRules(rules, candidates, definition.key);
  return { ...definition, policies, rules };
}

function departmentCandidates(
  facts: readonly ObservedEmployeeFact[],
  policyByDepartment: ReadonlyMap<string, BaselinePolicyDefinition>,
  qualifier: string,
  qualifierValue: (fact: ObservedEmployeeFact) => string,
  priority: number,
): CandidateRule[] {
  return combos(facts, (fact) => [fact.department, qualifierValue(fact)]).map(({ values, count }) => {
    const department = values[0]!;
    const value = values[1]!;
    return {
      key: derivedKey(`dept-${qualifier}`, values),
      policyKey: policyByDepartment.get(department)!.key,
      priority,
      condition: and(employeeEquals('department', department), qualifierCondition(qualifier, value)),
      rationale: `${humanize(department)} access is also evidenced by the observed ${humanize(qualifier)} segment ${value}.`,
      count,
    };
  });
}

function buildLocationDomain(
  facts: readonly ObservedEmployeeFact[],
  locations: readonly { value: string; count: number }[],
  statuses: readonly { value: string; count: number }[],
): BaselineDomainBlueprint {
  const definition = coherentCategoryDefinitions[1];
  const general = policy(
    'workplace-general-training',
    'General Workplace Training',
    'Baseline workplace training shared by every observed employment-status segment.',
    definition.key,
    { segmentType: 'all-observed-employment-statuses' },
  );
  const locationPolicies = locations.map(({ value, count }) => policy(
    derivedKey('location-policy', [value]),
    `${humanize(value)} Workplace Requirements`,
    `Workplace requirements for the observed ${humanize(value)} location segment (${count.toLocaleString()} employees).`,
    definition.key,
    { segmentType: 'location', segmentValue: value, observedEmployees: count },
  ));
  const policyByLocation = new Map(locations.map((item, index) => [item.value, locationPolicies[index]!]));
  const rules: BaselineRuleDefinition[] = locations.map(({ value }) => ({
    key: derivedKey('location-primary', [value]),
    policyKey: policyByLocation.get(value)!.key,
    priority: 300,
    condition: employeeEquals('location', value),
    rationale: `The employee works in the observed ${value} location.`,
  }));
  for (const { value } of statuses) {
    rules.push({
      key: derivedKey('workplace-general-status', [value]),
      policyKey: general.key,
      priority: 100,
      condition: attributeEquals('employment_status', value),
      rationale: `The observed ${value} status receives shared workplace training.`,
    });
  }
  const candidates: CandidateRule[] = [];
  candidates.push(...locationCandidates(facts, policyByLocation, 'employment-type', (fact) => fact.employmentType, 240));
  candidates.push(...locationCandidates(facts, policyByLocation, 'status', (fact) => fact.employmentStatus, 220));
  candidates.push(...locationCandidates(facts, policyByLocation, 'department', (fact) => fact.department, 200));
  candidates.push(...locationCandidates(facts, policyByLocation, 'job-title', (fact) => fact.jobTitle, 180));
  candidates.push(...locationCandidates(facts, policyByLocation, 'pay-basis', (fact) => fact.payBasis, 160));
  fillRules(rules, candidates, definition.key);
  return { ...definition, policies: [general, ...locationPolicies], rules };
}

function locationCandidates(
  facts: readonly ObservedEmployeeFact[],
  policyByLocation: ReadonlyMap<string, BaselinePolicyDefinition>,
  qualifier: string,
  qualifierValue: (fact: ObservedEmployeeFact) => string,
  priority: number,
): CandidateRule[] {
  return combos(facts, (fact) => [fact.location, qualifierValue(fact)]).map(({ values, count }) => {
    const location = values[0]!;
    const value = values[1]!;
    return {
      key: derivedKey(`location-${qualifier}`, values),
      policyKey: policyByLocation.get(location)!.key,
      priority,
      condition: and(employeeEquals('location', location), qualifierCondition(qualifier, value)),
      rationale: `${humanize(location)} requirements have an observed ${humanize(qualifier)} eligibility path for ${value}.`,
      count,
    };
  });
}

function buildEmploymentDomain(
  facts: readonly ObservedEmployeeFact[],
  employmentTypes: readonly { value: string; count: number }[],
  payBases: readonly { value: string; count: number }[],
): BaselineDomainBlueprint {
  const definition = coherentCategoryDefinitions[2];
  const segments = distribution([...employmentTypes.map((item) => item.value), ...payBases.map((item) => item.value)]);
  const observedCounts = new Map(employmentTypes.map((item) => [item.value, item.count]));
  const policies = segments.map(({ value }) => policy(
    derivedKey('compensation-policy', [value]),
    `${humanize(value)} Compensation Program`,
    `Compensation and employment program for the observed ${humanize(value)} worker segment.`,
    definition.key,
    { segmentType: 'employment-or-pay-type', segmentValue: value, observedEmployees: observedCounts.get(value) ?? 0 },
  ));
  const policyBySegment = new Map(segments.map((item, index) => [item.value, policies[index]!]));
  const rules: BaselineRuleDefinition[] = employmentTypes.map(({ value }) => ({
    key: derivedKey('compensation-employment-primary', [value]),
    policyKey: policyBySegment.get(value)!.key,
    priority: 400,
    condition: employeeEquals('employment_type', value),
    rationale: `Employment type ${value} is the controlling compensation-program fact.`,
  }));
  const candidates: CandidateRule[] = payBases.map(({ value, count }) => ({
    key: derivedKey('compensation-pay-basis', [value]),
    policyKey: policyBySegment.get(value)!.key,
    priority: 320,
    condition: attributeEquals('pay_basis', value),
    rationale: `Observed pay basis ${value} corroborates the same compensation program.`,
    count,
  }));
  candidates.push(...employmentCandidates(facts, policyBySegment, 'employment-status', (fact) => fact.employmentStatus, false, 280));
  candidates.push(...employmentCandidates(facts, policyBySegment, 'pay-status', (fact) => fact.employmentStatus, true, 260));
  candidates.push(...employmentCandidates(facts, policyBySegment, 'employment-location', (fact) => fact.location, false, 240));
  candidates.push(...employmentCandidates(facts, policyBySegment, 'pay-location', (fact) => fact.location, true, 220));
  candidates.push(...employmentCandidates(facts, policyBySegment, 'employment-department', (fact) => fact.department, false, 200));
  fillRules(rules, candidates, definition.key);
  return { ...definition, policies, rules };
}

function employmentCandidates(
  facts: readonly ObservedEmployeeFact[],
  policyBySegment: ReadonlyMap<string, BaselinePolicyDefinition>,
  variant: string,
  qualifierValue: (fact: ObservedEmployeeFact) => string,
  usePayBasis: boolean,
  priority: number,
): CandidateRule[] {
  return combos(facts, (fact) => [usePayBasis ? fact.payBasis : fact.employmentType, qualifierValue(fact)]).map(({ values, count }) => {
    const segment = values[0]!;
    const value = values[1]!;
    const qualifier = variant.includes('status') ? 'status' : variant.includes('location') ? 'location' : 'department';
    return {
      key: derivedKey(`compensation-${variant}`, values),
      policyKey: policyBySegment.get(segment)!.key,
      priority,
      condition: and(
        usePayBasis ? attributeEquals('pay_basis', segment) : employeeEquals('employment_type', segment),
        qualifierCondition(qualifier, value),
      ),
      rationale: `${segment} compensation eligibility is corroborated by the observed ${qualifier} value ${value}.`,
      count,
    };
  });
}

function buildRoleDomain(
  facts: readonly ObservedEmployeeFact[],
  families: readonly RoleFamily[],
  familyByTitle: ReadonlyMap<string, RoleFamily>,
): BaselineDomainBlueprint {
  const definition = coherentCategoryDefinitions[3];
  const policies = families.map((family) => policy(
    derivedKey('role-policy', [family.key]),
    `${family.name} Role Access and Training`,
    `Access and training for ${family.titles.length.toLocaleString()} observed job titles grouped by the deterministic ${family.name} role-family token.`,
    definition.key,
    { segmentType: 'role-family', segmentValue: family.key, observedTitles: family.titles, observedEmployees: family.employeeCount },
  ));
  const policyByFamily = new Map(families.map((family, index) => [family.key, policies[index]!]));
  const rules: BaselineRuleDefinition[] = families.map((family) => ({
    key: derivedKey('role-primary', [family.key]),
    policyKey: policyByFamily.get(family.key)!.key,
    priority: 400,
    condition: attributeIn('job_title', family.titles),
    rationale: `The observed title belongs to the deterministic ${family.name} role family.`,
  }));
  const candidates: CandidateRule[] = [];
  for (const family of families) {
    const familyFacts = facts.filter((fact) => familyByTitle.get(fact.jobTitle)?.key === family.key);
    const topStatus = distribution(familyFacts.map((fact) => fact.employmentStatus))[0];
    if (topStatus !== undefined) {
      candidates.push({
        key: derivedKey('role-status', [family.key, topStatus.value]),
        policyKey: policyByFamily.get(family.key)!.key,
        priority: 300,
        condition: and(attributeIn('job_title', family.titles), attributeEquals('employment_status', topStatus.value)),
        rationale: `${family.name} employees in the observed ${topStatus.value} status have a specific training eligibility path.`,
        count: topStatus.count,
      });
    }
  }
  candidates.push(...roleCandidates(facts, familyByTitle, policyByFamily, 'department', (fact) => fact.department, 260));
  candidates.push(...roleCandidates(facts, familyByTitle, policyByFamily, 'location', (fact) => fact.location, 240));
  candidates.push(...roleCandidates(facts, familyByTitle, policyByFamily, 'employment-type', (fact) => fact.employmentType, 220));
  fillRules(rules, candidates, definition.key);
  return { ...definition, policies, rules };
}

function roleCandidates(
  facts: readonly ObservedEmployeeFact[],
  familyByTitle: ReadonlyMap<string, RoleFamily>,
  policyByFamily: ReadonlyMap<string, BaselinePolicyDefinition>,
  qualifier: string,
  qualifierValue: (fact: ObservedEmployeeFact) => string,
  priority: number,
): CandidateRule[] {
  const grouped = new Map<string, { family: RoleFamily; value: string; titles: Set<string>; count: number }>();
  for (const fact of facts) {
    const family = familyByTitle.get(fact.jobTitle)!;
    const value = qualifierValue(fact);
    const key = JSON.stringify([family.key, value]);
    const current = grouped.get(key) ?? { family, value, titles: new Set<string>(), count: 0 };
    current.titles.add(fact.jobTitle);
    current.count += 1;
    grouped.set(key, current);
  }
  return [...grouped.values()].sort(compareCountThenValues((item) => [item.family.key, item.value])).map((item) => ({
    key: derivedKey(`role-${qualifier}`, [item.family.key, item.value]),
    policyKey: policyByFamily.get(item.family.key)!.key,
    priority,
    condition: and(attributeIn('job_title', [...item.titles].sort()), qualifierCondition(qualifier, item.value)),
    rationale: `${item.family.name} access has an observed ${humanize(qualifier)} eligibility path for ${item.value}.`,
    count: item.count,
  }));
}

function buildTenureDomain(
  facts: readonly ObservedEmployeeFact[],
  tierByEmployee: ReadonlyMap<string, TenureTier>,
): BaselineDomainBlueprint {
  const definition = coherentCategoryDefinitions[4];
  const tierCounts = new Map(tenureTiers.map((tier) => [tier.key, facts.filter((fact) => tierByEmployee.get(fact.employeeId)!.key === tier.key).length]));
  const policies = tenureTiers.map((tier) => policy(
    derivedKey('tenure-policy', [tier.key]),
    tier.name,
    `Benefits tier for employees with ${tenureRange(tier)} as of the evaluation date (${tierCounts.get(tier.key)!.toLocaleString()} observed employees).`,
    definition.key,
    { segmentType: 'tenure-tier', segmentValue: tier.key, minDays: tier.minDays, maxDays: tier.maxDays, observedEmployees: tierCounts.get(tier.key) },
  ));
  const policyByTier = new Map(tenureTiers.map((tier, index) => [tier.key, policies[index]!]));
  const rules: BaselineRuleDefinition[] = tenureTiers.map((tier) => ({
    key: derivedKey('tenure-primary', [tier.key]),
    policyKey: policyByTier.get(tier.key)!.key,
    priority: 400,
    condition: tenureCondition(tier),
    rationale: `Tenure falls in the ${tier.name} tier.`,
  }));
  const candidates: CandidateRule[] = [];
  candidates.push(...tenureCandidates(facts, tierByEmployee, policyByTier, 'employment-type', (fact) => fact.employmentType, 280));
  candidates.push(...tenureCandidates(facts, tierByEmployee, policyByTier, 'status', (fact) => fact.employmentStatus, 260));
  candidates.push(...tenureCandidates(facts, tierByEmployee, policyByTier, 'location', (fact) => fact.location, 240));
  candidates.push(...tenureCandidates(facts, tierByEmployee, policyByTier, 'department', (fact) => fact.department, 220));
  candidates.push(...tenureCandidates(facts, tierByEmployee, policyByTier, 'pay-basis', (fact) => fact.payBasis, 200));
  fillRules(rules, candidates, definition.key);
  return { ...definition, policies, rules };
}

function tenureCandidates(
  facts: readonly ObservedEmployeeFact[],
  tierByEmployee: ReadonlyMap<string, TenureTier>,
  policyByTier: ReadonlyMap<string, BaselinePolicyDefinition>,
  qualifier: string,
  qualifierValue: (fact: ObservedEmployeeFact) => string,
  priority: number,
): CandidateRule[] {
  return combos(facts, (fact) => [tierByEmployee.get(fact.employeeId)!.key, qualifierValue(fact)]).map(({ values, count }) => {
    const tierKey = values[0]!;
    const value = values[1]!;
    const tier = tenureTiers.find((candidate) => candidate.key === tierKey)!;
    return {
      key: derivedKey(`tenure-${qualifier}`, values),
      policyKey: policyByTier.get(tierKey)!.key,
      priority,
      condition: and(tenureCondition(tier), qualifierCondition(qualifier, value)),
      rationale: `${tier.name} eligibility is qualified by the observed ${humanize(qualifier)} value ${value}.`,
      count,
    };
  });
}

function buildCrossFunctionalDomain(
  facts: readonly ObservedEmployeeFact[],
  groups: readonly ObservedGroupDefinition[],
  familyByTitle: ReadonlyMap<string, RoleFamily>,
  tierByEmployee: ReadonlyMap<string, TenureTier>,
): BaselineDomainBlueprint {
  const definition = coherentCategoryDefinitions[5];
  const policies: BaselinePolicyDefinition[] = [];
  const rules: BaselineRuleDefinition[] = [];
  const add = (input: {
    variant: string;
    values: string[];
    name: string;
    description: string;
    condition: RuleCondition;
    count: number;
    priority: number;
  }): void => {
    if (rules.length >= COHERENT_RULES_PER_DOMAIN) return;
    const policyKey = derivedKey(`cross-policy-${input.variant}`, input.values);
    policies.push(policy(
      policyKey,
      input.name,
      input.description,
      definition.key,
      { segmentType: input.variant, segmentValues: input.values, observedEmployees: input.count },
    ));
    rules.push({
      key: derivedKey(`cross-rule-${input.variant}`, input.values),
      policyKey,
      priority: input.priority,
      condition: input.condition,
      rationale: input.description,
    });
  };

  for (const group of [...groups].sort(compareGroup)) {
    const groupFacts = facts.filter((fact) => fact.department === group.department);
    const status = distribution(groupFacts.map((fact) => fact.employmentStatus))[0];
    if (status === undefined) continue;
    add({
      variant: 'group-status',
      values: [group.key, status.value],
      name: `${humanize(group.department)} ${humanize(status.value)} Cohort Requirements`,
      description: `Requirements for members of ${group.name} with the observed ${status.value} employment status.`,
      condition: and({ type: 'group', groupId: group.id, operator: 'MEMBER_OF' }, attributeEquals('employment_status', status.value)),
      count: groupFacts.filter((fact) => fact.employmentStatus === status.value).length,
      priority: 300,
    });
  }

  const candidates: Array<Parameters<typeof add>[0]> = [];
  for (const { values, count } of combos(facts, (fact) => [fact.location, fact.employmentType])) {
    candidates.push({
      variant: 'location-employment', values,
      name: `${humanize(values[0]!)} ${humanize(values[1]!)} Workforce Requirements`,
      description: `Combined workplace requirements for the observed ${values[0]} location and ${values[1]} employment segment.`,
      condition: and(employeeEquals('location', values[0]!), employeeEquals('employment_type', values[1]!)),
      count, priority: 260,
    });
  }
  for (const { values, count } of combos(facts, (fact) => [fact.department, fact.location])) {
    candidates.push({
      variant: 'department-location', values,
      name: `${humanize(values[0]!)} — ${humanize(values[1]!)} Operating Coordination`,
      description: `Operating coordination for the observed ${values[0]} department and ${values[1]} location combination.`,
      condition: and(employeeEquals('department', values[0]!), employeeEquals('location', values[1]!)),
      count, priority: 250,
    });
  }
  for (const { values, count } of combos(facts, (fact) => [fact.department, familyByTitle.get(fact.jobTitle)!.key])) {
    const family = familyByTitle.get(facts.find((fact) => fact.department === values[0] && familyByTitle.get(fact.jobTitle)!.key === values[1])!.jobTitle)!;
    candidates.push({
      variant: 'department-role', values,
      name: `${humanize(values[0]!)} ${family.name} Access Coordination`,
      description: `Cross-functional access for the observed ${values[0]} department and ${family.name} role-family combination.`,
      condition: and(employeeEquals('department', values[0]!), attributeIn('job_title', family.titles)),
      count, priority: 240,
    });
  }
  for (const { values, count } of combos(facts, (fact) => [tierByEmployee.get(fact.employeeId)!.key, fact.employmentType])) {
    const tier = tenureTiers.find((candidate) => candidate.key === values[0])!;
    candidates.push({
      variant: 'tenure-employment', values,
      name: `${humanize(values[1]!)} ${tier.name}`,
      description: `Career requirements combining the ${tier.name} tenure tier with the observed ${values[1]} employment segment.`,
      condition: and(tenureCondition(tier), employeeEquals('employment_type', values[1]!)),
      count, priority: 230,
    });
  }
  for (const { values, count } of combos(facts, (fact) => [fact.location, fact.employmentStatus])) {
    candidates.push({
      variant: 'location-status', values,
      name: `${humanize(values[0]!)} ${humanize(values[1]!)} Workplace Coordination`,
      description: `Workplace coordination for the observed ${values[0]} location and ${values[1]} status combination.`,
      condition: and(employeeEquals('location', values[0]!), attributeEquals('employment_status', values[1]!)),
      count, priority: 220,
    });
  }
  candidates.sort(compareCountThenValues((item) => [item.variant, ...item.values]));
  for (const candidate of candidates) add(candidate);
  if (rules.length !== COHERENT_RULES_PER_DOMAIN) {
    throw new Error(`${definition.key} could only derive ${rules.length} observed cross-functional rules`);
  }
  return { ...definition, policies, rules };
}

function deriveRoleFamilies(jobTitles: readonly { value: string; count: number }[]): RoleFamily[] {
  const tokenEmployeeCounts = new Map<string, number>();
  const tokenTitleCounts = new Map<string, number>();
  for (const title of jobTitles) {
    for (const token of titleTokens(title.value)) {
      tokenEmployeeCounts.set(token, (tokenEmployeeCounts.get(token) ?? 0) + title.count);
      tokenTitleCounts.set(token, (tokenTitleCounts.get(token) ?? 0) + 1);
    }
  }
  // Title-document frequency prevents one very large occupation from deciding the
  // taxonomy. Within a title, the least-common selected token is the most specific.
  const selectedTokens = [...tokenTitleCounts.entries()]
    .sort(([leftToken, leftTitles], [rightToken, rightTitles]) => rightTitles - leftTitles
      || (tokenEmployeeCounts.get(rightToken) ?? 0) - (tokenEmployeeCounts.get(leftToken) ?? 0)
      || leftToken.localeCompare(rightToken))
    .slice(0, 24)
    .map(([token]) => token);
  const selected = new Set(selectedTokens);
  const uncoveredEmployeeCounts = new Map<string, number>();
  for (const title of jobTitles) {
    const tokens = titleTokens(title.value);
    if (tokens.some((token) => selected.has(token))) continue;
    for (const token of tokens) {
      uncoveredEmployeeCounts.set(token, (uncoveredEmployeeCounts.get(token) ?? 0) + title.count);
    }
  }
  for (const [token] of [...uncoveredEmployeeCounts.entries()]
    .sort(([leftToken, leftCount], [rightToken, rightCount]) => rightCount - leftCount
      || (tokenTitleCounts.get(rightToken) ?? 0) - (tokenTitleCounts.get(leftToken) ?? 0)
      || leftToken.localeCompare(rightToken))
    .slice(0, 12)) {
    selected.add(token);
  }
  const families = new Map<string, RoleFamily>();
  for (const title of jobTitles) {
    const familyToken = titleTokens(title.value)
      .filter((token) => selected.has(token))
      .sort((left, right) => (tokenTitleCounts.get(left) ?? 0) - (tokenTitleCounts.get(right) ?? 0)
        || (tokenEmployeeCounts.get(right) ?? 0) - (tokenEmployeeCounts.get(left) ?? 0)
        || left.localeCompare(right))[0] ?? 'GENERAL';
    const key = familyToken.toLowerCase();
    const current = families.get(key) ?? { key, name: humanize(familyToken), titles: [], employeeCount: 0 };
    current.titles.push(title.value);
    current.employeeCount += title.count;
    families.set(key, current);
  }
  return [...families.values()]
    .map((family) => ({ ...family, titles: family.titles.sort() }))
    .sort((left, right) => right.employeeCount - left.employeeCount || left.key.localeCompare(right.key));
}

function titleTokens(title: string): string[] {
  return [...new Set((title.toUpperCase().match(/[A-Z][A-Z0-9]+/g) ?? [])
    .filter((token) => token.length >= 3 && !genericRoleStopWords.has(token) && !/^\d+$/.test(token)))];
}

function policy(
  key: string,
  name: string,
  description: string,
  domain: string,
  metadata: Record<string, unknown>,
): BaselinePolicyDefinition {
  return {
    key,
    name,
    description: `${description} ${fictionalDisclaimer}`,
    metadata: { ...metadata, domain, derivedFromObservedFacts: true, fictionalCompanyPolicy: true, actualNycPolicy: false },
  };
}

function fillRules(rules: BaselineRuleDefinition[], candidates: CandidateRule[], domain: string): void {
  const existing = new Set(rules.map((rule) => rule.key));
  for (const candidate of candidates.sort(compareCountThenValues((item) => [item.key]))) {
    if (rules.length >= COHERENT_RULES_PER_DOMAIN) break;
    if (existing.has(candidate.key)) continue;
    existing.add(candidate.key);
    const { count: _count, ...rule } = candidate;
    rules.push(rule);
  }
  if (rules.length !== COHERENT_RULES_PER_DOMAIN) {
    throw new Error(`${domain} could only derive ${rules.length} distinct observed rules`);
  }
}

function combos(
  facts: readonly ObservedEmployeeFact[],
  values: (fact: ObservedEmployeeFact) => string[],
): Array<{ values: string[]; count: number }> {
  const grouped = new Map<string, { values: string[]; count: number }>();
  for (const fact of facts) {
    const selected = values(fact);
    const key = JSON.stringify(selected);
    const current = grouped.get(key) ?? { values: selected, count: 0 };
    current.count += 1;
    grouped.set(key, current);
  }
  return [...grouped.values()].sort(compareCountThenValues((item) => item.values));
}

function distribution(values: readonly string[]): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

function tierForFact(fact: ObservedEmployeeFact, baselineDate: string): TenureTier {
  const days = Math.max(0, epochDay(baselineDate) - epochDay(fact.hireDate));
  return tenureTiers.find((tier) => days >= tier.minDays && (tier.maxDays === null || days < tier.maxDays))!;
}

function tenureCondition(tier: TenureTier): RuleCondition {
  const minimum: RuleCondition = { type: 'comparison', fact: { kind: 'tenure_days' }, operator: 'GTE', value: tier.minDays };
  if (tier.maxDays === null) return minimum;
  const maximum: RuleCondition = { type: 'comparison', fact: { kind: 'tenure_days' }, operator: 'LT', value: tier.maxDays };
  return tier.minDays === 0 ? maximum : and(minimum, maximum);
}

function tenureRange(tier: TenureTier): string {
  if (tier.maxDays === null) return `${Math.floor(tier.minDays / 365)} or more years of tenure`;
  if (tier.minDays === 0) return `less than ${Math.floor(tier.maxDays / 365)} years of tenure`;
  return `${Math.floor(tier.minDays / 365)} to ${Math.floor(tier.maxDays / 365)} years of tenure`;
}

function employeeEquals(field: 'location' | 'department' | 'employment_type', value: string): RuleCondition {
  return { type: 'comparison', fact: { kind: 'employee', field }, operator: 'EQ', value };
}

function attributeEquals(key: 'job_title' | 'pay_basis' | 'employment_status', value: string): RuleCondition {
  return { type: 'comparison', fact: { kind: 'attribute', key }, operator: 'EQ', value };
}

function attributeIn(key: 'job_title', values: readonly string[]): RuleCondition {
  return { type: 'comparison', fact: { kind: 'attribute', key }, operator: 'IN', value: [...values] };
}

function qualifierCondition(qualifier: string, value: string): RuleCondition {
  if (qualifier === 'location') return employeeEquals('location', value);
  if (qualifier === 'department') return employeeEquals('department', value);
  if (qualifier === 'employment-type') return employeeEquals('employment_type', value);
  if (qualifier === 'pay-basis') return attributeEquals('pay_basis', value);
  if (qualifier === 'status' || qualifier === 'employment-status') return attributeEquals('employment_status', value);
  if (qualifier === 'job-title') return attributeEquals('job_title', value);
  throw new Error(`Unsupported observed qualifier ${qualifier}`);
}

function and(...conditions: RuleCondition[]): RuleCondition {
  return { type: 'and', conditions };
}

function derivedKey(prefix: string, values: readonly string[]): string {
  const slug = values.join('-').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'segment';
  const suffix = fingerprint(values).slice(0, 8);
  const available = Math.max(1, 100 - prefix.length - suffix.length - 2);
  return `${prefix}-${slug.slice(0, available).replace(/-$/g, '')}-${suffix}`;
}

function humanize(value: string): string {
  return value.toLowerCase().replace(/(^|[\s/_-])\w/g, (match) => match.toUpperCase());
}

function epochDay(value: string): number {
  return Math.floor(Date.parse(`${value}T00:00:00Z`) / 86_400_000);
}

function compareGroup(left: ObservedGroupDefinition, right: ObservedGroupDefinition): number {
  return right.memberCount - left.memberCount || left.key.localeCompare(right.key);
}

function compareCountThenValues<T>(values: (item: T) => readonly string[]): (left: T & { count: number }, right: T & { count: number }) => number {
  return (left, right) => right.count - left.count || JSON.stringify(values(left)).localeCompare(JSON.stringify(values(right)));
}
