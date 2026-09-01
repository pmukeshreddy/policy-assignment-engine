import type { FastifyInstance } from 'fastify';
import type { InjectOptions } from 'light-my-request';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import { createPool, type DbPool } from '../../src/db.js';
import { ReconciliationService } from '../../src/services/reconciliation.js';
import { ReconciliationWorker } from '../../src/services/worker.js';
import { compareRegressionCheckpoint } from '../../src/eval/regression.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://policy:policy@localhost:5432/policy_engine';
let now = new Date('2026-08-01T12:00:00Z');
const clock = (): Date => now;
let pool: DbPool;
let app: FastifyInstance;
let companyId: string;

const workerConfig = {
  WORKER_POLL_MS: 50,
  WORKER_CONCURRENCY: 1,
  JOB_MAX_ATTEMPTS: 3,
  JOB_LEASE_SECONDS: 10,
};

beforeAll(async () => {
  pool = createPool({ DATABASE_URL: databaseUrl });
  await pool.query('SELECT 1 FROM schema_migrations LIMIT 1');
  app = buildApp({ pool, config: { LOG_LEVEL: 'silent', PREVIEW_MAX_EMPLOYEES: 10_000 }, clock });
  await app.ready();
  const company = await request('POST', '/companies', { name: `Integration ${crypto.randomUUID()}` }, false);
  companyId = company.id;
});

afterAll(async () => {
  if (companyId !== undefined) await pool.query('DELETE FROM companies WHERE id = $1', [companyId]);
  await app.close();
  await pool.end();
});

describe('PostgreSQL API, reconciliation, and history', () => {
  it('executes the policy workflow with exact preview, explanation, override, history, and retry safety', async () => {
    const category = await request('POST', '/policy-categories', { key: 'pto', name: 'Paid time off', cardinality: 'SINGLE' });
    const standard = await request('POST', '/policies', {
      key: 'standard', categoryId: category.id, name: 'Standard PTO', effectiveFrom: '2026-08-01',
    });
    const enhanced = await request('POST', '/policies', {
      key: 'enhanced', categoryId: category.id, name: 'Enhanced PTO', effectiveFrom: '2026-08-01',
    });
    const employee = await request('POST', '/employees', {
      externalId: 'E-100', displayName: 'Integration Employee', location: 'CA', department: 'Engineering',
      employmentType: 'full_time', hireDate: '2024-01-01', attributes: { country: 'US' }, effectiveFrom: '2026-08-01',
    });
    await request('POST', '/rules', {
      key: 'default-pto', policyId: standard.id, priority: 10, enabled: true, validFrom: '2026-08-01', publish: true,
      condition: { type: 'comparison', fact: { kind: 'as_of_date' }, operator: 'GTE', value: '2000-01-01' },
    });
    const enhancedRule = await request('POST', '/rules', {
      key: 'enhanced-ca', policyId: enhanced.id, priority: 20, enabled: true, validFrom: '2026-08-01', publish: true,
      condition: { type: 'comparison', fact: { kind: 'employee', field: 'location' }, operator: 'EQ', value: 'CA' },
    });
    await drainJobs();

    const regressionCheckpoint = await compareRegressionCheckpoint(pool, {
      companyId,
      employeeIds: [employee.id],
      asOfDate: '2026-08-01',
    });
    expect(regressionCheckpoint.mismatches).toEqual([]);
    expect(regressionCheckpoint.deterministicFailures).toBe(0);

    const initial = await request('GET', `/employees/${employee.id}/assignments`);
    expect(initial.data).toHaveLength(1);
    expect(initial.data[0].policy_key).toBe('enhanced');
    const initialAssignmentId = initial.data[0].assignment_id;
    const why = await request('GET', `/employees/${employee.id}/assignments/${initialAssignmentId}/explanation`);
    expect(why.decision.winningCandidate.ruleVersionId).toBe(enhancedRule.versionId);
    expect(why.decision.competingCandidates[0].reason).toMatch(/higher priority/);
    expect(why.decision.competingCandidates[0].candidate.policyName).toBe('Standard PTO');
    expect(why.employeeSnapshot.location).toBe('CA');

    const employeeChangePreview = await request('POST', '/employees/preview', {
      employeeId: employee.id,
      displayName: 'Integration Employee',
      location: 'NY',
      department: 'Engineering',
      employmentType: 'full_time',
      hireDate: '2024-01-01',
      attributes: { country: 'US' },
      groupIds: [],
      asOfDate: '2026-08-01',
    });
    expect(employeeChangePreview.summary).toMatchObject({
      categoriesChanged: 1,
      assignmentsAdded: 1,
      assignmentsRemoved: 1,
      assignmentsReplaced: 1,
    });
    expect(employeeChangePreview.categories.find((item: { key: string }) => item.key === 'pto')).toMatchObject({
      before: [{ name: 'Enhanced PTO' }],
      after: [{ name: 'Standard PTO' }],
    });

    const employeeList = await request('GET', '/employees?search=Integration&location=CA&limit=10');
    expect(employeeList.meta).toMatchObject({ total: 1, limit: 10, offset: 0 });
    expect(employeeList.facets.locations).toContain('CA');
    expect(employeeList.data[0].policy_count).toBe(1);
    const overview = await request('GET', '/overview');
    expect(overview).toMatchObject({ employees: 1, active_policies: 2, active_rules: 2, assignments: 1 });
    expect(overview.activity.length).toBeGreaterThan(0);

    const preview = await request('POST', '/rules/preview', {
      ruleId: enhancedRule.id,
      policyId: enhanced.id,
      priority: 20,
      enabled: true,
      validFrom: '2026-08-01',
      asOfDate: '2026-08-01',
      condition: { type: 'comparison', fact: { kind: 'employee', field: 'location' }, operator: 'EQ', value: 'NY' },
    });
    expect(preview).toMatchObject({
      employeesEvaluated: 1, affectedEmployees: 1, assignmentsAdded: 1, assignmentsRemoved: 1, assignmentsChanged: 1,
    });

    now = new Date('2026-08-02T12:00:00Z');
    await request('POST', `/rules/${enhancedRule.id}/versions`, {
      policyId: enhanced.id, priority: 21, enabled: true, validFrom: '2026-08-02', publish: true,
      condition: { type: 'comparison', fact: { kind: 'employee', field: 'location' }, operator: 'EQ', value: 'CA' },
    });
    await drainJobs();
    const manual = await request('POST', '/manual-overrides', {
      employeeId: employee.id, policyId: standard.id, action: 'ASSIGN', priority: -100,
      reason: 'Approved exception', validFrom: '2026-08-02',
    });
    await drainJobs();
    const overridden = await request('GET', `/employees/${employee.id}/assignments`);
    expect(overridden.data[0].policy_key).toBe('standard');
    const manualWhy = await request('GET', `/employees/${employee.id}/assignments/${overridden.data[0].assignment_id}/explanation`);
    expect(manualWhy.decision.source).toBe('MANUAL');

    const historical = await request('GET', `/employees/${employee.id}/assignments/as-of?date=2026-08-01`);
    expect(historical.data.map((assignment: { policy_key: string }) => assignment.policy_key)).toEqual(['enhanced']);

    const service = new ReconciliationService(pool);
    const firstRetry = await service.reconcileEmployeeCategory({
      companyId, employeeId: employee.id, categoryId: category.id, asOfDate: '2026-08-02',
    });
    const secondRetry = await service.reconcileEmployeeCategory({
      companyId, employeeId: employee.id, categoryId: category.id, asOfDate: '2026-08-02',
    });
    expect(firstRetry.addedPolicyIds).toEqual([]);
    expect(secondRetry.addedPolicyIds).toEqual([]);
    await Promise.all([
      service.reconcileEmployeeCategory({ companyId, employeeId: employee.id, categoryId: category.id, asOfDate: '2026-08-02' }),
      service.reconcileEmployeeCategory({ companyId, employeeId: employee.id, categoryId: category.id, asOfDate: '2026-08-02' }),
    ]);
    const assignmentCount = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM materialized_assignments WHERE company_id = $1 AND employee_id = $2 AND category_id = $3',
      [companyId, employee.id, category.id],
    );
    expect(Number(assignmentCount.rows[0]?.count)).toBe(1);

    now = new Date('2026-08-03T12:00:00Z');
    await request('DELETE', `/manual-overrides/${manual.id}`);
    await drainJobs();
    const restored = await request('GET', `/employees/${employee.id}/assignments`);
    expect(restored.data[0].policy_key).toBe('enhanced');
    const stableHistory = await request('GET', `/employees/${employee.id}/assignments/as-of?date=2026-08-01`);
    expect(stableHistory.data[0].policy_key).toBe('enhanced');

    const sameDayOverride = await request('POST', '/manual-overrides', {
      employeeId: employee.id, policyId: standard.id, action: 'EXCLUDE', priority: 0,
      reason: 'Same-day revocation regression', validFrom: '2026-08-03',
    });
    await request('DELETE', `/manual-overrides/${sameDayOverride.id}`);
    await drainJobs();
    expect((await request('GET', `/employees/${employee.id}/assignments`)).data[0].policy_key).toBe('enhanced');
  });

  it('uses group dependency impact without disturbing another category', async () => {
    const category = await request('POST', '/policy-categories', { key: 'access', name: 'Access', cardinality: 'MULTIPLE' });
    const github = await request('POST', '/policies', { key: 'github', categoryId: category.id, name: 'GitHub', effectiveFrom: '2026-08-03' });
    const employeeList = await request('GET', '/employees');
    const employee = employeeList.data[0];
    const group = await request('POST', '/groups', { key: 'engineering', name: 'Engineering' });
    await request('POST', '/rules', {
      key: 'engineering-github', policyId: github.id, priority: 10, validFrom: '2026-08-03', publish: true,
      condition: { type: 'group', groupId: group.id, operator: 'MEMBER_OF' },
    });
    await drainJobs();
    expect((await request('GET', `/employees/${employee.id}/assignments`)).data.some((item: { policy_key: string }) => item.policy_key === 'github')).toBe(false);
    await request('POST', `/groups/${group.id}/members`, { employeeId: employee.id, effectiveFrom: '2026-08-03' });
    await drainJobs();
    expect((await request('GET', `/employees/${employee.id}/assignments`)).data.some((item: { policy_key: string }) => item.policy_key === 'github')).toBe(true);
  });

  it('fires a persisted tenure transition when no source record changes', async () => {
    now = new Date('2026-08-02T12:00:00Z');
    const category = await request('POST', '/policy-categories', { key: 'tenure-benefit', name: 'Tenure benefit', cardinality: 'SINGLE' });
    const basic = await request('POST', '/policies', { key: 'tenure-basic', categoryId: category.id, name: 'Basic', effectiveFrom: '2026-08-02' });
    const earned = await request('POST', '/policies', { key: 'tenure-earned', categoryId: category.id, name: 'Earned', effectiveFrom: '2026-08-02' });
    const employee = await request('POST', '/employees', {
      externalId: 'E-TIME', displayName: 'Temporal Employee', hireDate: '2024-08-03', effectiveFrom: '2026-08-02',
    });
    await request('POST', '/rules', {
      key: 'tenure-default', policyId: basic.id, priority: 1, validFrom: '2026-08-02', publish: true,
      condition: { type: 'comparison', fact: { kind: 'as_of_date' }, operator: 'GTE', value: '2000-01-01' },
    });
    await request('POST', '/rules', {
      key: 'tenure-earned-rule', policyId: earned.id, priority: 10, validFrom: '2026-08-02', publish: true,
      condition: { type: 'comparison', fact: { kind: 'tenure_days' }, operator: 'GTE', value: 730 },
    });
    await drainJobs();
    const beforeTransition = (await request('GET', `/employees/${employee.id}/assignments`)).data;
    expect(beforeTransition.find((assignment: { category_key: string }) => assignment.category_key === 'tenure-benefit').policy_key)
      .toBe('tenure-basic');
    const scheduled = await pool.query<{ transition_date: string }>(
      `SELECT transition_date::text FROM scheduled_evaluations
        WHERE company_id = $1 AND employee_id = $2 AND processed_at IS NULL`,
      [companyId, employee.id],
    );
    expect(scheduled.rows.map((row) => row.transition_date)).toContain('2026-08-03');
    now = new Date('2026-08-03T12:00:00Z');
    const worker = makeWorker();
    expect(await worker.enqueueDueTemporalJobs()).toBeGreaterThan(0);
    await drainJobs();
    const afterTransition = (await request('GET', `/employees/${employee.id}/assignments`)).data;
    expect(afterTransition.find((assignment: { category_key: string }) => assignment.category_key === 'tenure-benefit').policy_key)
      .toBe('tenure-earned');
  });

  it('enforces company isolation on entity reads', async () => {
    const other = await request('POST', '/companies', { name: `Other ${crypto.randomUUID()}` }, false);
    const employee = (await request('GET', '/employees')).data[0];
    const response = await app.inject({
      method: 'GET', url: `/employees/${employee.id}`, headers: { 'x-company-id': other.id },
    });
    expect(response.statusCode).toBe(404);
    await pool.query('DELETE FROM companies WHERE id = $1', [other.id]);
  });

  it('reserves evaluation-tenant jobs for an explicitly scoped worker', async () => {
    const evaluationCompany = await request('POST', '/companies', { name: `Evaluation ${crypto.randomUUID()}` }, false);
    await pool.query(
      `INSERT INTO evaluation_tenants (key, company_id, dataset_id)
       VALUES ($1, $2, 'integration-evaluation')`,
      [`integration-${crypto.randomUUID()}`, evaluationCompany.id],
    );
    const job = await pool.query<{ id: string }>(
      `INSERT INTO reconciliation_jobs (company_id, event_type, scope, payload, dedupe_key)
       VALUES ($1, 'INTEGRATION_EVALUATION_JOB', 'FULL', '{}'::jsonb, 'integration-evaluation-job')
       RETURNING id`,
      [evaluationCompany.id],
    );
    const unscoped = new ReconciliationWorker(pool, workerConfig, clock);
    expect(await unscoped.processNext()).toBeNull();
    const scoped = new ReconciliationWorker(pool, workerConfig, clock, evaluationCompany.id);
    expect((await scoped.processNext())?.job.id).toBe(job.rows[0]!.id);
    await pool.query('DELETE FROM companies WHERE id = $1', [evaluationCompany.id]);
  });

  it('delays a future-effective employee job and excludes the employee from current impact', async () => {
    now = new Date('2026-08-30T12:00:00Z');
    const employee = await request('POST', '/employees', {
      externalId: 'E-FUTURE', displayName: 'Future Employee', location: 'CA', effectiveFrom: '2026-09-02',
    });
    const jobs = await pool.query<{ status: string; available_at: Date }>(
      `SELECT status, available_at FROM reconciliation_jobs
        WHERE company_id = $1 AND payload ->> 'employeeId' = $2
        ORDER BY created_at DESC LIMIT 1`,
      [companyId, employee.id],
    );
    expect(jobs.rows[0]?.status).toBe('PENDING');
    expect(jobs.rows[0]!.available_at.toISOString().slice(0, 10)).toBe('2026-09-02');
    expect((await request('GET', '/employees')).data.some((item: { id: string }) => item.id === employee.id)).toBe(false);

    now = new Date('2026-09-02T12:00:00Z');
    // The test clock is injected but PostgreSQL's wall clock is not; release the delayed job to simulate midnight.
    await pool.query(
      `UPDATE reconciliation_jobs SET available_at = now()
        WHERE company_id = $1 AND payload ->> 'employeeId' = $2`,
      [companyId, employee.id],
    );
    await drainJobs();
    expect((await request('GET', '/employees')).data.some((item: { id: string }) => item.id === employee.id)).toBe(true);
  });
});

function makeWorker(): ReconciliationWorker {
  return new ReconciliationWorker(pool, workerConfig, clock, companyId);
}

async function drainJobs(): Promise<void> {
  const worker = makeWorker();
  let processed = 0;
  while (await worker.processOne()) {
    processed += 1;
    if (processed > 500) throw new Error('Integration worker did not drain');
  }
  const failed = await pool.query<{ last_error: string }>(
    `SELECT last_error FROM reconciliation_jobs
      WHERE company_id = $1 AND status IN ('FAILED', 'DEAD')`,
    [companyId],
  );
  expect(failed.rows).toEqual([]);
}

async function request(method: NonNullable<InjectOptions['method']>, url: string, body?: object, tenant = true): Promise<any> {
  const options: InjectOptions = {
    method,
    url,
    headers: tenant && companyId !== undefined ? { 'x-company-id': companyId } : {},
  };
  if (body !== undefined) options.payload = body;
  const response = await app.inject(options);
  if (response.statusCode >= 400) throw new Error(`${method} ${url}: ${response.statusCode} ${response.body}`);
  return response.statusCode === 204 ? null : response.json();
}
