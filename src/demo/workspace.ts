import type { RuleCondition } from '../domain/rules.js';

export const DEMO_WORKSPACE_NAME = 'Policy Assignment Demo';

export interface DemoEmployee {
  externalId: string;
  displayName: string;
  email: string;
  location: string;
  department: string;
  employmentType: string;
  isManager: boolean;
  hireDate: string;
  jobTitle: string;
  payBasis: 'Salaried' | 'Hourly';
  groups: string[];
}

export const demoCategories = [
  { key: 'vacation', name: 'Vacation', cardinality: 'SINGLE' as const },
  { key: 'payroll', name: 'Payroll', cardinality: 'SINGLE' as const },
  { key: 'compliance', name: 'Compliance', cardinality: 'MULTIPLE' as const },
  { key: 'application-access', name: 'Application access', cardinality: 'MULTIPLE' as const },
  { key: 'training', name: 'Training', cardinality: 'MULTIPLE' as const },
  { key: 'benefits', name: 'Benefits', cardinality: 'SINGLE' as const },
] as const;

export const demoPolicies = [
  { key: 'standard-pto', category: 'vacation', name: 'Standard PTO', description: 'The standard paid-time-off plan for full-time employees.' },
  { key: 'five-year-pto', category: 'vacation', name: '5-Year PTO', description: 'Additional time off for employees with at least five years of tenure.' },
  { key: 'executive-pto', category: 'vacation', name: 'Executive PTO', description: 'The vacation plan selected for people managers when competing plans match.' },
  { key: 'biweekly-payroll', category: 'payroll', name: 'Biweekly Payroll', description: 'Payroll processing every two weeks.' },
  { key: 'monthly-payroll', category: 'payroll', name: 'Monthly Payroll', description: 'Monthly payroll for independent contractors.' },
  { key: 'semimonthly-payroll', category: 'payroll', name: 'Semi-monthly Payroll', description: 'Payroll on two fixed dates each month.' },
  { key: 'california-meal-break', category: 'compliance', name: 'California Meal Break', description: 'Required meal-break acknowledgement for California employees.' },
  { key: 'new-york-workplace', category: 'compliance', name: 'New York Workplace Notice', description: 'New York workplace policy acknowledgement.' },
  { key: 'security-awareness', category: 'compliance', name: 'Security Awareness', description: 'Annual information-security acknowledgement.' },
  { key: 'github-access', category: 'application-access', name: 'GitHub', description: 'Source-code collaboration access.' },
  { key: 'salesforce-access', category: 'application-access', name: 'Salesforce', description: 'Customer relationship management access.' },
  { key: 'slack-access', category: 'application-access', name: 'Slack', description: 'Company messaging access.' },
  { key: 'manager-training', category: 'training', name: 'Manager Training', description: 'Required training for people managers.' },
  { key: 'contractor-safety', category: 'training', name: 'Contractor Safety', description: 'Safety and access training for contractors.' },
  { key: 'standard-benefits', category: 'benefits', name: 'Standard Benefits', description: 'Medical, dental, and vision benefit eligibility.' },
] as const;

export const demoGroups = [
  { key: 'engineering', name: 'Engineering', description: 'Employees who build and operate the product.' },
  { key: 'sales', name: 'Sales', description: 'Employees responsible for customer acquisition.' },
  { key: 'people-managers', name: 'People Managers', description: 'Employees with direct management responsibility.' },
  { key: 'us-full-time', name: 'US Full-time', description: 'Full-time employees working in the United States.' },
] as const;

export const demoEmployees: DemoEmployee[] = [
  { externalId: 'DEMO-001', displayName: 'Alice Johnson', email: 'alice.johnson@example.test', location: 'New York', department: 'Engineering', employmentType: 'Full-time', isManager: false, hireDate: '2022-03-14', jobTitle: 'Software Engineer', payBasis: 'Salaried', groups: ['engineering', 'us-full-time'] },
  { externalId: 'DEMO-002', displayName: 'Maya Patel', email: 'maya.patel@example.test', location: 'California', department: 'Engineering', employmentType: 'Full-time', isManager: true, hireDate: '2017-06-19', jobTitle: 'Engineering Manager', payBasis: 'Salaried', groups: ['engineering', 'people-managers', 'us-full-time'] },
  { externalId: 'DEMO-003', displayName: 'Diego Ramirez', email: 'diego.ramirez@example.test', location: 'Texas', department: 'Design', employmentType: 'Contractor', isManager: false, hireDate: '2025-01-08', jobTitle: 'Product Designer', payBasis: 'Hourly', groups: [] },
  { externalId: 'DEMO-004', displayName: 'Noah Williams', email: 'noah.williams@example.test', location: 'California', department: 'Sales', employmentType: 'Full-time', isManager: false, hireDate: '2021-09-27', jobTitle: 'Account Executive', payBasis: 'Salaried', groups: ['sales', 'us-full-time'] },
  { externalId: 'DEMO-005', displayName: 'Sofia Martinez', email: 'sofia.martinez@example.test', location: 'New York', department: 'Sales', employmentType: 'Full-time', isManager: true, hireDate: '2018-02-05', jobTitle: 'Regional Sales Manager', payBasis: 'Salaried', groups: ['sales', 'people-managers', 'us-full-time'] },
  { externalId: 'DEMO-006', displayName: 'Ethan Brown', email: 'ethan.brown@example.test', location: 'California', department: 'Engineering', employmentType: 'Full-time', isManager: false, hireDate: '2019-07-15', jobTitle: 'Staff Engineer', payBasis: 'Salaried', groups: ['engineering', 'us-full-time'] },
  { externalId: 'DEMO-007', displayName: 'Olivia Kim', email: 'olivia.kim@example.test', location: 'New York', department: 'People', employmentType: 'Full-time', isManager: true, hireDate: '2020-11-02', jobTitle: 'People Operations Manager', payBasis: 'Salaried', groups: ['people-managers', 'us-full-time'] },
  { externalId: 'DEMO-008', displayName: 'Liam Davis', email: 'liam.davis@example.test', location: 'Texas', department: 'Engineering', employmentType: 'Full-time', isManager: false, hireDate: '2024-04-22', jobTitle: 'Site Reliability Engineer', payBasis: 'Salaried', groups: ['engineering', 'us-full-time'] },
  { externalId: 'DEMO-009', displayName: 'Amina Yusuf', email: 'amina.yusuf@example.test', location: 'California', department: 'Finance', employmentType: 'Full-time', isManager: false, hireDate: '2023-08-07', jobTitle: 'Financial Analyst', payBasis: 'Hourly', groups: ['us-full-time'] },
  { externalId: 'DEMO-010', displayName: 'Lucas Anderson', email: 'lucas.anderson@example.test', location: 'New York', department: 'Sales', employmentType: 'Full-time', isManager: false, hireDate: '2025-02-17', jobTitle: 'Sales Development Representative', payBasis: 'Hourly', groups: ['sales', 'us-full-time'] },
  { externalId: 'DEMO-011', displayName: 'Emma Thompson', email: 'emma.thompson@example.test', location: 'California', department: 'People', employmentType: 'Full-time', isManager: false, hireDate: '2022-10-10', jobTitle: 'People Partner', payBasis: 'Salaried', groups: ['us-full-time'] },
  { externalId: 'DEMO-012', displayName: 'Mateo Garcia', email: 'mateo.garcia@example.test', location: 'Texas', department: 'Sales', employmentType: 'Full-time', isManager: false, hireDate: '2020-05-18', jobTitle: 'Solutions Consultant', payBasis: 'Salaried', groups: ['sales', 'us-full-time'] },
  { externalId: 'DEMO-013', displayName: 'Isabella Moore', email: 'isabella.moore@example.test', location: 'New York', department: 'Engineering', employmentType: 'Full-time', isManager: false, hireDate: '2016-12-12', jobTitle: 'Principal Engineer', payBasis: 'Salaried', groups: ['engineering', 'us-full-time'] },
  { externalId: 'DEMO-014', displayName: 'James Wilson', email: 'james.wilson@example.test', location: 'California', department: 'Operations', employmentType: 'Contractor', isManager: false, hireDate: '2025-05-01', jobTitle: 'Facilities Coordinator', payBasis: 'Hourly', groups: [] },
  { externalId: 'DEMO-015', displayName: 'Priya Shah', email: 'priya.shah@example.test', location: 'Texas', department: 'Engineering', employmentType: 'Full-time', isManager: true, hireDate: '2019-03-25', jobTitle: 'Platform Engineering Manager', payBasis: 'Salaried', groups: ['engineering', 'people-managers', 'us-full-time'] },
  { externalId: 'DEMO-016', displayName: 'Henry Clark', email: 'henry.clark@example.test', location: 'New York', department: 'Finance', employmentType: 'Full-time', isManager: false, hireDate: '2021-01-11', jobTitle: 'Accountant', payBasis: 'Salaried', groups: ['us-full-time'] },
  { externalId: 'DEMO-017', displayName: 'Chloe Nguyen', email: 'chloe.nguyen@example.test', location: 'California', department: 'Engineering', employmentType: 'Full-time', isManager: false, hireDate: '2024-09-09', jobTitle: 'Product Engineer', payBasis: 'Salaried', groups: ['engineering', 'us-full-time'] },
  { externalId: 'DEMO-018', displayName: 'Benjamin Lee', email: 'benjamin.lee@example.test', location: 'New York', department: 'Support', employmentType: 'Full-time', isManager: false, hireDate: '2023-06-12', jobTitle: 'Customer Support Specialist', payBasis: 'Hourly', groups: ['us-full-time'] },
  { externalId: 'DEMO-019', displayName: 'Nora Robinson', email: 'nora.robinson@example.test', location: 'Texas', department: 'People', employmentType: 'Full-time', isManager: false, hireDate: '2018-08-20', jobTitle: 'Recruiter', payBasis: 'Salaried', groups: ['us-full-time'] },
  { externalId: 'DEMO-020', displayName: 'Samuel Wright', email: 'samuel.wright@example.test', location: 'California', department: 'Sales', employmentType: 'Full-time', isManager: true, hireDate: '2017-04-03', jobTitle: 'VP of Sales', payBasis: 'Salaried', groups: ['sales', 'people-managers', 'us-full-time'] },
  { externalId: 'DEMO-021', displayName: 'Leila Hassan', email: 'leila.hassan@example.test', location: 'New York', department: 'Engineering', employmentType: 'Full-time', isManager: false, hireDate: '2025-06-16', jobTitle: 'Quality Engineer', payBasis: 'Hourly', groups: ['engineering', 'us-full-time'] },
  { externalId: 'DEMO-022', displayName: 'Jack Taylor', email: 'jack.taylor@example.test', location: 'Texas', department: 'Operations', employmentType: 'Contractor', isManager: false, hireDate: '2026-01-12', jobTitle: 'Implementation Specialist', payBasis: 'Hourly', groups: [] },
  { externalId: 'DEMO-023', displayName: 'Zoe Carter', email: 'zoe.carter@example.test', location: 'California', department: 'Engineering', employmentType: 'Full-time', isManager: false, hireDate: '2020-02-24', jobTitle: 'Security Engineer', payBasis: 'Salaried', groups: ['engineering', 'us-full-time'] },
  { externalId: 'DEMO-024', displayName: 'Owen Scott', email: 'owen.scott@example.test', location: 'New York', department: 'Sales', employmentType: 'Full-time', isManager: false, hireDate: '2022-07-18', jobTitle: 'Account Manager', payBasis: 'Salaried', groups: ['sales', 'us-full-time'] },
] as const;

const employeeEquals = (field: 'location' | 'department' | 'employment_type' | 'is_manager', value: string | boolean): RuleCondition => ({
  type: 'comparison', fact: { kind: 'employee', field }, operator: 'EQ', value,
});
const attributeEquals = (key: string, value: string): RuleCondition => ({
  type: 'comparison', fact: { kind: 'attribute', key }, operator: 'EQ', value,
});
const groupMember = (groupId: string): RuleCondition => ({ type: 'group', groupId, operator: 'MEMBER_OF' });
const all = (...conditions: RuleCondition[]): RuleCondition => ({ type: 'and', conditions });

export interface DemoRuleDefinition {
  key: string;
  policy: string;
  priority: number;
  condition: (groups: ReadonlyMap<string, string>) => RuleCondition;
}

export const demoRules: DemoRuleDefinition[] = [
  { key: 'full-time-standard-pto', policy: 'standard-pto', priority: 100, condition: () => employeeEquals('employment_type', 'Full-time') },
  { key: 'five-year-tenure-pto', policy: 'five-year-pto', priority: 160, condition: () => ({ type: 'comparison', fact: { kind: 'tenure_days' }, operator: 'GTE', value: 1_825 }) },
  { key: 'people-manager-executive-pto', policy: 'executive-pto', priority: 220, condition: (groups) => groupMember(groups.get('people-managers')!) },
  { key: 'us-salaried-biweekly-payroll', policy: 'biweekly-payroll', priority: 100, condition: (groups) => all(groupMember(groups.get('us-full-time')!), attributeEquals('pay_basis', 'Salaried')) },
  { key: 'contractor-monthly-payroll', policy: 'monthly-payroll', priority: 90, condition: () => employeeEquals('employment_type', 'Contractor') },
  { key: 'california-sales-semimonthly-payroll', policy: 'semimonthly-payroll', priority: 170, condition: () => all(employeeEquals('location', 'California'), employeeEquals('department', 'Sales')) },
  { key: 'california-meal-break', policy: 'california-meal-break', priority: 120, condition: () => employeeEquals('location', 'California') },
  { key: 'new-york-workplace-notice', policy: 'new-york-workplace', priority: 110, condition: () => employeeEquals('location', 'New York') },
  { key: 'full-time-security-awareness', policy: 'security-awareness', priority: 80, condition: () => employeeEquals('employment_type', 'Full-time') },
  { key: 'engineering-github-access', policy: 'github-access', priority: 120, condition: (groups) => groupMember(groups.get('engineering')!) },
  { key: 'sales-salesforce-access', policy: 'salesforce-access', priority: 120, condition: (groups) => groupMember(groups.get('sales')!) },
  { key: 'full-time-slack-access', policy: 'slack-access', priority: 80, condition: () => employeeEquals('employment_type', 'Full-time') },
  { key: 'people-manager-training', policy: 'manager-training', priority: 100, condition: (groups) => groupMember(groups.get('people-managers')!) },
  { key: 'contractor-safety-training', policy: 'contractor-safety', priority: 100, condition: () => employeeEquals('employment_type', 'Contractor') },
  { key: 'full-time-standard-benefits', policy: 'standard-benefits', priority: 100, condition: () => employeeEquals('employment_type', 'Full-time') },
];

export const demoOverrides = [
  { employee: 'DEMO-003', policy: 'semimonthly-payroll', action: 'ASSIGN' as const, reason: 'Contractual payroll arrangement' },
  { employee: 'DEMO-023', policy: 'slack-access', action: 'EXCLUDE' as const, reason: 'Restricted security environment' },
] as const;
