import type { DbClient } from '../src/db.js';
import { createPool, inTransaction } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { todayUtc } from '../src/domain/dates.js';
import { compileRule, type RuleCondition } from '../src/domain/rules.js';
import { insertRuleDependencies } from '../src/api/helpers.js';
import { enqueueJob } from '../src/services/jobs.js';
import { ReconciliationWorker } from '../src/services/worker.js';

const config = loadConfig();
const pool = createPool(config);
const today = todayUtc();

try {
  const existing = await pool.query<{ id: string }>("SELECT id FROM companies WHERE name = 'Warp Policy Demo' LIMIT 1");
  if (existing.rows[0] !== undefined) {
    process.stdout.write(`Demo already exists. Company ID: ${existing.rows[0].id}\n`);
  } else {
    const companyId = await inTransaction(pool, async (client) => {
      const company = await client.query<{ id: string }>("INSERT INTO companies (name) VALUES ('Warp Policy Demo') RETURNING id");
      const id = company.rows[0]!.id;
      const categories = {
        pto: await createCategory(client, id, 'pto', 'Paid time off', 'SINGLE'),
        payroll: await createCategory(client, id, 'payroll', 'Payroll schedule', 'SINGLE'),
        compliance: await createCategory(client, id, 'compliance', 'Compliance', 'MULTIPLE'),
        access: await createCategory(client, id, 'access', 'Application access', 'MULTIPLE'),
        training: await createCategory(client, id, 'training', 'Training', 'MULTIPLE'),
      };
      const policies = {
        standardPto: await createPolicy(client, id, categories.pto, 'standard-pto', 'Standard PTO'),
        enhancedPto: await createPolicy(client, id, categories.pto, 'enhanced-pto', 'Enhanced PTO'),
        biweekly: await createPolicy(client, id, categories.payroll, 'biweekly-payroll', 'Biweekly Payroll'),
        monthly: await createPolicy(client, id, categories.payroll, 'monthly-payroll', 'Monthly Payroll'),
        caCompliance: await createPolicy(client, id, categories.compliance, 'ca-compliance', 'California Compliance Training'),
        github: await createPolicy(client, id, categories.access, 'github-access', 'GitHub Access'),
        salesforce: await createPolicy(client, id, categories.access, 'salesforce-access', 'Salesforce Access'),
        managerTraining: await createPolicy(client, id, categories.training, 'manager-training', 'Manager Training'),
      };
      const groups = {
        engineering: await createGroup(client, id, 'engineering', 'Engineering'),
        sales: await createGroup(client, id, 'sales', 'Sales'),
      };
      const employees = {
        californiaEngineer: await createEmployee(client, id, 'E-100', 'Avery Chen', {
          email: 'avery@example.test', location: 'CA', department: 'Engineering', employmentType: 'full_time',
          hireDate: addDays(today, -1_200), isManager: false, attributes: { country: 'US', level: 4 },
        }),
        newYorkSales: await createEmployee(client, id, 'E-200', 'Jordan Brooks', {
          email: 'jordan@example.test', location: 'NY', department: 'Sales', employmentType: 'full_time',
          hireDate: addDays(today, -400), isManager: false, attributes: { country: 'US', territory: 'East' },
        }),
        manager: await createEmployee(client, id, 'E-300', 'Morgan Diaz', {
          email: 'morgan@example.test', location: 'WA', department: 'Engineering', employmentType: 'full_time',
          hireDate: addDays(today, -2_000), isManager: true, attributes: { country: 'US', level: 7 },
        }),
        contractor: await createEmployee(client, id, 'C-400', 'Riley Singh', {
          email: 'riley@example.test', location: 'TX', department: 'Engineering', employmentType: 'contractor',
          hireDate: addDays(today, -90), isManager: false, attributes: { country: 'US', agency: 'Northstar' },
        }),
        approachingTenure: await createEmployee(client, id, 'E-500', 'Taylor Wilson', {
          email: 'taylor@example.test', location: 'NY', department: 'Sales', employmentType: 'full_time',
          hireDate: addDays(today, -729), isManager: false, attributes: { country: 'US', territory: 'Central' },
        }),
      };
      await addMember(client, id, groups.engineering, employees.californiaEngineer);
      await addMember(client, id, groups.engineering, employees.manager);
      await addMember(client, id, groups.engineering, employees.contractor);
      await addMember(client, id, groups.sales, employees.newYorkSales);
      await addMember(client, id, groups.sales, employees.approachingTenure);

      const comparison = (field: string, operator: 'EQ' | 'GTE', value: string | number): RuleCondition => ({
        type: 'comparison',
        fact: field === 'tenure_days' ? { kind: 'tenure_days' } : { kind: 'employee', field: field as 'location' },
        operator,
        value,
      });
      await createRule(client, id, 'default-standard-pto', policies.standardPto, 10, {
        type: 'comparison', fact: { kind: 'as_of_date' }, operator: 'GTE', value: '2000-01-01',
      });
      await createRule(client, id, 'enhanced-pto-tenure', policies.enhancedPto, 20, comparison('tenure_days', 'GTE', 730));
      await createRule(client, id, 'california-compliance', policies.caCompliance, 10, comparison('location', 'EQ', 'CA'));
      await createRule(client, id, 'engineering-github', policies.github, 10, {
        type: 'group', groupId: groups.engineering, operator: 'MEMBER_OF',
      });
      await createRule(client, id, 'sales-salesforce', policies.salesforce, 10, {
        type: 'group', groupId: groups.sales, operator: 'MEMBER_OF',
      });
      await createRule(client, id, 'manager-training', policies.managerTraining, 10, {
        type: 'comparison', fact: { kind: 'employee', field: 'is_manager' }, operator: 'EQ', value: true,
      });
      await createRule(client, id, 'us-full-time-biweekly', policies.biweekly, 10, {
        type: 'and', conditions: [
          { type: 'comparison', fact: { kind: 'attribute', key: 'country' }, operator: 'EQ', value: 'US' },
          comparison('employment_type', 'EQ', 'full_time'),
        ],
      });
      await createRule(client, id, 'contractor-monthly', policies.monthly, 30, comparison('employment_type', 'EQ', 'contractor'));
      await client.query(
        `INSERT INTO manual_overrides
          (company_id, employee_id, policy_id, action, priority, reason, valid_from)
         VALUES ($1, $2, $3, 'ASSIGN', 100, 'Executive-approved payroll exception', $4::date)`,
        [id, employees.contractor, policies.biweekly, today],
      );
      await enqueueJob(client, {
        companyId: id,
        eventType: 'DEMO_SEED_COMPLETED',
        scope: 'FULL',
        payload: {},
        dedupeKey: 'demo-seed-full-reconciliation',
      });
      return id;
    });

    const worker = new ReconciliationWorker(pool, { ...config, WORKER_CONCURRENCY: 1 });
    while (await worker.processOne()) {
      // Drain the deterministic seed reconciliation queue before reporting success.
    }
    process.stdout.write(`Seeded and reconciled demo company. Company ID: ${companyId}\n`);
  }
} finally {
  await pool.end();
}

async function createCategory(client: DbClient, companyId: string, key: string, name: string, cardinality: string): Promise<string> {
  const result = await client.query<{ id: string }>(
    'INSERT INTO policy_categories (company_id, key, name, cardinality) VALUES ($1, $2, $3, $4) RETURNING id',
    [companyId, key, name, cardinality],
  );
  return result.rows[0]!.id;
}

async function createPolicy(client: DbClient, companyId: string, categoryId: string, key: string, name: string): Promise<string> {
  const policy = await client.query<{ id: string }>(
    'INSERT INTO policies (company_id, category_id, key) VALUES ($1, $2, $3) RETURNING id',
    [companyId, categoryId, key],
  );
  const policyId = policy.rows[0]!.id;
  const version = await client.query<{ id: string }>(
    `INSERT INTO policy_versions (company_id, policy_id, version, valid_from, name)
     VALUES ($1, $2, 1, $3::date, $4) RETURNING id`,
    [companyId, policyId, today, name],
  );
  await client.query('UPDATE policies SET current_version_id = $3 WHERE company_id = $1 AND id = $2', [
    companyId, policyId, version.rows[0]!.id,
  ]);
  return policyId;
}

async function createGroup(client: DbClient, companyId: string, key: string, name: string): Promise<string> {
  const result = await client.query<{ id: string }>(
    'INSERT INTO groups (company_id, slug, name) VALUES ($1, $2, $3) RETURNING id',
    [companyId, key, name],
  );
  return result.rows[0]!.id;
}

async function createEmployee(
  client: DbClient,
  companyId: string,
  externalId: string,
  name: string,
  values: {
    email: string; location: string; department: string; employmentType: string; hireDate: string;
    isManager: boolean; attributes: Record<string, unknown>;
  },
): Promise<string> {
  const employee = await client.query<{ id: string }>(
    'INSERT INTO employees (company_id, external_id) VALUES ($1, $2) RETURNING id',
    [companyId, externalId],
  );
  const id = employee.rows[0]!.id;
  const version = await client.query<{ id: string }>(
    `INSERT INTO employee_versions
       (company_id, employee_id, version, valid_from, display_name, email, location, department,
        employment_type, is_manager, hire_date, attributes, changed_fields)
     VALUES ($1, $2, 1, $3::date, $4, $5, $6, $7, $8, $9, $10::date, $11::jsonb, '{created}')
     RETURNING id`,
    [companyId, id, today, name, values.email, values.location, values.department, values.employmentType,
      values.isManager, values.hireDate, JSON.stringify(values.attributes)],
  );
  await client.query('UPDATE employees SET current_version_id = $3 WHERE company_id = $1 AND id = $2', [
    companyId, id, version.rows[0]!.id,
  ]);
  return id;
}

async function addMember(client: DbClient, companyId: string, groupId: string, employeeId: string): Promise<void> {
  await client.query(
    'INSERT INTO group_memberships (company_id, group_id, employee_id, valid_from) VALUES ($1, $2, $3, $4::date)',
    [companyId, groupId, employeeId, today],
  );
}

async function createRule(
  client: DbClient,
  companyId: string,
  key: string,
  policyId: string,
  priority: number,
  condition: RuleCondition,
): Promise<void> {
  const compiled = compileRule(condition);
  const rule = await client.query<{ id: string }>('INSERT INTO rules (company_id, key) VALUES ($1, $2) RETURNING id', [companyId, key]);
  const ruleId = rule.rows[0]!.id;
  const version = await client.query<{ id: string }>(
    `INSERT INTO rule_versions
       (company_id, rule_id, policy_id, version, status, priority, enabled, valid_from,
        condition, specificity, content_hash, published_at)
     VALUES ($1, $2, $3, 1, 'PUBLISHED', $4, true, $5::date, $6::jsonb, $7, $8, now())
     RETURNING id`,
    [companyId, ruleId, policyId, priority, today, JSON.stringify(compiled.condition), compiled.specificity, compiled.contentHash],
  );
  await client.query('UPDATE rules SET current_version_id = $3 WHERE company_id = $1 AND id = $2', [
    companyId, ruleId, version.rows[0]!.id,
  ]);
  await insertRuleDependencies(client, companyId, version.rows[0]!.id, compiled.dependencies);
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
