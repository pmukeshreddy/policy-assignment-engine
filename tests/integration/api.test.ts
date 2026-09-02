import type { FastifyInstance } from 'fastify';
import type { InjectOptions } from 'light-my-request';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import { createPool, inTransaction, type DbPool } from '../../src/db.js';
import {
  CERTIFIED_RULE_COUNT,
  certifiedBaselineSemantics,
  createCertifiedBaseline,
} from '../../src/baseline/certified-universe.js';
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
  await pool.query(
    `INSERT INTO evaluation_tenants (key, company_id, dataset_id)
     VALUES ($1, $2, 'integration-suite')`,
    [`integration-suite-${crypto.randomUUID()}`, companyId],
  );
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
      externalId: 'E-100', displayName: 'Integration A Employee', location: 'CA', department: 'Engineering',
      employmentType: 'full_time', hireDate: '2024-01-01', attributes: { country: 'US', employment_status: 'ACTIVE' }, effectiveFrom: '2026-08-01',
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
    expect(initial.meta).toEqual({ total: 1, limit: 100, offset: 0 });
    expect(initial.data[0].policy_key).toBe('enhanced');
    const initialAssignmentId = initial.data[0].assignment_id;
    const why = await request('GET', `/employees/${employee.id}/assignments/${initialAssignmentId}/explanation`);
    expect(why.decision.winningCandidate.ruleVersionId).toBe(enhancedRule.versionId);
    expect(why.decision.competingCandidates[0].reason).toMatch(/higher priority/);
    expect(why.decision.competingCandidates[0].candidate.policyName).toBe('Standard PTO');
    expect(why.employee).toMatchObject({
      identity_label: 'Integration A Employee',
      record_label: 'Employee ID E-100',
    });
    expect(why.employeeSnapshot.location).toBe('CA');

    const employeeChangePreview = await request('POST', '/employees/preview', {
      employeeId: employee.id,
      displayName: 'Integration A Employee',
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

    const employeeList = await request('GET', '/employees?search=Integration&location=CA&status=ACTIVE&limit=10');
    expect(employeeList.meta).toMatchObject({ total: 1, limit: 10, offset: 0 });
    expect(employeeList.facets.locations).toContain('CA');
    expect(employeeList.facets.employment_statuses).toContain('ACTIVE');
    expect(employeeList.data[0].policy_count).toBe(1);
    expect(employeeList.data[0]).toMatchObject({
      identity_label: 'Integration A Employee',
      display_label: 'Integration A Employee',
      context_label: 'Engineering · CA',
      record_label: 'Employee ID E-100',
      is_anonymized: false,
    });
    const firstLastNameSearch = await request('GET', '/employees?search=Integration%20Employee&facets=false&limit=10');
    expect(firstLastNameSearch.meta.total).toBe(1);
    expect(firstLastNameSearch.data[0].identity_label).toBe('Integration A Employee');
    const ruleList = await request(
      'GET',
      `/rules?search=enhanced&categoryId=${category.id}&dependency=FIELD%3Alocation&status=PUBLISHED&limit=1&offset=0`,
    );
    expect(ruleList.meta).toMatchObject({ total: 1, limit: 1, offset: 0 });
    expect(ruleList.data[0]).toMatchObject({ id: enhancedRule.id, key: 'enhanced-ca' });
    expect(ruleList.facets.dependencies).toContain('FIELD:location');
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
      employeesEvaluated: 1, employeesMatched: 0, affectedEmployees: 1, assignmentsAdded: 1, assignmentsRemoved: 1, assignmentsChanged: 1,
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
    expect(historical.meta).toEqual({ total: 1, limit: 100, offset: 0 });
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
    const audit = await request('GET', '/audit?limit=100');
    expect(audit.ruleChanges.some((change: { rule_key: string }) => change.rule_key === 'enhanced-ca')).toBe(true);
    expect(audit.assignmentChanges.some((change: { employee_id: string }) => change.employee_id === employee.id)).toBe(true);
    expect(audit.overrides.some((item: { employee_id: string }) => item.employee_id === employee.id)).toBe(true);
    expect(audit.technical.reconciliationJobs.length).toBeGreaterThan(0);
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

  it('keeps employee, rule, group, and manual-override previews equal to reconciled assignments', async () => {
    now = new Date('2026-08-10T12:00:00Z');
    const category = await request('POST', '/policy-categories', {
      key: 'preview-parity', name: 'Preview parity', cardinality: 'SINGLE',
    });
    const standard = await request('POST', '/policies', {
      key: 'preview-standard', categoryId: category.id, name: 'Preview standard', effectiveFrom: '2026-08-10',
    });
    const locationPolicy = await request('POST', '/policies', {
      key: 'preview-location', categoryId: category.id, name: 'Preview location', effectiveFrom: '2026-08-10',
    });
    const groupPolicy = await request('POST', '/policies', {
      key: 'preview-group', categoryId: category.id, name: 'Preview group', effectiveFrom: '2026-08-10',
    });
    const employee = await request('POST', '/employees', {
      externalId: 'E-PREVIEW-PARITY', displayName: 'Preview Parity Employee', location: 'A', effectiveFrom: '2026-08-10',
    });
    await request('POST', '/rules', {
      key: 'preview-default-rule', policyId: standard.id, priority: 1, validFrom: '2026-08-10', publish: true,
      condition: { type: 'comparison', fact: { kind: 'as_of_date' }, operator: 'GTE', value: '2000-01-01' },
    });
    const locationRule = await request('POST', '/rules', {
      key: 'preview-location-rule', policyId: locationPolicy.id, priority: 10, validFrom: '2026-08-10', publish: true,
      condition: { type: 'comparison', fact: { kind: 'employee', field: 'location' }, operator: 'EQ', value: 'B' },
    });
    const group = await request('POST', '/groups', { key: 'preview-parity-group', name: 'Preview parity group' });
    await request('POST', '/rules', {
      key: 'preview-group-rule', policyId: groupPolicy.id, priority: 20, validFrom: '2026-08-10', publish: true,
      condition: { type: 'group', groupId: group.id, operator: 'MEMBER_OF' },
    });
    await drainJobs();

    now = new Date('2026-08-11T12:00:00Z');
    const employeePreview = await request('POST', '/employees/preview', {
      employeeId: employee.id, location: 'B', groupIds: [], asOfDate: '2026-08-11',
    });
    await request('PATCH', `/employees/${employee.id}`, { location: 'B', groupIds: [], effectiveFrom: '2026-08-11' });
    await drainJobs();
    expect(await assignmentPolicyIds(employee.id, category.id)).toEqual(previewPolicyIds(employeePreview, category.id));

    now = new Date('2026-08-12T12:00:00Z');
    const rulePreview = await request('POST', '/rules/preview', {
      ruleId: locationRule.id,
      policyId: locationPolicy.id,
      priority: 10,
      enabled: true,
      validFrom: '2026-08-12',
      asOfDate: '2026-08-12',
      condition: { type: 'comparison', fact: { kind: 'employee', field: 'location' }, operator: 'EQ', value: 'C' },
    });
    const expectedRulePolicies = rulePreview.examples.find((example: { employeeId: string }) => example.employeeId === employee.id)?.afterPolicyIds;
    await request('POST', `/rules/${locationRule.id}/versions`, {
      policyId: locationPolicy.id,
      priority: 10,
      enabled: true,
      validFrom: '2026-08-12',
      publish: true,
      condition: { type: 'comparison', fact: { kind: 'employee', field: 'location' }, operator: 'EQ', value: 'C' },
    });
    await drainJobs();
    expect(await assignmentPolicyIds(employee.id, category.id)).toEqual(expectedRulePolicies);

    now = new Date('2026-08-13T12:00:00Z');
    const groupPreview = await request('POST', '/employees/preview', {
      employeeId: employee.id, groupIds: [group.id], asOfDate: '2026-08-13',
    });
    await request('PATCH', `/employees/${employee.id}`, { groupIds: [group.id], effectiveFrom: '2026-08-13' });
    await drainJobs();
    expect(await assignmentPolicyIds(employee.id, category.id)).toEqual(previewPolicyIds(groupPreview, category.id));

    now = new Date('2026-08-14T12:00:00Z');
    const overrideInput = {
      employeeId: employee.id,
      policyId: standard.id,
      action: 'ASSIGN',
      priority: -100,
      reason: 'Preview parity exception',
      validFrom: '2026-08-14',
    };
    const overridePreview = await request('POST', '/manual-overrides/preview', { ...overrideInput, asOfDate: '2026-08-14' });
    await request('POST', '/manual-overrides', overrideInput);
    await drainJobs();
    expect(await assignmentPolicyIds(employee.id, category.id)).toEqual(previewPolicyIds(overridePreview, category.id));

    now = new Date('2026-08-15T12:00:00Z');
    const newEmployeeInput = {
      externalId: 'E-PREVIEW-CREATE',
      displayName: 'Preview Create Employee',
      location: 'C',
      groupIds: [],
    };
    const createPreview = await request('POST', '/employees/preview', {
      ...newEmployeeInput,
      asOfDate: '2026-08-15',
    });
    const created = await request('POST', '/employees', { ...newEmployeeInput, effectiveFrom: '2026-08-15' });
    await drainJobs();
    expect(await assignmentPolicyIds(created.id, category.id)).toEqual(previewPolicyIds(createPreview, category.id));
  });

  it('gives product initialization and evaluation initialization the same semantic fingerprint', async () => {
    const tenantIds: string[] = [];
    const employeeIds = new Map<string, string[]>();
    try {
      for (const namespace of ['product-initialization', 'evaluation-initialization']) {
        const company = await pool.query<{ id: string }>(
          'INSERT INTO companies (name) VALUES ($1) RETURNING id', [`Certified baseline ${namespace} ${crypto.randomUUID()}`],
        );
        const tenantId = company.rows[0]!.id;
        tenantIds.push(tenantId);
        const createdEmployeeIds: string[] = [];
        const roleWords = ['Analyst', 'Attorney', 'Clerk', 'Coordinator', 'Engineer', 'Investigator', 'Nurse', 'Planner'];
        for (let index = 0; index < 240; index += 1) {
          const employee = await pool.query<{ id: string }>(
            'INSERT INTO employees (company_id, external_id) VALUES ($1, $2) RETURNING id',
            [tenantId, `BASELINE-${index}`],
          );
          createdEmployeeIds.push(employee.rows[0]!.id);
          const version = await pool.query<{ id: string }>(
            `INSERT INTO employee_versions
               (company_id, employee_id, version, valid_from, display_name, location, department,
                employment_type, is_manager, hire_date, attributes, changed_fields)
             VALUES ($1, $2, 1, '2026-06-30', $3, $4, $5, $6, false, $7::date, $8::jsonb, ARRAY['created'])
             RETURNING id`,
            [
              tenantId,
              employee.rows[0]!.id,
              `Record ${index}`,
              `Location ${index % 6}`,
              `Department ${index % 44}`,
              `Type ${index % 4}`,
              `202${index % 5}-01-01`,
              JSON.stringify({
                job_title: `${roleWords[index % roleWords.length]} Specialty ${index % 80}`,
                employment_status: `Status ${index % 5}`,
                pay_basis: `Type ${index % 4}`,
              }),
            ],
          );
          await pool.query('UPDATE employees SET current_version_id = $3 WHERE company_id = $1 AND id = $2', [
            tenantId, employee.rows[0]!.id, version.rows[0]!.id,
          ]);
        }
        employeeIds.set(namespace, createdEmployeeIds);
        await inTransaction(pool, (client) => createCertifiedBaseline(client, {
          companyId: tenantId,
          baselineDate: '2026-06-30',
          idNamespace: namespace,
          createdBy: 'semantic-parity-test',
          ruleCount: CERTIFIED_RULE_COUNT,
        }));
      }
      const [left, right] = await Promise.all(tenantIds.map((tenantId) => certifiedBaselineSemantics(pool, tenantId)));
      expect(left!.counts).toMatchObject({ categories: 6, rules: 300, groups: 8 });
      expect(left!.counts.policies).toBeGreaterThan(0);
      expect(right!.counts).toEqual(left!.counts);
      expect(right!.fingerprint).toBe(left!.fingerprint);
      expect(right!.content).toEqual(left!.content);

      const productTenantId = tenantIds[0]!;
      const employeeId = employeeIds.get('product-initialization')![0]!;
      const base = { employeeId, asOfDate: '2026-06-30' };
      assertCategoryReplacement(
        await previewForCompany(productTenantId, { ...base, location: 'Location 1' }),
        'workplace-requirements', 'Location 0 Workplace Requirements', 'Location 1 Workplace Requirements',
      );
      assertCategoryReplacement(
        await previewForCompany(productTenantId, { ...base, department: 'Department 1' }),
        'department-workflow-access', 'Department 0 Workflow Access', 'Department 1 Workflow Access',
      );
      assertCategoryReplacement(
        await previewForCompany(productTenantId, { ...base, employmentType: 'Type 1' }),
        'compensation-program', 'Type 0 Compensation Program', 'Type 1 Compensation Program',
      );
      assertCategoryReplacement(
        await previewForCompany(productTenantId, {
          ...base,
          attributes: { job_title: 'Attorney Specialty 1', employment_status: 'Status 0', pay_basis: 'Type 0' },
        }),
        'role-access-training', 'Analyst Role Access and Training', 'Attorney Role Access and Training',
      );
      assertCategoryReplacement(
        await previewForCompany(productTenantId, { ...base, hireDate: '2025-01-01' }),
        'tenure-benefits', 'Experienced Benefits — 5 to 10 years', 'Foundation Benefits — under 2 years',
      );

      const currentGroups = await pool.query<{ id: string }>(
        `SELECT gm.group_id AS id FROM group_memberships gm
          WHERE gm.company_id = $1 AND gm.employee_id = $2
            AND gm.valid_from <= '2026-06-30'::date
            AND (gm.valid_to IS NULL OR gm.valid_to > '2026-06-30'::date)`,
        [productTenantId, employeeId],
      );
      expect(currentGroups.rows).toHaveLength(1);
      const groupPreview = await previewForCompany(productTenantId, { ...base, groupIds: [] });
      const cross = groupPreview.categories.find((category: { key: string }) => category.key === 'cross-functional-requirements');
      expect(cross.before.filter((policy: { id: string }) => !cross.after.some((after: { id: string }) => after.id === policy.id)))
        .toHaveLength(1);
    } finally {
      if (tenantIds.length > 0) await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [tenantIds]);
    }
  }, 180_000);

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

  it('reserves evaluation-tenant jobs and temporal schedules for an explicitly scoped worker', async () => {
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
    const companies = await request('GET', '/companies', undefined, false);
    expect(companies.data.some((company: { id: string }) => company.id === evaluationCompany.id)).toBe(false);
    const scoped = new ReconciliationWorker(pool, workerConfig, clock, evaluationCompany.id);
    expect((await scoped.processNext())?.job.id).toBe(job.rows[0]!.id);

    now = new Date('2026-08-03T12:00:00Z');
    const category = await requestForCompany(evaluationCompany.id, 'POST', '/policy-categories', {
      key: 'evaluation-tenure', name: 'Evaluation tenure', cardinality: 'SINGLE',
    });
    const policy = await requestForCompany(evaluationCompany.id, 'POST', '/policies', {
      key: 'evaluation-tenure-earned', categoryId: category.id, name: 'Evaluation tenure earned', effectiveFrom: '2026-08-03',
    });
    const employee = await requestForCompany(evaluationCompany.id, 'POST', '/employees', {
      externalId: 'EVALUATION-TEMPORAL', displayName: 'Evaluation temporal employee',
      hireDate: '2024-08-04', effectiveFrom: '2026-08-03',
    });
    await requestForCompany(evaluationCompany.id, 'POST', '/rules', {
      key: 'evaluation-tenure-earned-rule', policyId: policy.id, priority: 10,
      validFrom: '2026-08-03', publish: true,
      condition: { type: 'comparison', fact: { kind: 'tenure_days' }, operator: 'GTE', value: 730 },
    });
    while (await scoped.processOne()) {
      // Materialize the evaluation scope and persist its future transition.
    }
    const scheduledBefore = await pool.query<{ id: string; processed_at: Date | null }>(
      `SELECT id, processed_at FROM scheduled_evaluations
        WHERE company_id = $1 AND employee_id = $2 AND transition_date = '2026-08-04'`,
      [evaluationCompany.id, employee.id],
    );
    expect(scheduledBefore.rows).toHaveLength(1);
    expect(scheduledBefore.rows[0]!.processed_at).toBeNull();

    now = new Date('2026-08-04T12:00:00Z');
    await unscoped.enqueueDueTemporalJobs();
    const afterUnscoped = await pool.query<{ processed_at: Date | null }>(
      'SELECT processed_at FROM scheduled_evaluations WHERE id = $1',
      [scheduledBefore.rows[0]!.id],
    );
    expect(afterUnscoped.rows[0]!.processed_at).toBeNull();
    expect(await scoped.enqueueDueTemporalJobs()).toBe(1);
    const afterScoped = await pool.query<{ processed_at: Date | null }>(
      'SELECT processed_at FROM scheduled_evaluations WHERE id = $1',
      [scheduledBefore.rows[0]!.id],
    );
    expect(afterScoped.rows[0]!.processed_at).not.toBeNull();
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

function previewPolicyIds(preview: any, categoryId: string): string[] {
  return (preview.categories.find((category: { id: string }) => category.id === categoryId)?.after ?? [])
    .map((policy: { id: string }) => policy.id)
    .sort();
}

async function previewForCompany(tenantId: string, body: object): Promise<any> {
  const response = await app.inject({
    method: 'POST',
    url: '/employees/preview',
    headers: { 'x-company-id': tenantId },
    payload: body,
  });
  if (response.statusCode >= 400) throw new Error(`POST /employees/preview: ${response.statusCode} ${response.body}`);
  return response.json();
}

async function requestForCompany(
  tenantId: string,
  method: NonNullable<InjectOptions['method']>,
  url: string,
  body?: object,
): Promise<any> {
  const options: InjectOptions = { method, url, headers: { 'x-company-id': tenantId } };
  if (body !== undefined) options.payload = body;
  const response = await app.inject(options);
  if (response.statusCode >= 400) throw new Error(`${method} ${url}: ${response.statusCode} ${response.body}`);
  return response.statusCode === 204 ? null : response.json();
}

function assertCategoryReplacement(preview: any, categoryKey: string, removedName: string, addedName: string): void {
  const category = preview.categories.find((item: { key: string }) => item.key === categoryKey);
  const beforeIds = new Set(category.before.map((policy: { id: string }) => policy.id));
  const afterIds = new Set(category.after.map((policy: { id: string }) => policy.id));
  expect(category.before.filter((policy: { id: string }) => !afterIds.has(policy.id)).map((policy: { name: string }) => policy.name))
    .toContain(removedName);
  expect(category.after.filter((policy: { id: string }) => !beforeIds.has(policy.id)).map((policy: { name: string }) => policy.name))
    .toContain(addedName);
}

async function assignmentPolicyIds(employeeId: string, categoryId: string): Promise<string[]> {
  const assignments = await request('GET', `/employees/${employeeId}/assignments`);
  return assignments.data
    .filter((assignment: { category_id: string }) => assignment.category_id === categoryId)
    .map((assignment: { policy_id: string }) => assignment.policy_id)
    .sort();
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
