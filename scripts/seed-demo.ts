import { buildApp } from '../src/api/app.js';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import {
  DEMO_WORKSPACE_NAME,
  demoCategories,
  demoEmployees,
  demoGroups,
  demoOverrides,
  demoPolicies,
  demoRules,
} from '../src/demo/workspace.js';
import { todayUtc } from '../src/domain/dates.js';
import { ReconciliationWorker } from '../src/services/worker.js';

interface EntityResponse { id: string }

const config = loadConfig();
const pool = createPool(config);
const lockClient = await pool.connect();

async function request<T>(
  app: FastifyInstance,
  companyId: string | null,
  method: 'POST' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<T> {
  const options: InjectOptions = {
    method,
    url,
    headers: {
      ...(companyId === null ? {} : { 'x-company-id': companyId }),
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  };
  const response = await app.inject(options);
  if (response.statusCode >= 400) {
    throw new Error(`${method} ${url} failed (${response.statusCode}): ${response.body}`);
  }
  return response.statusCode === 204 ? undefined as T : response.json<T>();
}

async function verifyExisting(companyId: string): Promise<boolean> {
  const result = await pool.query<{
    employees: number; categories: number; policies: number; rules: number; groups: number; overrides: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM employees WHERE company_id = $1) AS employees,
       (SELECT count(*)::int FROM policy_categories WHERE company_id = $1) AS categories,
       (SELECT count(*)::int FROM policies WHERE company_id = $1) AS policies,
       (SELECT count(*)::int FROM rules WHERE company_id = $1) AS rules,
       (SELECT count(*)::int FROM groups WHERE company_id = $1) AS groups,
       (SELECT count(*)::int FROM manual_overrides WHERE company_id = $1) AS overrides`,
    [companyId],
  );
  const row = result.rows[0]!;
  return row.employees >= demoEmployees.length
    && row.categories >= demoCategories.length
    && row.policies >= demoPolicies.length
    && row.rules >= demoRules.length
    && row.groups >= demoGroups.length
    && row.overrides >= demoOverrides.length;
}

try {
  await lockClient.query('SELECT pg_advisory_lock(hashtext($1))', ['policy-assignment-demo-seed']);
  const existing = await pool.query<{ id: string }>(
    `SELECT c.id
       FROM companies c
      WHERE c.name = $1
        AND NOT EXISTS (SELECT 1 FROM evaluation_tenants et WHERE et.company_id = c.id)
      ORDER BY c.created_at, c.id
      LIMIT 1`,
    [DEMO_WORKSPACE_NAME],
  );
  const existingId = existing.rows[0]?.id;
  if (existingId !== undefined) {
    if (!await verifyExisting(existingId)) {
      throw new Error(`The existing ${DEMO_WORKSPACE_NAME} workspace is incomplete. Preserve it for diagnosis or remove it explicitly before reseeding.`);
    }
    process.stdout.write(`${DEMO_WORKSPACE_NAME} already exists and is complete (${existingId}).\n`);
  } else {
    const app = buildApp({ pool, config });
    await app.ready();
    try {
      const company = await request<EntityResponse>(app, null, 'POST', '/companies', { name: DEMO_WORKSPACE_NAME });
      const companyId = company.id;
      const effectiveFrom = todayUtc();
      const categoryIds = new Map<string, string>();
      for (const category of demoCategories) {
        const created = await request<EntityResponse>(app, companyId, 'POST', '/policy-categories', category);
        categoryIds.set(category.key, created.id);
      }
      const policyIds = new Map<string, string>();
      for (const policy of demoPolicies) {
        const created = await request<EntityResponse>(app, companyId, 'POST', '/policies', {
          key: policy.key,
          categoryId: categoryIds.get(policy.category),
          name: policy.name,
          description: policy.description,
          effectiveFrom,
        });
        policyIds.set(policy.key, created.id);
      }
      const groupIds = new Map<string, string>();
      for (const group of demoGroups) {
        const created = await request<EntityResponse>(app, companyId, 'POST', '/groups', group);
        groupIds.set(group.key, created.id);
      }
      const employeeIds = new Map<string, string>();
      for (const employee of demoEmployees) {
        const created = await request<EntityResponse>(app, companyId, 'POST', '/employees', {
          externalId: employee.externalId,
          displayName: employee.displayName,
          email: employee.email,
          location: employee.location,
          department: employee.department,
          employmentType: employee.employmentType,
          isManager: employee.isManager,
          hireDate: employee.hireDate,
          attributes: { country: 'United States', job_title: employee.jobTitle, pay_basis: employee.payBasis },
          groupIds: employee.groups.map((key) => groupIds.get(key)),
          effectiveFrom,
        });
        employeeIds.set(employee.externalId, created.id);
      }
      for (const rule of demoRules) {
        await request(app, companyId, 'POST', '/rules', {
          key: rule.key,
          policyId: policyIds.get(rule.policy),
          priority: rule.priority,
          enabled: true,
          validFrom: effectiveFrom,
          validTo: null,
          condition: rule.condition(groupIds),
          publish: true,
        });
      }
      for (const override of demoOverrides) {
        await request(app, companyId, 'POST', '/manual-overrides', {
          employeeId: employeeIds.get(override.employee),
          policyId: policyIds.get(override.policy),
          action: override.action,
          priority: 0,
          reason: override.reason,
          validFrom: effectiveFrom,
          validTo: null,
        });
      }
      const worker = new ReconciliationWorker(pool, config, () => new Date(), companyId);
      let jobs = 0;
      while (await worker.processOne()) {
        jobs += 1;
        if (jobs > 1_000) throw new Error('Demo reconciliation queue did not drain');
      }
      if (!await verifyExisting(companyId)) throw new Error('Demo workspace failed its completeness check after seeding');
      process.stdout.write(`Seeded ${DEMO_WORKSPACE_NAME}: ${demoEmployees.length} employees, ${demoPolicies.length} policies, ${demoRules.length} rules, ${jobs} reconciliation jobs.\n`);
    } finally {
      await app.close();
    }
  }
} finally {
  await lockClient.query('SELECT pg_advisory_unlock(hashtext($1))', ['policy-assignment-demo-seed']).catch(() => undefined);
  lockClient.release();
  await pool.end();
}
