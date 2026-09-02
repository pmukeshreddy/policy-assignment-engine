import type { FastifyInstance } from 'fastify';
import type { InjectOptions } from 'light-my-request';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import { createPool, type DbPool } from '../../src/db.js';
import { compareRegressionCheckpoint } from '../../src/eval/regression.js';
import { FAN_OUT_PARTITION_SIZE } from '../../src/services/jobs.js';
import { ReconciliationWorker, type JobProcessingReport } from '../../src/services/worker.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
  ?? 'postgres://policy:policy@localhost:5432/policy_engine';
const clock = (): Date => new Date('2026-09-01T12:00:00Z');
const workerConfig = {
  WORKER_POLL_MS: 50,
  WORKER_CONCURRENCY: 1,
  JOB_MAX_ATTEMPTS: 3,
  JOB_LEASE_SECONDS: 30,
} as const;

let pool: DbPool;
let app: FastifyInstance;
let companyId: string;
let policyId: string;
let employeeIds: string[];
let parentJobId: string;
let childJobIds: string[];
let completedReports: JobProcessingReport[];

describe('durable broad-rule fan-out', () => {
  beforeAll(async () => {
    pool = createPool({ DATABASE_URL: databaseUrl });
    app = buildApp({ pool, config: { LOG_LEVEL: 'silent', PREVIEW_MAX_EMPLOYEES: 5_000 }, clock });
    await app.ready();
    const company = await request('POST', '/companies', { name: `Fan-out ${crypto.randomUUID()}` }, false);
    companyId = company.id;
    await pool.query(
      `INSERT INTO evaluation_tenants (key, company_id, dataset_id)
       VALUES ($1, $2, 'fanout-integration')`,
      [`fanout-integration-${crypto.randomUUID()}`, companyId],
    );
    const category = await request('POST', '/policy-categories', {
      key: 'fanout-access', name: 'Fan-out access', cardinality: 'MULTIPLE',
    });
    const policy = await request('POST', '/policies', {
      key: 'fanout-policy', categoryId: category.id, name: 'Fan-out policy', effectiveFrom: '2026-09-01',
    });
    policyId = policy.id;
    await pool.query(
      `WITH inserted_employees AS (
         INSERT INTO employees (company_id, external_id)
         SELECT $1, 'FANOUT-' || number::text
           FROM generate_series(1, 1201) AS number
         RETURNING id, external_id
       ), inserted_versions AS (
         INSERT INTO employee_versions
           (company_id, employee_id, version, valid_from, display_name, location, department,
            employment_type, hire_date, attributes, changed_fields)
         SELECT $1, employee.id, 1, '2026-09-01', employee.external_id, 'Test', 'Test',
                'Test', '2020-01-01', '{"job_title":"Test"}'::jsonb, ARRAY['created']
           FROM inserted_employees employee
         RETURNING id, employee_id
       )
       SELECT count(*) FROM inserted_versions`,
      [companyId],
    );
    await pool.query(
      `UPDATE employees employee
          SET current_version_id = version.id
         FROM employee_versions version
        WHERE employee.company_id = $1
          AND version.company_id = employee.company_id
          AND version.employee_id = employee.id`,
      [companyId],
    );
    const inserted = await pool.query<{ id: string }>(
      'SELECT id FROM employees WHERE company_id = $1 ORDER BY id',
      [companyId],
    );
    employeeIds = inserted.rows.map((row) => row.id);
  });

  afterAll(async () => {
    if (companyId !== undefined) await pool.query('DELETE FROM companies WHERE id = $1', [companyId]);
    await app.close();
    await pool.end();
  });

  it('creates bounded durable partitions covering every affected scope exactly once', async () => {
    const rule = await request('POST', '/rules', {
      key: 'fanout-broad-rule', policyId, priority: 10, enabled: true,
      validFrom: '2026-09-01', publish: true,
      condition: { type: 'comparison', fact: { kind: 'as_of_date' }, operator: 'GTE', value: '2000-01-01' },
    });
    const parent = await pool.query<{ id: string }>(
      `SELECT id FROM reconciliation_jobs
        WHERE company_id = $1 AND scope = 'RULE' AND payload ->> 'ruleVersionId' = $2`,
      [companyId, rule.versionId],
    );
    parentJobId = parent.rows[0]!.id;
    const parentReport = await makeWorker().processNext();
    expect(parentReport?.job.id).toBe(parentJobId);
    expect(parentReport?.profile.fanOutPartitionsCreated).toBe(3);
    expect(parentReport?.results).toEqual([]);

    const children = await pool.query<{
      id: string; partition_index: number; partition_count: number; scope_count: number;
      payload: { scopes: Array<{ employeeId: string; categoryId: string }> };
    }>(
      `SELECT id, partition_index, partition_count, scope_count, payload
         FROM reconciliation_jobs
        WHERE company_id = $1 AND parent_job_id = $2
        ORDER BY partition_index`,
      [companyId, parentJobId],
    );
    childJobIds = children.rows.map((row) => row.id);
    expect(children.rows.map((row) => row.scope_count)).toEqual([500, 500, 201]);
    expect(children.rows.every((row) => row.partition_count === 3 && row.scope_count <= FAN_OUT_PARTITION_SIZE)).toBe(true);
    const scopeKeys = children.rows.flatMap((row) => row.payload.scopes)
      .map((scope) => `${scope.employeeId}:${scope.categoryId}`);
    expect(scopeKeys).toHaveLength(employeeIds.length);
    expect(new Set(scopeKeys).size).toBe(employeeIds.length);
    const state = await jobStatus(parentJobId);
    expect(state).toBe('WAITING');
  });

  it('allows multiple workers to claim different children and completes only after all children succeed', async () => {
    const workers = [makeWorker(), makeWorker()];
    const firstWave = await Promise.all(workers.map((worker) => worker.processNext()));
    const claimed = firstWave.filter((report): report is JobProcessingReport => report !== null);
    expect(claimed).toHaveLength(2);
    expect(new Set(claimed.map((report) => report.job.id)).size).toBe(2);
    expect(new Set(claimed.map((report) => report.profile.workerId)).size).toBe(2);
    expect(claimed.every((report) => report.job.scope === 'FANOUT' && report.error === null)).toBe(true);
    expect(await jobStatus(parentJobId)).toBe('WAITING');

    const finalReport = await makeWorker().processNext();
    expect(finalReport?.job.scope).toBe('FANOUT');
    expect(finalReport?.error).toBeNull();
    completedReports = [...claimed, finalReport!];
    expect(await jobStatus(parentJobId)).toBe('SUCCEEDED');
    expect(completedReports.flatMap((report) => report.results)).toHaveLength(employeeIds.length);

    const comparison = await compareRegressionCheckpoint(pool, {
      companyId, employeeIds, asOfDate: '2026-09-01',
    });
    expect(comparison.mismatches).toEqual([]);
    expect(comparison.deterministicFailures).toBe(0);
    const counts = await assignmentCounts();
    expect(counts).toEqual({ assignments: 1201, decisions: 1201, history: 1201, duplicates: 0 });
  }, 120_000);

  it('retries one completed child idempotently without duplicating active or historical assignments', async () => {
    const before = await assignmentCounts();
    await pool.query(
      `UPDATE reconciliation_jobs
          SET status = 'PENDING', attempts = 0, available_at = now(), locked_at = NULL,
              locked_by = NULL, finished_at = NULL, last_error = NULL
        WHERE company_id = $1 AND id = $2`,
      [companyId, childJobIds[0]],
    );
    const retry = await makeWorker().processNext();
    expect(retry?.job.id).toBe(childJobIds[0]);
    expect(retry?.error).toBeNull();
    expect(retry?.results.every((result) => (
      result.addedPolicyIds.length === 0 && result.removedPolicyIds.length === 0
    ))).toBe(true);
    expect(await assignmentCounts()).toEqual(before);
    expect(await jobStatus(parentJobId)).toBe('SUCCEEDED');
  }, 60_000);

  it('marks the parent failed when a child exhausts retries', async () => {
    const secondPolicy = await request('POST', '/policies', {
      key: 'fanout-failure-policy', categoryId: await categoryId(),
      name: 'Fan-out failure policy', effectiveFrom: '2026-09-01',
    });
    await request('POST', '/rules', {
      key: 'fanout-failure-rule', policyId: secondPolicy.id, priority: 20, enabled: true,
      validFrom: '2026-09-01', publish: true,
      condition: { type: 'comparison', fact: { kind: 'as_of_date' }, operator: 'GTE', value: '2000-01-01' },
    });
    const parentReport = await makeWorker().processNext();
    expect(parentReport?.job.scope).toBe('RULE');
    const failedParentId = parentReport!.job.id;
    const firstChild = await pool.query<{ id: string }>(
      `SELECT id FROM reconciliation_jobs
        WHERE company_id = $1 AND parent_job_id = $2
        ORDER BY partition_index LIMIT 1`,
      [companyId, failedParentId],
    );
    await pool.query(
      `UPDATE reconciliation_jobs
          SET attempts = 2, priority = 100, payload = jsonb_set(payload, '{scopes}', '[]'::jsonb)
        WHERE company_id = $1 AND id = $2`,
      [companyId, firstChild.rows[0]!.id],
    );
    const failedChild = await makeWorker().processNext();
    expect(failedChild?.job.id).toBe(firstChild.rows[0]!.id);
    expect(failedChild?.error).toMatch(/Too small|too_small|at least 1|Zod/i);
    expect(await jobStatus(firstChild.rows[0]!.id)).toBe('DEAD');
    expect(await jobStatus(failedParentId)).toBe('DEAD');
  }, 60_000);
});

function makeWorker(): ReconciliationWorker {
  return new ReconciliationWorker(pool, workerConfig, clock, companyId);
}

async function jobStatus(jobId: string): Promise<string> {
  const result = await pool.query<{ status: string }>(
    'SELECT status FROM reconciliation_jobs WHERE company_id = $1 AND id = $2',
    [companyId, jobId],
  );
  return result.rows[0]!.status;
}

async function categoryId(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `SELECT category_id AS id FROM policies WHERE company_id = $1 AND id = $2`,
    [companyId, policyId],
  );
  return result.rows[0]!.id;
}

async function assignmentCounts(): Promise<{
  assignments: number; decisions: number; history: number; duplicates: number;
}> {
  const result = await pool.query<{
    assignments: number; decisions: number; history: number; duplicates: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM materialized_assignments WHERE company_id = $1) AS assignments,
       (SELECT count(*)::int FROM assignment_decisions WHERE company_id = $1) AS decisions,
       (SELECT count(*)::int FROM assignment_history WHERE company_id = $1) AS history,
       (SELECT count(*)::int FROM (
          SELECT employee_id, policy_id FROM materialized_assignments
           WHERE company_id = $1 GROUP BY employee_id, policy_id HAVING count(*) > 1
        ) duplicate_rows) AS duplicates`,
    [companyId],
  );
  return result.rows[0]!;
}

async function request(
  method: NonNullable<InjectOptions['method']>,
  url: string,
  body?: object,
  tenant = true,
): Promise<any> {
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
