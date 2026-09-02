import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/api/app.js';
import { createCertifiedBaseline, CERTIFIED_RULE_COUNT } from '../src/baseline/certified-universe.js';
import { loadConfig } from '../src/config.js';
import { createPool, inTransaction, type DbClient, type DbPool } from '../src/db.js';
import { compareRegressionCheckpoint } from '../src/eval/regression.js';
import { NYC_DATASET_ID, NYC_EVALUATION_TENANT_KEY, NYC_IMPORT_COUNT } from '../src/eval/nyc.js';
import { enqueueJob } from '../src/services/jobs.js';
import { emptyReconciliationProfile } from '../src/services/reconciliation.js';
import { ReconciliationWorker, type JobExecutionProfile, type JobProcessingReport } from '../src/services/worker.js';

type LocalMutationType = 'location' | 'department' | 'employmentType' | 'jobTitle' | 'groupMembership' | 'manualOverride';

const localTypes: readonly LocalMutationType[] = [
  'location', 'department', 'employmentType', 'jobTitle', 'groupMembership', 'manualOverride',
];

interface SourceImport {
  companyId: string;
  importId: string;
  checksum: string;
  fiscalYear: string;
  importedRows: number;
}

interface BenchmarkTenant {
  companyId: string;
  baselineDate: string;
  initialJobId: string;
  policyCount: number;
}

interface EmployeeRow {
  id: string;
  location: string;
  department: string;
  employment_type: string;
  attributes: Record<string, unknown>;
}

interface LocalMeasurement {
  mutationType: LocalMutationType;
  employeeId: string;
  apiCommitMs: number;
  queueWaitMs: number;
  commitToVisibleMs: number;
  requestToVisibleMs: number;
  impactAnalysisMs: number;
  ruleFactLoadingMs: number;
  evaluationResolutionMs: number;
  reconciliationTransactionMs: number;
  assignmentWriteMs: number;
  jobCompletionWriteMs: number;
  rulesEvaluated: number;
  assignmentsAdded: number;
  assignmentsRemoved: number;
}

interface Distribution {
  samples: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

interface BroadMeasurement {
  ruleId: string;
  apiCommitMs: number;
  queueWaitMs: number;
  commitToVisibleMs: number;
  affectedEmployees: number;
  affectedScopes: number;
  scopesPerSecond: number;
  configuredWorkers: number;
  workersThatProcessedJobs: number;
  fanOutWorkUnits: number;
  jobCount: number;
  stageMs: {
    impactAnalysis: number;
    impactDatabase: number;
    affectedEmployeeAssembly: number;
    ruleFactLoading: number;
    employeeSnapshotLoading: number;
    categoryRuleLoading: number;
    overrideLoading: number;
    transactionTotal: number;
    transactionCommitAndOverhead: number;
    advisoryLock: number;
    evaluationResolution: number;
    decisionWrites: number;
    assignmentReads: number;
    diffPlanning: number;
    assignmentHistoryWrites: number;
    materializedAssignmentWrites: number;
    scheduledTransitionWrites: number;
    jobCompletionWrite: number;
    unaccountedTopLevel: number;
  };
  stagePercentOfCommitToVisible: Record<string, number>;
  counts: JobExecutionProfile['reconciliation']['counts'];
  assignmentInserts: number;
  assignmentRemovals: number;
  historyRowsWritten: number;
  decisionRowsWritten: number;
  actualRuleEvaluations: number;
}

const config = loadConfig();
const samplesPerType = integerArgument('--samples-per-type', 100);
if (samplesPerType < 50) throw new Error('Use at least 50 isolated samples per mutation type');
const label = stringArgument('--label', 'measurement');
const keepTenant = process.argv.includes('--keep-tenant');
const pool = createPool(config);
const source = await loadSourceImport(pool);
const tenant = await createBenchmarkTenant(pool, source, label);
let currentDate = tenant.baselineDate;
const clock = (): Date => new Date(`${currentDate}T12:00:00.000Z`);
const app = buildApp({
  pool,
  config: { LOG_LEVEL: 'silent', PREVIEW_MAX_EMPLOYEES: 100_000 },
  clock,
});
await app.ready();

const workerConfig = {
  WORKER_POLL_MS: 50,
  WORKER_CONCURRENCY: 1,
  JOB_MAX_ATTEMPTS: 3,
  JOB_LEASE_SECONDS: 300,
} as const;

try {
  process.stdout.write(`Benchmark tenant ${tenant.companyId}: materializing the 50,000-employee baseline...\n`);
  const baselineWorker = new ReconciliationWorker(pool, workerConfig, clock, tenant.companyId);
  const baselineReport = await baselineWorker.processNext();
  if (baselineReport === null || baselineReport.job.id !== tenant.initialJobId || baselineReport.error !== null) {
    throw new Error(`Benchmark baseline failed: ${baselineReport?.error ?? 'initial FULL job was not claimed'}`);
  }
  await assertNoActiveJobs(pool, tenant.companyId);
  const baselineOracle = await compareRegressionCheckpoint(pool, {
    companyId: tenant.companyId,
    employeeIds: await allEmployeeIds(pool, tenant.companyId),
    asOfDate: tenant.baselineDate,
  });
  if (baselineOracle.mismatches.length > 0 || baselineOracle.deterministicFailures > 0) {
    throw new Error('Disposable benchmark baseline does not match the independent oracle');
  }

  currentDate = addDays(tenant.baselineDate, 1);
  process.stdout.write(`Running ${samplesPerType * 6} isolated production-path mutations...\n`);
  const local = await runLocalBenchmark({ pool, app, companyId: tenant.companyId, asOfDate: currentDate, samplesPerType, clock });
  const localEmployeeIds = [...new Set(local.measurements.map((measurement) => measurement.employeeId))];
  const localOracle = await compareRegressionCheckpoint(pool, {
    companyId: tenant.companyId,
    employeeIds: localEmployeeIds,
    asOfDate: currentDate,
  });
  if (localOracle.mismatches.length > 0 || localOracle.deterministicFailures > 0) {
    throw new Error('Isolated production benchmark differs from the independent oracle');
  }

  process.stdout.write('Running one 50,000-employee rule fan-out through 16 configured workers...\n');
  const broad = await runBroadBenchmark({ pool, app, companyId: tenant.companyId, asOfDate: currentDate, clock });
  const broadOracle = await compareRegressionCheckpoint(pool, {
    companyId: tenant.companyId,
    employeeIds: await allEmployeeIds(pool, tenant.companyId),
    asOfDate: currentDate,
  });
  const invariants = await loadInvariants(pool, tenant.companyId);
  if (broadOracle.mismatches.length > 0 || broadOracle.deterministicFailures > 0 || Object.values(invariants).some((value) => value !== 0)) {
    throw new Error(`Broad benchmark correctness failed: ${JSON.stringify({ broadOracle, invariants })}`);
  }

  const artifact = {
    label,
    measuredAt: new Date().toISOString(),
    sourceCertificationCommit: 'e6fa29b022077b3f0b1818755668b7a60f62cb27',
    dataset: { id: NYC_DATASET_ID, checksum: source.checksum, employees: source.importedRows },
    universe: { rules: CERTIFIED_RULE_COUNT, policies: tenant.policyCount },
    benchmarkTenantId: tenant.companyId,
    tenantDisposedAfterRun: !keepTenant,
    local: {
      samplesPerType,
      totalSamples: local.measurements.length,
      overall: summarizeMeasurements(local.measurements),
      byMutationType: Object.fromEntries(
        localTypes.map((type) => [type, summarizeMeasurements(local.measurements.filter((item) => item.mutationType === type))]),
      ),
      raw: local.measurements,
      oracle: { mismatches: localOracle.mismatches.length, determinismFailures: localOracle.deterministicFailures },
    },
    broad,
    correctness: {
      baselineOracleMismatches: baselineOracle.mismatches.length,
      localOracleMismatches: localOracle.mismatches.length,
      broadOracleMismatches: broadOracle.mismatches.length,
      determinismFailures: baselineOracle.deterministicFailures + localOracle.deterministicFailures + broadOracle.deterministicFailures,
      invariants,
    },
  };
  const directory = resolve('artifacts/performance');
  await mkdir(directory, { recursive: true });
  const jsonPath = resolve(directory, `${label}.json`);
  const markdownPath = resolve(directory, `${label}.md`);
  await writeFile(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, formatMarkdown(artifact), 'utf8');
  process.stdout.write(`${formatMarkdown(artifact)}\nJSON: ${jsonPath}\nMarkdown: ${markdownPath}\n`);
} finally {
  await app.close();
  if (!keepTenant) await pool.query('DELETE FROM companies WHERE id = $1', [tenant.companyId]);
  await pool.end();
}

async function loadSourceImport(db: DbPool): Promise<SourceImport> {
  const result = await db.query<{
    company_id: string; import_id: string; checksum: string; fiscal_year: string; imported_rows: number;
  }>(
    `SELECT evaluation.company_id, imported.id AS import_id, imported.checksum,
            imported.metadata ->> 'fiscalYear' AS fiscal_year, imported.imported_rows
       FROM evaluation_tenants evaluation
       JOIN LATERAL (
         SELECT id, checksum, metadata, imported_rows
           FROM dataset_imports
          WHERE company_id = evaluation.company_id AND dataset_id = $2
          ORDER BY completed_at DESC, id DESC LIMIT 1
       ) imported ON true
      WHERE evaluation.key = $1`,
    [NYC_EVALUATION_TENANT_KEY, NYC_DATASET_ID],
  );
  const row = result.rows[0];
  if (row === undefined || row.imported_rows !== NYC_IMPORT_COUNT || !/^\d{4}$/.test(row.fiscal_year)) {
    throw new Error('The immutable 50,000-row NYC source import is unavailable');
  }
  return {
    companyId: row.company_id,
    importId: row.import_id,
    checksum: row.checksum,
    fiscalYear: row.fiscal_year,
    importedRows: row.imported_rows,
  };
}

async function createBenchmarkTenant(db: DbPool, source: SourceImport, labelValue: string): Promise<BenchmarkTenant> {
  return inTransaction(db, async (client) => {
    const company = await client.query<{ id: string }>(
      'INSERT INTO companies (name) VALUES ($1) RETURNING id',
      [`Production performance benchmark — ${labelValue} — ${randomUUID()}`],
    );
    const companyId = company.rows[0]!.id;
    await client.query(
      `INSERT INTO evaluation_tenants (key, company_id, dataset_id)
       VALUES ($1, $2, $3)`,
      [`performance-benchmark-${randomUUID()}`, companyId, NYC_DATASET_ID],
    );
    const imported = await client.query<{ id: string }>(
      `INSERT INTO dataset_imports
         (company_id, dataset_id, source_url, source_query, fetched_at, completed_at,
          requested_rows, fetched_rows, imported_rows, skipped_rows, checksum, skipped_reasons, metadata)
       SELECT $1, dataset_id, source_url, source_query, fetched_at, now(), requested_rows,
              fetched_rows, imported_rows, skipped_rows, checksum, skipped_reasons,
              metadata || jsonb_build_object('purpose', 'disposable-production-performance-benchmark')
         FROM dataset_imports
        WHERE company_id = $2 AND id = $3
       RETURNING id`,
      [companyId, source.companyId, source.importId],
    );
    const importId = imported.rows[0]!.id;
    const baselineDate = `${source.fiscalYear}-06-30`;
    await copyImportedEmployees(client, companyId, importId, source, baselineDate);
    const baseline = await createCertifiedBaseline(client, {
      companyId,
      baselineDate,
      idNamespace: `performance-benchmark:${companyId}`,
      createdBy: 'production-performance-benchmark',
      ruleCount: CERTIFIED_RULE_COUNT,
    });
    const initialJobId = await enqueueJob(client, {
      companyId,
      eventType: 'PERFORMANCE_BENCHMARK_BASELINE',
      scope: 'FULL',
      payload: { sourceImportId: source.importId, checksum: source.checksum, ruleCount: CERTIFIED_RULE_COUNT },
      dedupeKey: `performance-baseline:${source.checksum}`,
      priority: 100,
    });
    return { companyId, baselineDate, initialJobId, policyCount: baseline.policyCount };
  });
}

async function copyImportedEmployees(
  client: DbClient,
  companyId: string,
  importId: string,
  source: SourceImport,
  baselineDate: string,
): Promise<void> {
  await client.query(
    `INSERT INTO employees (company_id, external_id)
     SELECT $1, records.normalized_facts ->> 'externalId'
       FROM employee_import_records records
      WHERE records.company_id = $2 AND records.import_id = $3
      ORDER BY records.source_row_id`,
    [companyId, source.companyId, source.importId],
  );
  await client.query(
    `INSERT INTO employee_versions
       (company_id, employee_id, version, valid_from, display_name, first_name, last_name,
        middle_initial, location, department, employment_type, is_manager, hire_date,
        attributes, changed_fields, created_by)
     SELECT $1, employee.id, 1, $4::date,
            records.normalized_facts ->> 'displayName', records.normalized_facts ->> 'firstName',
            records.normalized_facts ->> 'lastName', records.normalized_facts ->> 'middleInitial',
            records.normalized_facts ->> 'location', records.normalized_facts ->> 'department',
            records.normalized_facts ->> 'employmentType', false,
            (records.normalized_facts ->> 'hireDate')::date, records.normalized_facts -> 'attributes',
            ARRAY['created', 'dataset_import'], 'production-performance-benchmark'
       FROM employee_import_records records
       JOIN employees employee
         ON employee.company_id = $1 AND employee.external_id = records.normalized_facts ->> 'externalId'
      WHERE records.company_id = $2 AND records.import_id = $3
      ORDER BY employee.id`,
    [companyId, source.companyId, source.importId, baselineDate],
  );
  await client.query(
    `UPDATE employees employee SET current_version_id = version.id, updated_at = now()
       FROM employee_versions version
      WHERE employee.company_id = $1 AND version.company_id = employee.company_id
        AND version.employee_id = employee.id AND version.version = 1`,
    [companyId],
  );
  await client.query(
    `INSERT INTO employee_import_records
       (company_id, employee_id, import_id, dataset_id, source_row_id, source_record_checksum, normalized_facts)
     SELECT $1, employee.id, $2, records.dataset_id, records.source_row_id,
            records.source_record_checksum, records.normalized_facts
       FROM employee_import_records records
       JOIN employees employee
         ON employee.company_id = $1 AND employee.external_id = records.normalized_facts ->> 'externalId'
      WHERE records.company_id = $3 AND records.import_id = $4
      ORDER BY employee.id`,
    [companyId, importId, source.companyId, source.importId],
  );
}

async function runLocalBenchmark(input: {
  pool: DbPool;
  app: FastifyInstance;
  companyId: string;
  asOfDate: string;
  samplesPerType: number;
  clock: () => Date;
}): Promise<{ measurements: LocalMeasurement[] }> {
  const employees = await input.pool.query<EmployeeRow>(
    `SELECT e.id, ev.location, ev.department, ev.employment_type, ev.attributes
       FROM employees e
       JOIN employee_versions ev ON ev.company_id = e.company_id AND ev.id = e.current_version_id
      WHERE e.company_id = $1
      ORDER BY e.external_id`,
    [input.companyId],
  );
  const values = await input.pool.query<{
    locations: string[]; departments: string[]; employment_types: string[]; job_titles: string[];
  }>(
    `SELECT array_agg(DISTINCT location ORDER BY location) AS locations,
            array_agg(DISTINCT department ORDER BY department) AS departments,
            array_agg(DISTINCT employment_type ORDER BY employment_type) AS employment_types,
            array_agg(DISTINCT attributes ->> 'job_title' ORDER BY attributes ->> 'job_title') AS job_titles
       FROM employee_versions
      WHERE company_id = $1 AND id IN (SELECT current_version_id FROM employees WHERE company_id = $1)`,
    [input.companyId],
  );
  const observed = values.rows[0]!;
  const group = await input.pool.query<{ id: string }>(
    'SELECT id FROM groups WHERE company_id = $1 ORDER BY slug LIMIT 1',
    [input.companyId],
  );
  const groupId = group.rows[0]!.id;
  const policy = await input.pool.query<{ id: string }>(
    `SELECT p.id FROM policies p JOIN policy_categories pc ON pc.id=p.category_id AND pc.company_id=p.company_id
      WHERE p.company_id=$1 AND pc.cardinality='SINGLE' ORDER BY p.key LIMIT 1`,
    [input.companyId],
  );
  const policyId = policy.rows[0]!.id;
  const nonMembers = await input.pool.query<{ id: string }>(
    `SELECT e.id FROM employees e
      WHERE e.company_id=$1 AND NOT EXISTS (
        SELECT 1 FROM group_memberships gm WHERE gm.company_id=e.company_id AND gm.employee_id=e.id
          AND gm.group_id=$2 AND gm.valid_from <= $3::date AND (gm.valid_to IS NULL OR gm.valid_to > $3::date)
      ) ORDER BY e.external_id LIMIT $4`,
    [input.companyId, groupId, input.asOfDate, input.samplesPerType],
  );
  if (nonMembers.rows.length !== input.samplesPerType) throw new Error('Not enough nonmembers for the isolated group sample');
  const worker = new ReconciliationWorker(input.pool, workerConfig, input.clock, input.companyId);
  const measurements: LocalMeasurement[] = [];
  let employeeOffset = 0;
  for (const mutationType of localTypes) {
    for (let ordinal = 0; ordinal < input.samplesPerType; ordinal += 1) {
      const employee = mutationType === 'groupMembership'
        ? employees.rows.find((row) => row.id === nonMembers.rows[ordinal]!.id)!
        : employees.rows[employeeOffset++]!;
      const invocation = mutationInvocation({
        mutationType,
        employee,
        ordinal,
        asOfDate: input.asOfDate,
        groupId,
        policyId,
        observed,
      });
      const requestStarted = performance.now();
      await apiRequest(input.app, input.companyId, invocation.method, invocation.url, invocation.body);
      const committedAtPerformance = performance.now();
      const committedAtEpoch = Date.now();
      const apiCommitMs = committedAtPerformance - requestStarted;
      const report = await worker.processNext();
      if (report === null || report.error !== null) throw new Error(`Isolated ${mutationType} job failed: ${report?.error ?? 'not claimed'}`);
      await input.pool.query(
        'SELECT count(*) FROM materialized_assignments WHERE company_id=$1 AND employee_id=$2',
        [input.companyId, employee.id],
      );
      const visibleAt = performance.now();
      const timestamps = await input.pool.query<{ started_at: Date }>(
        'SELECT started_at FROM reconciliation_jobs WHERE company_id=$1 AND id=$2',
        [input.companyId, report.job.id],
      );
      const profile = report.profile;
      measurements.push({
        mutationType,
        employeeId: employee.id,
        apiCommitMs: round(apiCommitMs),
        queueWaitMs: round(Math.max(0, timestamps.rows[0]!.started_at.getTime() - committedAtEpoch)),
        commitToVisibleMs: round(visibleAt - committedAtPerformance),
        requestToVisibleMs: round(visibleAt - requestStarted),
        impactAnalysisMs: round(profile.impactAnalysisMs),
        ruleFactLoadingMs: round(profile.reconciliation.stageMs.ruleFactLoading),
        evaluationResolutionMs: round(profile.reconciliation.stageMs.evaluationResolution),
        reconciliationTransactionMs: round(profile.reconciliation.stageMs.transactionTotal),
        assignmentWriteMs: round(
          profile.reconciliation.stageMs.assignmentHistoryWrites
          + profile.reconciliation.stageMs.materializedAssignmentWrites,
        ),
        jobCompletionWriteMs: round(profile.jobCompletionWriteMs),
        rulesEvaluated: profile.reconciliation.counts.ruleEvaluations,
        assignmentsAdded: profile.reconciliation.counts.assignmentInserts,
        assignmentsRemoved: profile.reconciliation.counts.assignmentRemovals,
      });
    }
    process.stdout.write(`Isolated ${mutationType}: ${input.samplesPerType} / ${input.samplesPerType}\n`);
  }
  await assertNoActiveJobs(input.pool, input.companyId);
  return { measurements };
}

function mutationInvocation(input: {
  mutationType: LocalMutationType;
  employee: EmployeeRow;
  ordinal: number;
  asOfDate: string;
  groupId: string;
  policyId: string;
  observed: { locations: string[]; departments: string[]; employment_types: string[]; job_titles: string[] };
}): { method: 'PATCH' | 'POST'; url: string; body: Record<string, unknown> } {
  const base = { effectiveFrom: input.asOfDate };
  if (input.mutationType === 'location') {
    return { method: 'PATCH', url: `/employees/${input.employee.id}`, body: { ...base, location: nextDifferent(input.observed.locations, input.employee.location, input.ordinal) } };
  }
  if (input.mutationType === 'department') {
    return { method: 'PATCH', url: `/employees/${input.employee.id}`, body: { ...base, department: nextDifferent(input.observed.departments, input.employee.department, input.ordinal) } };
  }
  if (input.mutationType === 'employmentType') {
    return { method: 'PATCH', url: `/employees/${input.employee.id}`, body: { ...base, employmentType: nextDifferent(input.observed.employment_types, input.employee.employment_type, input.ordinal) } };
  }
  if (input.mutationType === 'jobTitle') {
    const current = String(input.employee.attributes['job_title']);
    return {
      method: 'PATCH',
      url: `/employees/${input.employee.id}`,
      body: { ...base, attributes: { ...input.employee.attributes, job_title: nextDifferent(input.observed.job_titles, current, input.ordinal) } },
    };
  }
  if (input.mutationType === 'groupMembership') {
    return { method: 'POST', url: `/groups/${input.groupId}/members`, body: { employeeId: input.employee.id, effectiveFrom: input.asOfDate } };
  }
  return {
    method: 'POST',
    url: '/manual-overrides',
    body: {
      employeeId: input.employee.id,
      policyId: input.policyId,
      action: 'ASSIGN',
      priority: 10_000,
      reason: `Production latency benchmark ${input.ordinal}`,
      validFrom: input.asOfDate,
    },
  };
}

async function runBroadBenchmark(input: {
  pool: DbPool;
  app: FastifyInstance;
  companyId: string;
  asOfDate: string;
  clock: () => Date;
}): Promise<BroadMeasurement> {
  const rule = await input.pool.query<{
    id: string; policy_id: string; priority: number; enabled: boolean;
  }>(
    `SELECT r.id,rv.policy_id,rv.priority,rv.enabled
       FROM rules r
       JOIN rule_versions rv ON rv.company_id=r.company_id AND rv.id=r.current_version_id
       JOIN policies p ON p.company_id=rv.company_id AND p.id=rv.policy_id
       JOIN policy_categories pc ON pc.company_id=p.company_id AND pc.id=p.category_id
      WHERE r.company_id=$1 AND pc.key='workplace-requirements'
      ORDER BY r.key LIMIT 1`,
    [input.companyId],
  );
  const selected = rule.rows[0];
  if (selected === undefined) throw new Error('The coherent workplace-requirements category has no published rule');
  const requestStarted = performance.now();
  await apiRequest(input.app, input.companyId, 'POST', `/rules/${selected.id}/versions`, {
    policyId: selected.policy_id,
    priority: selected.priority,
    enabled: selected.enabled,
    validFrom: input.asOfDate,
    publish: true,
    condition: {
      type: 'comparison',
      fact: { kind: 'employee', field: 'hire_date' },
      operator: 'LTE',
      value: input.asOfDate,
    },
  });
  const committedAtPerformance = performance.now();
  const committedAtEpoch = Date.now();
  const apiCommitMs = committedAtPerformance - requestStarted;
  const workers = Array.from(
    { length: 16 },
    () => new ReconciliationWorker(input.pool, workerConfig, input.clock, input.companyId),
  );
  const reports = await drainWorkerPool(workers);
  const errors = reports.filter((report) => report.error !== null);
  const parentReports = reports.filter((report) => report.job.scope === 'RULE');
  const childReports = reports.filter((report) => report.job.scope === 'FANOUT');
  if (errors.length > 0 || parentReports.length !== 1 || childReports.length < 2) {
    throw new Error(`Expected one broad parent and multiple fan-out units; received ${parentReports.length} parents and ${childReports.length} children: ${errors.map((item) => item.error).join('; ')}`);
  }
  const report = parentReports[0]!;
  await input.pool.query('SELECT count(*) FROM materialized_assignments WHERE company_id=$1', [input.companyId]);
  const visibleAt = performance.now();
  const timestamps = await input.pool.query<{ started_at: Date }>(
    'SELECT started_at FROM reconciliation_jobs WHERE company_id=$1 AND id=$2',
    [input.companyId, report.job.id],
  );
  await assertNoActiveJobs(input.pool, input.companyId);
  const commitToVisibleMs = visibleAt - committedAtPerformance;
  const reconciliation = emptyReconciliationProfile();
  for (const item of reports) {
    for (const key of Object.keys(reconciliation.stageMs) as Array<keyof typeof reconciliation.stageMs>) {
      reconciliation.stageMs[key] += item.profile.reconciliation.stageMs[key];
    }
    for (const key of Object.keys(reconciliation.counts) as Array<keyof typeof reconciliation.counts>) {
      reconciliation.counts[key] += item.profile.reconciliation.counts[key];
    }
  }
  const impactAnalysisMs = reports.reduce((total, item) => total + item.profile.impactAnalysisMs, 0);
  const impactDatabaseMs = reports.reduce((total, item) => total + item.profile.impactDatabaseMs, 0);
  const impactAssemblyMs = reports.reduce((total, item) => total + item.profile.impactAssemblyMs, 0);
  const jobCompletionWriteMs = reports.reduce((total, item) => total + item.profile.jobCompletionWriteMs, 0);
  const topLevelAccounted = impactAnalysisMs
    + reconciliation.stageMs.ruleFactLoading
    + reconciliation.stageMs.transactionTotal
    + jobCompletionWriteMs;
  const stageMs = {
    impactAnalysis: round(impactAnalysisMs),
    impactDatabase: round(impactDatabaseMs),
    affectedEmployeeAssembly: round(impactAssemblyMs),
    ruleFactLoading: round(reconciliation.stageMs.ruleFactLoading),
    employeeSnapshotLoading: round(reconciliation.stageMs.employeeSnapshotLoading),
    categoryRuleLoading: round(reconciliation.stageMs.categoryRuleLoading),
    overrideLoading: round(reconciliation.stageMs.overrideLoading),
    transactionTotal: round(reconciliation.stageMs.transactionTotal),
    transactionCommitAndOverhead: round(reconciliation.stageMs.transactionCommitAndOverhead),
    advisoryLock: round(reconciliation.stageMs.advisoryLock),
    evaluationResolution: round(reconciliation.stageMs.evaluationResolution),
    decisionWrites: round(reconciliation.stageMs.decisionWrites),
    assignmentReads: round(reconciliation.stageMs.assignmentReads),
    diffPlanning: round(reconciliation.stageMs.diffPlanning),
    assignmentHistoryWrites: round(reconciliation.stageMs.assignmentHistoryWrites),
    materializedAssignmentWrites: round(reconciliation.stageMs.materializedAssignmentWrites),
    scheduledTransitionWrites: round(reconciliation.stageMs.scheduledTransitionWrites),
    jobCompletionWrite: round(jobCompletionWriteMs),
    unaccountedTopLevel: round(Math.max(0, commitToVisibleMs - topLevelAccounted)),
  };
  const results = childReports.flatMap((item) => item.results);
  const affectedEmployees = new Set(results.map((result) => result.employeeId)).size;
  const affectedScopes = results.length;
  const historyRowsWritten = reconciliation.counts.historyRowsInserted
    + reconciliation.counts.historyRowsClosed + reconciliation.counts.historyRowsDeleted;
  return {
    ruleId: selected.id,
    apiCommitMs: round(apiCommitMs),
    queueWaitMs: round(Math.max(0, timestamps.rows[0]!.started_at.getTime() - committedAtEpoch)),
    commitToVisibleMs: round(commitToVisibleMs),
    affectedEmployees,
    affectedScopes,
    scopesPerSecond: round(affectedScopes / (commitToVisibleMs / 1_000)),
    configuredWorkers: workers.length,
    workersThatProcessedJobs: new Set(childReports.map((item) => item.profile.workerId)).size,
    fanOutWorkUnits: childReports.length,
    jobCount: reports.length,
    stageMs,
    stagePercentOfCommitToVisible: Object.fromEntries(
      Object.entries(stageMs).map(([key, value]) => [key, round((value / commitToVisibleMs) * 100)]),
    ),
    counts: reconciliation.counts,
    assignmentInserts: reconciliation.counts.assignmentInserts,
    assignmentRemovals: reconciliation.counts.assignmentRemovals,
    historyRowsWritten,
    decisionRowsWritten: reconciliation.counts.decisionsInserted,
    actualRuleEvaluations: reconciliation.counts.ruleEvaluations,
  };
}

async function drainWorkerPool(workers: readonly ReconciliationWorker[]): Promise<JobProcessingReport[]> {
  const reports: JobProcessingReport[] = [];
  while (true) {
    const round = await Promise.all(workers.map((worker) => worker.processNext()));
    let claimed = 0;
    for (const report of round) {
      if (report === null) continue;
      claimed += 1;
      reports.push(report);
    }
    if (claimed === 0) return reports;
  }
}

function summarizeMeasurements(measurements: readonly LocalMeasurement[]): Record<string, Distribution> {
  const fields: Array<keyof Pick<LocalMeasurement,
    'apiCommitMs' | 'queueWaitMs' | 'commitToVisibleMs' | 'requestToVisibleMs' | 'impactAnalysisMs'
    | 'ruleFactLoadingMs' | 'evaluationResolutionMs' | 'reconciliationTransactionMs' | 'assignmentWriteMs'
  >> = [
    'apiCommitMs', 'queueWaitMs', 'commitToVisibleMs', 'requestToVisibleMs', 'impactAnalysisMs',
    'ruleFactLoadingMs', 'evaluationResolutionMs', 'reconciliationTransactionMs', 'assignmentWriteMs',
  ];
  return Object.fromEntries(fields.map((field) => [field, distribution(measurements.map((item) => item[field]))]));
}

function distribution(values: readonly number[]): Distribution {
  if (values.length === 0) return { samples: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 };
  return {
    samples: values.length,
    p50Ms: round(percentile(values, 0.50)),
    p95Ms: round(percentile(values, 0.95)),
    p99Ms: round(percentile(values, 0.99)),
  };
}

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]!;
}

async function apiRequest(
  appInstance: FastifyInstance,
  companyId: string,
  method: 'PATCH' | 'POST',
  url: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await appInstance.inject({
    method,
    url,
    headers: { 'x-company-id': companyId, 'content-type': 'application/json' },
    payload: body,
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`${method} ${url} failed with ${response.statusCode}: ${response.body}`);
  }
  return response.body === '' ? null : response.json();
}

async function allEmployeeIds(db: DbPool, companyId: string): Promise<string[]> {
  const result = await db.query<{ id: string }>('SELECT id FROM employees WHERE company_id=$1 ORDER BY id', [companyId]);
  return result.rows.map((row) => row.id);
}

async function assertNoActiveJobs(db: DbPool, companyId: string): Promise<void> {
  const result = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM reconciliation_jobs
      WHERE company_id=$1 AND status IN ('PENDING','RUNNING','WAITING','DEAD')`,
    [companyId],
  );
  if (result.rows[0]!.count !== 0) throw new Error(`Benchmark queue is not clean: ${result.rows[0]!.count} active/dead jobs`);
}

async function loadInvariants(db: DbPool, companyId: string): Promise<Record<string, number>> {
  const result = await db.query<{
    cardinality: number; duplicates: number; cross_tenant: number;
  }>(
    `SELECT
      (SELECT count(*)::int FROM (
        SELECT ma.employee_id,ma.category_id FROM materialized_assignments ma
        JOIN policy_categories pc ON pc.company_id=ma.company_id AND pc.id=ma.category_id
        WHERE ma.company_id=$1 AND pc.cardinality='SINGLE'
        GROUP BY ma.employee_id,ma.category_id HAVING count(*)>1
      ) invalid) AS cardinality,
      (SELECT count(*)::int FROM (
        SELECT employee_id,policy_id FROM materialized_assignments WHERE company_id=$1
        GROUP BY employee_id,policy_id HAVING count(*)>1
      ) duplicated) AS duplicates,
      (SELECT count(*)::int FROM materialized_assignments ma JOIN employees e ON e.id=ma.employee_id
        WHERE ma.company_id=$1 AND e.company_id<>ma.company_id) AS cross_tenant`,
    [companyId],
  );
  return result.rows[0]!;
}

function nextDifferent(values: readonly string[], current: string, ordinal: number): string {
  if (values.length < 2) throw new Error('A benchmark field needs at least two observed values');
  for (let offset = 1; offset <= values.length; offset += 1) {
    const candidate = values[(ordinal + offset) % values.length]!;
    if (candidate !== current) return candidate;
  }
  throw new Error('Could not select a different observed value');
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function integerArgument(name: string, fallback: number): number {
  const raw = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (raw === undefined) return fallback;
  const value = Number(raw.slice(name.length + 1));
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function stringArgument(name: string, fallback: string): string {
  const raw = process.argv.find((argument) => argument.startsWith(`${name}=`));
  const value = raw?.slice(name.length + 1).trim();
  if (value === undefined || value === '') return fallback;
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(value)) throw new Error(`${name} must contain only letters, digits, and hyphens`);
  return value;
}

function formatMarkdown(artifact: {
  label: string;
  dataset: { employees: number };
  universe: { rules: number; policies: number };
  local: {
    totalSamples: number;
    overall: Record<string, Distribution>;
    byMutationType: Record<string, Record<string, Distribution>>;
  };
  broad: BroadMeasurement;
  correctness: Record<string, unknown>;
}): string {
  const latency = artifact.local.overall['commitToVisibleMs']!;
  const lines = [
    `# Production performance benchmark — ${artifact.label}`,
    '',
    `Population: ${artifact.dataset.employees.toLocaleString()} employees`,
    `Universe: ${artifact.universe.rules} rules / ${artifact.universe.policies} policies`,
    `Isolated samples: ${artifact.local.totalSamples}`,
    '',
    '## Isolated commit → assignment-visible latency',
    '',
    `Overall p50 / p95 / p99: ${latency.p50Ms} / ${latency.p95Ms} / ${latency.p99Ms} ms`,
  ];
  for (const type of localTypes) {
    const value = artifact.local.byMutationType[type]!['commitToVisibleMs']!;
    lines.push(`${type}: ${value.p50Ms} / ${value.p95Ms} / ${value.p99Ms} ms`);
  }
  lines.push(
    '',
    '## Broad fan-out',
    '',
    `Affected employees/scopes: ${artifact.broad.affectedEmployees.toLocaleString()} / ${artifact.broad.affectedScopes.toLocaleString()}`,
    `Commit → visible: ${artifact.broad.commitToVisibleMs} ms`,
    `Throughput: ${artifact.broad.scopesPerSecond} scopes/sec`,
    `Configured/effective workers: ${artifact.broad.configuredWorkers} / ${artifact.broad.workersThatProcessedJobs}`,
    `Fan-out work units: ${artifact.broad.fanOutWorkUnits}`,
    `Rule evaluations: ${artifact.broad.actualRuleEvaluations.toLocaleString()}`,
    `Decisions inserted: ${artifact.broad.decisionRowsWritten.toLocaleString()}`,
    `Assignment inserts/removals: ${artifact.broad.assignmentInserts.toLocaleString()} / ${artifact.broad.assignmentRemovals.toLocaleString()}`,
    `History rows written: ${artifact.broad.historyRowsWritten.toLocaleString()}`,
    '',
    '### Stage timings',
    '',
  );
  for (const [stage, milliseconds] of Object.entries(artifact.broad.stageMs)) {
    lines.push(`${stage}: ${milliseconds} ms (${artifact.broad.stagePercentOfCommitToVisible[stage]}%)`);
  }
  lines.push('', '## Correctness', '', '```json', JSON.stringify(artifact.correctness, null, 2), '```', '');
  return `${lines.join('\n')}\n`;
}
