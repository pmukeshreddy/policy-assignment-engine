import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../api/app.js';
import type { DbPool } from '../db.js';
import { stableJson } from '../domain/rules.js';
import { addDays } from './deterministic.js';
import {
  buildMutationBatches,
  generateMutationPlan,
  type MutationBatchKind,
  type PlannedMutation,
} from './mutations.js';
import { DatabaseFullRecomputeOracle } from './oracle.js';
import {
  rebuildEvaluationUniverse,
  resumePreparedEvaluationUniverse,
  type EvaluationUniverse,
} from './rule-universe.js';
import type { JobScope } from '../services/jobs.js';
import { ReconciliationWorker, type JobProcessingReport } from '../services/worker.js';

export const DEFAULT_REGRESSION_SEED = 482_901;
export const DEFAULT_MUTATION_COUNT = 100_000;
export const DEFAULT_MUTATION_BATCH_SIZE = 500;
export const DEFAULT_WORKER_CONCURRENCY_CANDIDATES = [8, 12, 16] as const;
const DEFAULT_CONCURRENCY_CALIBRATION_JOBS = 240;

interface EmployeeState {
  id: string;
  externalId: string;
  location: string;
  department: string;
  employmentType: string;
  hireDate: string;
  attributes: Record<string, unknown>;
}

interface RegressionContext {
  companyId: string;
  asOfDate: string;
  employees: EmployeeState[];
  locations: string[];
  departments: string[];
  employmentTypes: string[];
  jobTitles: string[];
  categories: EvaluationUniverse['categories'];
  groupIds: string[];
}

interface ExecutedMutation extends PlannedMutation {
  asOfDate: string;
  employeeId?: string;
  entityId?: string;
  details?: Record<string, unknown>;
}

interface MutationEffect {
  employeeIds: string[];
  globalComparison: boolean;
  retryRequested: boolean;
  executed: ExecutedMutation;
}

interface DrainedJobs {
  reports: JobProcessingReport[];
  rulesEvaluated: number;
  scopes: number;
  scopeKeys: string[];
  durationMs: number;
}

export interface RegressionBatchRecord {
  seed: number;
  batchNumber: number;
  kind: MutationBatchKind;
  mutationStartIndex: number;
  mutationEndIndex: number;
  asOfDateBefore: string;
  asOfDateAfter: string;
  mutations: ExecutedMutation[];
  affectedEmployeeIds: string[];
  affectedScopes: string[];
  jobs: Array<{
    id: string;
    eventType: string;
    scope: JobScope;
    attempts: number;
    durationMs: number;
    scopes: number;
    rulesEvaluated: number;
  }>;
  jobsByScope: Partial<Record<JobScope, number>>;
  oracle: {
    employeesCompared: number;
    assignmentScopesCompared: number;
    rulesEvaluated: number;
    durationMs: number;
    mismatches: number;
    determinismFailures: number;
  };
  invariants: InvariantCounts;
  durationMs: number;
  status: 'PASSED';
}

interface WorkerCalibrationResult {
  selectedConcurrency: number;
  candidates: Array<{
    concurrency: number;
    jobs: number;
    scopes: number;
    durationMs: number;
    scopesPerSecond: number;
  }>;
}

export interface InvariantCounts {
  assignmentMismatches: number;
  impactFalseNegatives: number;
  cardinalityViolations: number;
  determinismFailures: number;
  idempotencyFailures: number;
  tenantIsolationFailures: number;
  duplicateActiveAssignments: number;
}

export interface RegressionReport {
  status: 'PASSED' | 'FAILED';
  seed: number;
  dataset: {
    id: string;
    importId: string;
    checksum: string;
  };
  employees: number;
  rules: number;
  stateMutations: number;
  batchesVerified: number;
  oracleComparisons: number;
  configuration: {
    localizedBatchSize: number;
    workerConcurrency: number;
  };
  invariants: InvariantCounts;
  performance: {
    reconciliationP50Ms: number;
    reconciliationP95Ms: number;
    reconciliationP99Ms: number;
    averageRulesEvaluatedPerMutation: number;
    incrementalRulesEvaluated: number;
    fullRecomputeRulesEvaluated: number;
    ruleEvaluationWorkAvoidedPercent: number;
    reconciliationJobs: number;
    reconciliationJobsByScope: Partial<Record<JobScope, number>>;
    jobThroughputPerSecond: number;
    localizedMutationThroughputPerSecond: number;
    affectedScopesPerSecond: number;
    largePopulationChangeP50Ms: number;
    largePopulationChangeP95Ms: number;
    largePopulationChangeMaxMs: number;
    largeRuleChangeP50Ms: number;
    largeRuleChangeP95Ms: number;
    largeRuleChangeMaxMs: number;
    temporalTransitionMs: number;
    mutationRuntimeMs: number;
    totalRuntimeMs: number;
  };
  baseline: {
    reconciliationJobs: number;
    scopesReconciled: number;
    durationMs: number;
  };
  workerCalibration: WorkerCalibrationResult;
  artifacts: { json: string; markdown: string; batches: string; failureSequence?: string };
}

export async function runRegressionEvaluation(
  pool: DbPool,
  input: {
    seed?: number;
    mutationCount?: number;
    batchSize?: number;
    artifactDirectory?: string;
    expectedEmployees?: number;
    ruleCount?: number;
    reusePreparedUniverse?: boolean;
    workerConcurrencyCandidates?: readonly number[];
    concurrencyCalibrationJobs?: number;
    progress?: (message: string) => void;
  } = {},
): Promise<RegressionReport> {
  const seed = input.seed ?? DEFAULT_REGRESSION_SEED;
  const mutationCount = input.mutationCount ?? DEFAULT_MUTATION_COUNT;
  const batchSize = input.batchSize ?? DEFAULT_MUTATION_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) throw new Error('Regression batch size must be between 1 and 10,000');
  const concurrencyCandidates = input.workerConcurrencyCandidates ?? DEFAULT_WORKER_CONCURRENCY_CANDIDATES;
  if (concurrencyCandidates.length === 0 || concurrencyCandidates.some((value) => !Number.isInteger(value) || value < 1 || value > 16)) {
    throw new Error('Worker concurrency candidates must contain integers between 1 and 16');
  }
  const calibrationJobs = input.concurrencyCalibrationJobs ?? DEFAULT_CONCURRENCY_CALIBRATION_JOBS;
  if (!Number.isInteger(calibrationJobs) || calibrationJobs < 16 || calibrationJobs > 2_000) {
    throw new Error('Concurrency calibration jobs must be between 16 and 2,000');
  }
  const progress = input.progress ?? (() => undefined);
  const artifactDirectory = resolve(input.artifactDirectory ?? 'eval-results');
  await mkdir(artifactDirectory, { recursive: true });
  const batchArtifactPath = resolve(artifactDirectory, `batches-seed-${seed}.jsonl`);
  await writeFile(batchArtifactPath, '', 'utf8');
  const totalStarted = performance.now();
  const prepareUniverse = input.reusePreparedUniverse === true
    ? resumePreparedEvaluationUniverse
    : rebuildEvaluationUniverse;
  const universe = await prepareUniverse(pool, {
    ...(input.expectedEmployees === undefined ? {} : { expectedEmployees: input.expectedEmployees }),
    ...(input.ruleCount === undefined ? {} : { ruleCount: input.ruleCount }),
  });
  const context = await loadContext(pool, universe);
  const clock = (): Date => new Date(`${context.asOfDate}T12:00:00Z`);
  const app = buildApp({ pool, config: { LOG_LEVEL: 'silent', PREVIEW_MAX_EMPLOYEES: Math.max(100_000, universe.employeeCount) }, clock });
  await app.ready();
  const workerConfig = {
    WORKER_POLL_MS: 50,
    WORKER_CONCURRENCY: 1,
    JOB_MAX_ATTEMPTS: 3,
    JOB_LEASE_SECONDS: 120,
  } as const;
  const makeWorkers = (count: number): ReconciliationWorker[] => Array.from(
    { length: count },
    () => new ReconciliationWorker(pool, workerConfig, clock, context.companyId),
  );
  const baselineWorker = makeWorkers(1)[0]!;
  const oracle = new DatabaseFullRecomputeOracle(pool);
  const invariants: InvariantCounts = {
    assignmentMismatches: 0,
    impactFalseNegatives: 0,
    cardinalityViolations: 0,
    determinismFailures: 0,
    idempotencyFailures: 0,
    tenantIsolationFailures: 0,
    duplicateActiveAssignments: 0,
  };
  const executed: ExecutedMutation[] = [];
  let oracleComparisons = 0;
  let fullRecomputeRulesEvaluated = 0;
  let incrementalRulesEvaluated = 0;
  let mutationJobs = 0;
  let mutationScopes = 0;
  let mutationReconciliationMs = 0;
  let localizedMutations = 0;
  let localizedRuntimeMs = 0;
  let batchesVerified = 0;
  const jobsByScope: Partial<Record<JobScope, number>> = {};
  const largePopulationChangeDurations: number[] = [];
  const largeRuleChangeDurations: number[] = [];
  let temporalTransitionMs = 0;
  const reconciliationLatencies: number[] = [];
  const baselineStarted = performance.now();
  let mutationStarted: number;
  let activeBatch: Record<string, unknown> | null = null;
  try {
    progress(`Materializing baseline through the production worker for ${universe.employeeCount.toLocaleString()} employees...`);
    const baselineDrain = await drainWorkers([baselineWorker]);
    const baseline = {
      reconciliationJobs: baselineDrain.reports.length,
      scopesReconciled: baselineDrain.scopes,
      durationMs: performance.now() - baselineStarted,
    };
    progress('Comparing the complete baseline to the independent full-recompute oracle...');
    const baselineComparison = await compareEmployees(pool, oracle, context.companyId, context.employees.map((employee) => employee.id), context.asOfDate);
    oracleComparisons += baselineComparison.comparisons;
    invariants.determinismFailures += baselineComparison.deterministicFailures;
    if (baselineComparison.mismatches.length > 0 || baselineComparison.deterministicFailures > 0) {
      invariants.assignmentMismatches += baselineComparison.mismatches.length;
      throw new RegressionMismatchError('Baseline differs from the independent oracle', baselineComparison.mismatches);
    }

    progress(`Calibrating bounded worker concurrency across ${concurrencyCandidates.join(', ')} workers...`);
    const workerCalibration = await calibrateWorkerConcurrency({
      pool,
      context,
      oracle,
      seed,
      candidates: concurrencyCandidates,
      jobCount: calibrationJobs,
      makeWorkers,
    });
    progress(`Selected ${workerCalibration.selectedConcurrency} workers from measured local throughput.`);
    const workers = makeWorkers(workerCalibration.selectedConcurrency);
    const schedulerWorker = workers[0]!;

    const plan = generateMutationPlan({
      seed,
      count: mutationCount,
      employeeCount: context.employees.length,
      targetCount: Math.max(universe.ruleCount, context.categories.flatMap((category) => category.policyIds).length),
    });
    const plannedBatches = buildMutationBatches(plan, batchSize);
    mutationStarted = performance.now();
    for (let batchIndex = 0; batchIndex < plannedBatches.length; batchIndex += 1) {
      const plannedBatch = plannedBatches[batchIndex]!;
      const batch = plannedBatch.mutations;
      const batchStarted = performance.now();
      const asOfDateBefore = context.asOfDate;
      const touched = new Set<string>();
      let retryRequests = 0;
      const batchExecuted: ExecutedMutation[] = [];
      activeBatch = {
        seed,
        batchNumber: batchIndex + 1,
        kind: plannedBatch.kind,
        mutationStartIndex: batch[0]!.index,
        mutationEndIndex: batch.at(-1)!.index,
        plannedMutations: batch,
        executedMutations: batchExecuted,
        asOfDateBefore,
      };
      for (const mutation of batch) {
        const effect = await executeMutation(app, pool, context, mutation);
        effect.employeeIds.forEach((employeeId) => touched.add(employeeId));
        if ((plannedBatch.kind === 'GLOBAL') !== effect.globalComparison) {
          throw new Error(`Mutation ${mutation.index} was classified inconsistently as ${plannedBatch.kind}`);
        }
        if (effect.retryRequested) retryRequests += 1;
        executed.push(effect.executed);
        batchExecuted.push(effect.executed);
      }
      await releaseSimulatedFutureJobs(pool, context.companyId);
      while ((await schedulerWorker.enqueueDueTemporalJobs(10_000)) > 0) {
        // Continue until every due temporal boundary has its transactional outbox job.
      }
      const drainedParts: DrainedJobs[] = [await drainWorkers(workers)];
      const processedScopes = new Set(drainedParts[0]!.scopeKeys);
      for (let retry = 0; retry < retryRequests; retry += 1) {
        const reports = drainedParts.flatMap((part) => part.reports).sort((left, right) => {
          const leftKey = `${left.job.scope}:${left.job.eventType}:${stableJson(left.job.payload)}`;
          const rightKey = `${right.job.scope}:${right.job.eventType}:${stableJson(right.job.payload)}`;
          return leftKey.localeCompare(rightKey) || left.job.id.localeCompare(right.job.id);
        });
        const retryTarget = reports.find((report) => report.results.length > 0 && report.results.length <= 100);
        if (retryTarget === undefined) {
          invariants.idempotencyFailures += 1;
          throw new Error('Duplicate-delivery mutation had no bounded completed job to retry');
        }
        const retryScopes = retryTarget.results.map((result) => ({ employeeId: result.employeeId, categoryId: result.categoryId }));
        const before = await loadScopeAssignments(pool, context.companyId, retryScopes);
        await pool.query(
          `UPDATE reconciliation_jobs
              SET status = 'PENDING', attempts = 0, available_at = now(), locked_at = NULL,
                  locked_by = NULL, finished_at = NULL, last_error = NULL
            WHERE company_id = $1 AND id = $2 AND status = 'SUCCEEDED'`,
          [context.companyId, retryTarget.job.id],
        );
        const retryDrain = await drainWorkers(workers);
        drainedParts.push(retryDrain);
        retryDrain.scopeKeys.forEach((scope) => processedScopes.add(scope));
        const after = await loadScopeAssignments(pool, context.companyId, retryScopes);
        if (serializeMap(before) !== serializeMap(after)) {
          invariants.idempotencyFailures += 1;
          throw new Error(`Duplicate execution of job ${retryTarget.job.id} changed materialized assignments`);
        }
      }
      const drained = mergeDrainedJobs(drainedParts);
      await assertQueueDrained(pool, context.companyId);
      Object.assign(activeBatch!, {
        asOfDateAfter: context.asOfDate,
        affectedScopes: [...processedScopes].sort(),
        jobs: drained.reports.map((report) => ({
          id: report.job.id,
          eventType: report.job.eventType,
          scope: report.job.scope,
          attempts: report.job.attempts,
          durationMs: round(report.durationMs),
          scopes: report.results.length,
        })),
      });
      mutationJobs += drained.reports.length;
      mutationScopes += drained.scopes;
      mutationReconciliationMs += drained.durationMs;
      incrementalRulesEvaluated += drained.rulesEvaluated;
      reconciliationLatencies.push(...drained.reports.map((report) => report.durationMs));
      for (const report of drained.reports) {
        jobsByScope[report.job.scope] = (jobsByScope[report.job.scope] ?? 0) + 1;
      }
      const reconciliationCompletionMs = performance.now() - batchStarted;
      if (plannedBatch.kind === 'GLOBAL') {
        largePopulationChangeDurations.push(reconciliationCompletionMs);
        if (batch[0]!.kind.startsWith('rule_')) largeRuleChangeDurations.push(reconciliationCompletionMs);
        if (batch[0]!.kind === 'date_advance') temporalTransitionMs += reconciliationCompletionMs;
      }

      const comparedEmployeeIds = plannedBatch.kind === 'GLOBAL'
        ? context.employees.map((employee) => employee.id)
        : [...touched].sort();
      const oracleStarted = performance.now();
      const comparison = await compareEmployees(pool, oracle, context.companyId, comparedEmployeeIds, context.asOfDate);
      const oracleDurationMs = performance.now() - oracleStarted;
      Object.assign(activeBatch!, {
        affectedEmployeeIds: comparedEmployeeIds,
        oracle: {
          employeesCompared: comparedEmployeeIds.length,
          assignmentScopesCompared: comparison.comparisons,
          rulesEvaluated: comparison.rulesEvaluated,
          durationMs: round(oracleDurationMs),
          mismatches: comparison.mismatches,
          determinismFailures: comparison.deterministicFailures,
        },
      });
      oracleComparisons += comparison.comparisons;
      fullRecomputeRulesEvaluated += comparison.rulesEvaluated;
      invariants.determinismFailures += comparison.deterministicFailures;
      if (comparison.mismatches.length > 0) {
        for (const mismatch of comparison.mismatches) {
          if (processedScopes.has(mismatch.key)) invariants.assignmentMismatches += 1;
          else invariants.impactFalseNegatives += 1;
        }
        throw new RegressionMismatchError(`Regression mismatch after mutation ${batch.at(-1)!.index}`, comparison.mismatches);
      }
      if (comparison.deterministicFailures > 0) throw new Error('Independent oracle produced order-dependent results');

      const batchInvariants = await loadHardInvariantCounts(pool, context.companyId);
      invariants.cardinalityViolations += batchInvariants.cardinalityViolations;
      invariants.duplicateActiveAssignments += batchInvariants.duplicateActiveAssignments;
      invariants.tenantIsolationFailures += batchInvariants.tenantIsolationFailures;
      if (Object.values(invariants).some((count) => count !== 0)) {
        throw new Error(`Hard regression invariants failed after mutation ${batch.at(-1)!.index}: ${JSON.stringify(invariants)}`);
      }

      const batchDurationMs = performance.now() - batchStarted;
      if (plannedBatch.kind === 'LOCALIZED') {
        localizedMutations += batch.length;
        localizedRuntimeMs += batchDurationMs;
      }
      const record: RegressionBatchRecord = {
        seed,
        batchNumber: batchIndex + 1,
        kind: plannedBatch.kind,
        mutationStartIndex: batch[0]!.index,
        mutationEndIndex: batch.at(-1)!.index,
        asOfDateBefore,
        asOfDateAfter: context.asOfDate,
        mutations: batchExecuted,
        affectedEmployeeIds: comparedEmployeeIds,
        affectedScopes: [...processedScopes].sort(),
        jobs: drained.reports.map((report) => ({
          id: report.job.id,
          eventType: report.job.eventType,
          scope: report.job.scope,
          attempts: report.job.attempts,
          durationMs: round(report.durationMs),
          scopes: report.results.length,
          rulesEvaluated: report.results.reduce((count, result) => count + result.rulesEvaluated, 0),
        })),
        jobsByScope: countJobsByScope(drained.reports),
        oracle: {
          employeesCompared: comparedEmployeeIds.length,
          assignmentScopesCompared: comparison.comparisons,
          rulesEvaluated: comparison.rulesEvaluated,
          durationMs: round(oracleDurationMs),
          mismatches: comparison.mismatches.length,
          determinismFailures: comparison.deterministicFailures,
        },
        invariants: { ...invariants },
        durationMs: round(batchDurationMs),
        status: 'PASSED',
      };
      await appendFile(batchArtifactPath, `${JSON.stringify(record)}\n`, 'utf8');
      batchesVerified += 1;
      activeBatch = null;
      progress(
        `Verified mutations ${(batch[0]!.index + 1).toLocaleString()}–${(batch.at(-1)!.index + 1).toLocaleString()} `
        + `(${plannedBatch.kind.toLowerCase()}); ${(batch.at(-1)!.index + 1).toLocaleString()} / ${plan.length.toLocaleString()}`,
      );
    }

    const hardInvariants = await loadHardInvariantCounts(pool, context.companyId);
    invariants.cardinalityViolations += hardInvariants.cardinalityViolations;
    invariants.duplicateActiveAssignments += hardInvariants.duplicateActiveAssignments;
    invariants.tenantIsolationFailures += hardInvariants.tenantIsolationFailures;
    if (Object.values(invariants).some((count) => count !== 0)) {
      throw new Error(`Hard regression invariants failed: ${JSON.stringify(invariants)}`);
    }
    const totalRuntimeMs = performance.now() - totalStarted;
    const mutationRuntimeMs = performance.now() - mutationStarted;
    const incremental = incrementalRulesEvaluated;
    const full = fullRecomputeRulesEvaluated;
    const report: RegressionReport = {
      status: 'PASSED',
      seed,
      dataset: { id: 'k397-673e', importId: universe.importId, checksum: universe.datasetChecksum },
      employees: universe.employeeCount,
      rules: universe.ruleCount,
      stateMutations: mutationCount,
      batchesVerified,
      oracleComparisons,
      configuration: {
        localizedBatchSize: batchSize,
        workerConcurrency: workerCalibration.selectedConcurrency,
      },
      invariants,
      performance: {
        reconciliationP50Ms: percentile(reconciliationLatencies, 0.50),
        reconciliationP95Ms: percentile(reconciliationLatencies, 0.95),
        reconciliationP99Ms: percentile(reconciliationLatencies, 0.99),
        averageRulesEvaluatedPerMutation: round(incremental / mutationCount),
        incrementalRulesEvaluated: incremental,
        fullRecomputeRulesEvaluated: full,
        ruleEvaluationWorkAvoidedPercent: full === 0 ? 0 : round((1 - incremental / full) * 100),
        reconciliationJobs: mutationJobs,
        reconciliationJobsByScope: jobsByScope,
        jobThroughputPerSecond: mutationReconciliationMs === 0 ? 0 : round(mutationJobs / (mutationReconciliationMs / 1_000)),
        localizedMutationThroughputPerSecond: localizedRuntimeMs === 0 ? 0 : round(localizedMutations / (localizedRuntimeMs / 1_000)),
        affectedScopesPerSecond: mutationReconciliationMs === 0 ? 0 : round(mutationScopes / (mutationReconciliationMs / 1_000)),
        largePopulationChangeP50Ms: percentile(largePopulationChangeDurations, 0.50),
        largePopulationChangeP95Ms: percentile(largePopulationChangeDurations, 0.95),
        largePopulationChangeMaxMs: round(Math.max(0, ...largePopulationChangeDurations)),
        largeRuleChangeP50Ms: percentile(largeRuleChangeDurations, 0.50),
        largeRuleChangeP95Ms: percentile(largeRuleChangeDurations, 0.95),
        largeRuleChangeMaxMs: round(Math.max(0, ...largeRuleChangeDurations)),
        temporalTransitionMs: round(temporalTransitionMs),
        mutationRuntimeMs: round(mutationRuntimeMs),
        totalRuntimeMs: round(totalRuntimeMs),
      },
      baseline,
      workerCalibration,
      artifacts: {
        json: resolve(artifactDirectory, 'latest.json'),
        markdown: resolve(artifactDirectory, 'latest.md'),
        batches: batchArtifactPath,
      },
    };
    await writeReport(report);
    return report;
  } catch (error) {
    const failurePath = resolve(artifactDirectory, `failure-seed-${seed}.json`);
    await writeFile(failurePath, `${JSON.stringify({
      seed,
      asOfDate: context.asOfDate,
      executedMutations: executed,
      activeBatch,
      completedBatchArtifact: batchArtifactPath,
      invariants,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
      mismatches: error instanceof RegressionMismatchError ? error.mismatches : [],
    }, null, 2)}\n`, 'utf8');
    throw new Error(`Regression evaluation failed; reproducible sequence saved to ${failurePath}`, { cause: error });
  } finally {
    await app.close();
  }
}

export async function compareRegressionCheckpoint(
  pool: DbPool,
  input: { companyId: string; employeeIds: readonly string[]; asOfDate: string },
): Promise<{
  mismatches: Array<{ key: string; expected: string[]; actual: string[] }>;
  comparisons: number;
  rulesEvaluated: number;
  deterministicFailures: number;
}> {
  return compareEmployees(
    pool,
    new DatabaseFullRecomputeOracle(pool),
    input.companyId,
    input.employeeIds,
    input.asOfDate,
  );
}

async function loadContext(pool: DbPool, universe: EvaluationUniverse): Promise<RegressionContext> {
  const employees = await pool.query<{
    id: string;
    external_id: string;
    location: string;
    department: string;
    employment_type: string;
    hire_date: string;
    attributes: Record<string, unknown>;
  }>(
    `SELECT e.id, e.external_id, ev.location, ev.department, ev.employment_type,
            ev.hire_date::text, ev.attributes
       FROM employees e
       JOIN employee_versions ev ON ev.company_id = e.company_id AND ev.id = e.current_version_id
      WHERE e.company_id = $1
      ORDER BY e.external_id`,
    [universe.companyId],
  );
  if (employees.rows.length !== universe.employeeCount) throw new Error('Evaluation employee population changed during setup');
  const state = employees.rows.map((row) => {
    if (row.location === null || row.department === null || row.employment_type === null || row.hire_date === null) {
      throw new Error(`Imported employee ${row.id} is missing a required normalized fact`);
    }
    return {
      id: row.id,
      externalId: row.external_id,
      location: row.location,
      department: row.department,
      employmentType: row.employment_type,
      hireDate: row.hire_date,
      attributes: row.attributes,
    };
  });
  return {
    companyId: universe.companyId,
    asOfDate: universe.baselineDate,
    employees: state,
    locations: uniqueSorted(state.map((employee) => employee.location)),
    departments: uniqueSorted(state.map((employee) => employee.department)),
    employmentTypes: uniqueSorted(state.map((employee) => employee.employmentType)),
    jobTitles: uniqueSorted(state.map((employee) => employee.attributes['job_title']).filter((value): value is string => typeof value === 'string')),
    categories: universe.categories,
    groupIds: universe.groupIds,
  };
}

async function executeMutation(
  app: FastifyInstance,
  pool: DbPool,
  context: RegressionContext,
  mutation: PlannedMutation,
): Promise<MutationEffect> {
  const employee = context.employees[mutation.employeeOrdinal % context.employees.length]!;
  const executed: ExecutedMutation = { ...mutation, asOfDate: context.asOfDate, employeeId: employee.id };
  const employeeEffect = (): MutationEffect => ({ employeeIds: [employee.id], globalComparison: false, retryRequested: false, executed });
  if (mutation.kind === 'location_change') {
    employee.location = nextDifferent(context.locations, employee.location, mutation.valueOrdinal);
    await apiRequest(app, context.companyId, 'PATCH', `/employees/${employee.id}`, { location: employee.location, effectiveFrom: context.asOfDate });
    executed.details = { location: employee.location };
    return employeeEffect();
  }
  if (mutation.kind === 'department_change') {
    employee.department = nextDifferent(context.departments, employee.department, mutation.valueOrdinal);
    await apiRequest(app, context.companyId, 'PATCH', `/employees/${employee.id}`, { department: employee.department, effectiveFrom: context.asOfDate });
    executed.details = { department: employee.department };
    return employeeEffect();
  }
  if (mutation.kind === 'employment_type_change') {
    employee.employmentType = nextDifferent(context.employmentTypes, employee.employmentType, mutation.valueOrdinal);
    await apiRequest(app, context.companyId, 'PATCH', `/employees/${employee.id}`, { employmentType: employee.employmentType, effectiveFrom: context.asOfDate });
    executed.details = { employmentType: employee.employmentType };
    return employeeEffect();
  }
  if (mutation.kind === 'title_change') {
    const title = nextDifferent(context.jobTitles, String(employee.attributes['job_title']), mutation.valueOrdinal);
    employee.attributes = { ...employee.attributes, job_title: title };
    await apiRequest(app, context.companyId, 'PATCH', `/employees/${employee.id}`, { attributes: employee.attributes, effectiveFrom: context.asOfDate });
    executed.details = { jobTitle: title };
    return employeeEffect();
  }
  if (mutation.kind === 'hire_date_change') {
    const direction = mutation.valueOrdinal % 2 === 0 ? -1 : 1;
    const proposed = addDays(employee.hireDate, direction * mutation.magnitude);
    employee.hireDate = proposed > context.asOfDate ? addDays(context.asOfDate, -1) : proposed;
    await apiRequest(app, context.companyId, 'PATCH', `/employees/${employee.id}`, { hireDate: employee.hireDate, effectiveFrom: context.asOfDate });
    executed.details = { hireDate: employee.hireDate };
    return employeeEffect();
  }
  if (mutation.kind === 'group_membership_toggle') {
    const groupId = context.groupIds[mutation.targetOrdinal % context.groupIds.length]!;
    const active = await pool.query(
      `SELECT 1 FROM group_memberships
        WHERE company_id = $1 AND employee_id = $2 AND group_id = $3
          AND valid_from <= $4::date AND (valid_to IS NULL OR valid_to > $4::date)`,
      [context.companyId, employee.id, groupId, context.asOfDate],
    );
    if (active.rowCount === 1) {
      await apiRequest(app, context.companyId, 'DELETE', `/groups/${groupId}/members/${employee.id}?effectiveDate=${context.asOfDate}`);
      executed.details = { groupId, action: 'REMOVE' };
    } else {
      await apiRequest(app, context.companyId, 'POST', `/groups/${groupId}/members`, { employeeId: employee.id, effectiveFrom: context.asOfDate });
      executed.details = { groupId, action: 'ADD' };
    }
    executed.entityId = groupId;
    return employeeEffect();
  }
  if (mutation.kind === 'manual_assign' || mutation.kind === 'manual_exclude') {
    const category = context.categories[mutation.targetOrdinal % context.categories.length]!;
    const policyId = category.policyIds[mutation.valueOrdinal % category.policyIds.length]!;
    const response = await apiRequest(app, context.companyId, 'POST', '/manual-overrides', {
      employeeId: employee.id,
      policyId,
      action: mutation.kind === 'manual_assign' ? 'ASSIGN' : 'EXCLUDE',
      priority: (mutation.valueOrdinal % 101) - 50,
      reason: `Deterministic regression mutation ${mutation.index}`,
      validFrom: context.asOfDate,
    });
    executed.entityId = response.id;
    executed.details = { policyId, action: mutation.kind === 'manual_assign' ? 'ASSIGN' : 'EXCLUDE' };
    return employeeEffect();
  }
  if (mutation.kind === 'override_remove') {
    const override = await pool.query<{ id: string; employee_id: string }>(
      `SELECT id, employee_id
         FROM manual_overrides
        WHERE company_id = $1 AND revoked_at IS NULL
          AND valid_from <= $2::date AND (valid_to IS NULL OR valid_to > $2::date)
        ORDER BY (employee_id = $3) DESC, id
        LIMIT 1`,
      [context.companyId, context.asOfDate, employee.id],
    );
    const target = override.rows[0];
    if (target === undefined) throw new Error('Override-removal mutation requires an active override');
    await apiRequest(app, context.companyId, 'DELETE', `/manual-overrides/${target.id}`);
    executed.employeeId = target.employee_id;
    executed.entityId = target.id;
    return { employeeIds: [target.employee_id], globalComparison: false, retryRequested: false, executed };
  }
  if (mutation.kind === 'date_advance') {
    context.asOfDate = addDays(context.asOfDate, mutation.magnitude);
    executed.asOfDate = context.asOfDate;
    executed.details = { daysAdvanced: mutation.magnitude };
    return { employeeIds: [], globalComparison: true, retryRequested: false, executed };
  }
  if (mutation.kind === 'duplicate_job_retry') {
    return { employeeIds: [employee.id], globalComparison: false, retryRequested: true, executed };
  }
  if (mutation.kind === 'rule_create') {
    const category = context.categories[mutation.targetOrdinal % context.categories.length]!;
    const policyId = category.policyIds[mutation.valueOrdinal % category.policyIds.length]!;
    const response = await apiRequest(app, context.companyId, 'POST', '/rules', {
      key: `eval-runtime-rule-${mutation.index}`,
      policyId,
      priority: mutation.magnitude,
      enabled: true,
      validFrom: context.asOfDate,
      validTo: null,
      publish: true,
      condition: locationCondition(context, mutation.valueOrdinal),
    });
    executed.entityId = response.id;
    return { employeeIds: [], globalComparison: true, retryRequested: false, executed };
  }
  if (mutation.kind.startsWith('rule_')) {
    const target = await mutableRule(pool, context, mutation.targetOrdinal);
    const body: Record<string, unknown> = {
      policyId: target.policy_id,
      priority: target.priority,
      enabled: target.enabled,
      validFrom: context.asOfDate,
      validTo: null,
      condition: target.condition,
      publish: true,
    };
    if (mutation.kind === 'rule_condition_edit') body['condition'] = locationCondition(context, mutation.valueOrdinal);
    if (mutation.kind === 'rule_enable_toggle') body['enabled'] = !target.enabled;
    if (mutation.kind === 'rule_priority_change') body['priority'] = target.priority + mutation.magnitude;
    if (mutation.kind === 'rule_effective_date_change') body['validTo'] = addDays(context.asOfDate, mutation.magnitude + 1);
    const response = await apiRequest(app, context.companyId, 'POST', `/rules/${target.id}/versions`, body);
    executed.entityId = target.id;
    executed.details = { versionId: response.id };
    return { employeeIds: [], globalComparison: true, retryRequested: false, executed };
  }
  const policy = await mutablePolicy(pool, context, mutation.targetOrdinal);
  const response = await apiRequest(app, context.companyId, 'POST', `/policies/${policy.id}/versions`, {
    name: policy.name,
    description: policy.description,
    enabled: !policy.enabled,
    metadata: policy.metadata,
    effectiveFrom: context.asOfDate,
  });
  executed.entityId = policy.id;
  executed.details = { versionId: response.id, enabled: !policy.enabled };
  return { employeeIds: [], globalComparison: true, retryRequested: false, executed };
}

async function mutableRule(pool: DbPool, context: RegressionContext, ordinal: number): Promise<{
  id: string;
  policy_id: string;
  priority: number;
  enabled: boolean;
  condition: unknown;
}> {
  const result = await pool.query<{
    id: string;
    policy_id: string;
    priority: number;
    enabled: boolean;
    condition: unknown;
  }>(
    `SELECT r.id, rv.policy_id, rv.priority, rv.enabled, rv.condition
       FROM rules r
       JOIN rule_versions rv ON rv.company_id = r.company_id AND rv.id = r.current_version_id
      WHERE r.company_id = $1 AND rv.valid_from < $2::date
      ORDER BY r.id`,
    [context.companyId, context.asOfDate],
  );
  if (result.rows.length === 0) throw new Error('No rule can receive another version on the current evaluation date');
  return result.rows[ordinal % result.rows.length]!;
}

async function mutablePolicy(pool: DbPool, context: RegressionContext, ordinal: number): Promise<{
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  metadata: Record<string, unknown>;
}> {
  const result = await pool.query<{
    id: string;
    name: string;
    description: string | null;
    enabled: boolean;
    metadata: Record<string, unknown>;
  }>(
    `SELECT p.id, pv.name, pv.description, pv.enabled, pv.metadata
       FROM policies p
       JOIN policy_versions pv ON pv.company_id = p.company_id AND pv.id = p.current_version_id
      WHERE p.company_id = $1 AND pv.valid_from < $2::date
      ORDER BY p.id`,
    [context.companyId, context.asOfDate],
  );
  if (result.rows.length === 0) throw new Error('No policy can receive another version on the current evaluation date');
  return result.rows[ordinal % result.rows.length]!;
}

function locationCondition(context: RegressionContext, ordinal: number): Record<string, unknown> {
  return {
    type: 'comparison',
    fact: { kind: 'employee', field: 'location' },
    operator: 'EQ',
    value: context.locations[ordinal % context.locations.length],
  };
}

async function apiRequest(
  app: FastifyInstance,
  companyId: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
): Promise<Record<string, any>> {
  const response = await app.inject({
    method,
    url,
    headers: { 'x-company-id': companyId },
    ...(payload === undefined ? {} : { payload }),
  });
  if (response.statusCode >= 400) throw new Error(`${method} ${url}: ${response.statusCode} ${response.body}`);
  return response.statusCode === 204 ? {} : response.json();
}

async function drainWorkers(workers: readonly ReconciliationWorker[]): Promise<DrainedJobs> {
  if (workers.length === 0) throw new Error('At least one reconciliation worker is required');
  const started = performance.now();
  const reports: JobProcessingReport[] = [];
  const errors: string[] = [];
  await Promise.all(workers.map(async (worker) => {
    while (true) {
      const report = await worker.processNext();
      if (report === null) return;
      reports.push(report);
      if (report.error !== null) {
        errors.push(`Reconciliation job ${report.job.id} failed: ${report.error}`);
        return;
      }
    }
  }));
  if (errors.length > 0) throw new Error(errors.sort().join('; '));
  reports.sort((left, right) => left.job.id.localeCompare(right.job.id));
  let rulesEvaluated = 0;
  const scopeKeys: string[] = [];
  for (const report of reports) {
    for (const result of report.results) {
      rulesEvaluated += result.rulesEvaluated;
      scopeKeys.push(`${result.employeeId}:${result.categoryId}`);
    }
  }
  return {
    reports,
    rulesEvaluated,
    scopes: scopeKeys.length,
    scopeKeys,
    durationMs: performance.now() - started,
  };
}

function mergeDrainedJobs(parts: readonly DrainedJobs[]): DrainedJobs {
  const reports = parts.flatMap((part) => part.reports)
    .sort((left, right) => left.job.id.localeCompare(right.job.id) || left.durationMs - right.durationMs);
  return {
    reports,
    rulesEvaluated: parts.reduce((count, part) => count + part.rulesEvaluated, 0),
    scopes: parts.reduce((count, part) => count + part.scopes, 0),
    scopeKeys: parts.flatMap((part) => part.scopeKeys),
    durationMs: parts.reduce((duration, part) => duration + part.durationMs, 0),
  };
}

function countJobsByScope(reports: readonly JobProcessingReport[]): Partial<Record<JobScope, number>> {
  const counts: Partial<Record<JobScope, number>> = {};
  for (const report of reports) counts[report.job.scope] = (counts[report.job.scope] ?? 0) + 1;
  return counts;
}

async function assertQueueDrained(pool: DbPool, companyId: string): Promise<void> {
  const remaining = await pool.query<{ status: string; count: number }>(
    `SELECT status, count(*)::int AS count
       FROM reconciliation_jobs
      WHERE company_id = $1 AND status <> 'SUCCEEDED'
      GROUP BY status
      ORDER BY status`,
    [companyId],
  );
  if (remaining.rows.length > 0) {
    throw new Error(`Reconciliation queue did not drain completely: ${JSON.stringify(remaining.rows)}`);
  }
}

async function calibrateWorkerConcurrency(input: {
  pool: DbPool;
  context: RegressionContext;
  oracle: DatabaseFullRecomputeOracle;
  seed: number;
  candidates: readonly number[];
  jobCount: number;
  makeWorkers: (count: number) => ReconciliationWorker[];
}): Promise<WorkerCalibrationResult> {
  const employeeIds = Array.from({ length: input.jobCount }, (_, index) => (
    input.context.employees[(index * 7_919) % input.context.employees.length]!.id
  ));
  if (new Set(employeeIds).size !== employeeIds.length) throw new Error('Concurrency calibration employee selection is not unique');
  const calibrationId = randomUUID();
  const measurements: WorkerCalibrationResult['candidates'] = [];
  for (const concurrency of [...new Set(input.candidates)].sort((left, right) => left - right)) {
    const jobs = employeeIds.map((employeeId, ordinal) => ({
      employee_id: employeeId,
      dedupe_key: `evaluation-calibration:${input.seed}:${calibrationId}:${concurrency}:${ordinal}`,
    }));
    await input.pool.query(
      `INSERT INTO reconciliation_jobs
         (company_id, event_type, scope, payload, dedupe_key, priority)
       SELECT $1, 'EVALUATION_CONCURRENCY_CALIBRATION', 'EMPLOYEE',
              jsonb_build_object('employeeId', records.employee_id, 'changedFields', jsonb_build_array('location')),
              records.dedupe_key, -100
         FROM jsonb_to_recordset($2::jsonb) AS records(employee_id uuid, dedupe_key text)`,
      [input.context.companyId, JSON.stringify(jobs)],
    );
    const drained = await drainWorkers(input.makeWorkers(concurrency));
    await assertQueueDrained(input.pool, input.context.companyId);
    if (drained.reports.length !== input.jobCount || drained.scopes === 0) {
      throw new Error(`Worker calibration at concurrency ${concurrency} lost jobs or produced no scopes`);
    }
    const comparison = await compareEmployees(
      input.pool,
      input.oracle,
      input.context.companyId,
      employeeIds,
      input.context.asOfDate,
    );
    if (comparison.mismatches.length > 0 || comparison.deterministicFailures > 0) {
      throw new RegressionMismatchError(
        `Worker calibration at concurrency ${concurrency} changed assignments`,
        comparison.mismatches,
      );
    }
    const hardInvariants = await loadHardInvariantCounts(input.pool, input.context.companyId);
    if (Object.values(hardInvariants).some((count) => count !== 0)) {
      throw new Error(`Worker calibration at concurrency ${concurrency} violated invariants: ${JSON.stringify(hardInvariants)}`);
    }
    measurements.push({
      concurrency,
      jobs: drained.reports.length,
      scopes: drained.scopes,
      durationMs: round(drained.durationMs),
      scopesPerSecond: round(drained.scopes / (drained.durationMs / 1_000)),
    });
  }
  const selected = [...measurements].sort((left, right) => (
    right.scopesPerSecond - left.scopesPerSecond || left.concurrency - right.concurrency
  ))[0];
  if (selected === undefined) throw new Error('Worker concurrency calibration produced no measurement');
  return { selectedConcurrency: selected.concurrency, candidates: measurements };
}

async function releaseSimulatedFutureJobs(pool: DbPool, companyId: string): Promise<void> {
  await pool.query(
    `UPDATE reconciliation_jobs SET available_at = now()
      WHERE company_id = $1 AND status = 'PENDING' AND available_at > now()`,
    [companyId],
  );
}

async function compareEmployees(
  pool: DbPool,
  oracle: DatabaseFullRecomputeOracle,
  companyId: string,
  employeeIds: readonly string[],
  asOfDate: string,
): Promise<{
  mismatches: Array<{ key: string; expected: string[]; actual: string[] }>;
  comparisons: number;
  rulesEvaluated: number;
  deterministicFailures: number;
}> {
  if (employeeIds.length === 0) return { mismatches: [], comparisons: 0, rulesEvaluated: 0, deterministicFailures: 0 };
  const expected = await oracle.recompute(companyId, employeeIds, asOfDate);
  const categoryResult = await pool.query<{ id: string }>('SELECT id FROM policy_categories WHERE company_id = $1 ORDER BY id', [companyId]);
  const actual = new Map<string, string[]>();
  for (const employeeId of employeeIds) {
    for (const category of categoryResult.rows) actual.set(`${employeeId}:${category.id}`, []);
  }
  const uniqueIds = [...new Set(employeeIds)];
  for (let offset = 0; offset < uniqueIds.length; offset += 1_000) {
    const result = await pool.query<{ employee_id: string; category_id: string; policy_ids: string[] }>(
      `SELECT employee_id, category_id, array_agg(policy_id::text ORDER BY policy_id) AS policy_ids
         FROM materialized_assignments
        WHERE company_id = $1 AND employee_id = ANY($2::uuid[])
        GROUP BY employee_id, category_id`,
      [companyId, uniqueIds.slice(offset, offset + 1_000)],
    );
    for (const row of result.rows) actual.set(`${row.employee_id}:${row.category_id}`, row.policy_ids);
  }
  const mismatches: Array<{ key: string; expected: string[]; actual: string[] }> = [];
  for (const [key, expectedPolicies] of expected.assignments) {
    const actualPolicies = actual.get(key) ?? [];
    if (JSON.stringify(expectedPolicies) !== JSON.stringify(actualPolicies)) {
      mismatches.push({ key, expected: expectedPolicies, actual: actualPolicies });
      if (mismatches.length >= 100) break;
    }
  }
  return {
    mismatches,
    comparisons: expected.assignments.size,
    rulesEvaluated: expected.rulesEvaluated,
    deterministicFailures: expected.deterministicFailures,
  };
}

async function loadScopeAssignments(
  pool: DbPool,
  companyId: string,
  scopes: readonly { employeeId: string; categoryId: string }[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  for (const scope of scopes) {
    const rows = await pool.query<{ policy_id: string }>(
      `SELECT policy_id FROM materialized_assignments
        WHERE company_id = $1 AND employee_id = $2 AND category_id = $3
        ORDER BY policy_id`,
      [companyId, scope.employeeId, scope.categoryId],
    );
    result.set(`${scope.employeeId}:${scope.categoryId}`, rows.rows.map((row) => row.policy_id));
  }
  return result;
}

async function loadHardInvariantCounts(pool: DbPool, companyId: string): Promise<{
  cardinalityViolations: number;
  duplicateActiveAssignments: number;
  tenantIsolationFailures: number;
}> {
  const result = await pool.query<{
    cardinality_violations: string;
    duplicate_active_assignments: string;
    tenant_isolation_failures: string;
  }>(
    `SELECT
       (SELECT count(*) FROM (
          SELECT ma.employee_id, ma.category_id
            FROM materialized_assignments ma
            JOIN policy_categories pc ON pc.company_id = ma.company_id AND pc.id = ma.category_id
           WHERE ma.company_id = $1 AND pc.cardinality = 'SINGLE'
           GROUP BY ma.employee_id, ma.category_id HAVING count(*) > 1
        ) violations)::text AS cardinality_violations,
       (SELECT count(*) FROM (
          SELECT employee_id, policy_id
            FROM materialized_assignments
           WHERE company_id = $1
           GROUP BY employee_id, policy_id HAVING count(*) > 1
        ) duplicates)::text AS duplicate_active_assignments,
       ((SELECT count(*) FROM materialized_assignments ma
          JOIN employees e ON e.id = ma.employee_id WHERE ma.company_id <> e.company_id)
        + (SELECT count(*) FROM rule_versions rv
          JOIN rules r ON r.id = rv.rule_id WHERE rv.company_id <> r.company_id)
        + (SELECT count(*) FROM manual_overrides mo
          JOIN employees e ON e.id = mo.employee_id WHERE mo.company_id <> e.company_id))::text AS tenant_isolation_failures`,
    [companyId],
  );
  const row = result.rows[0]!;
  return {
    cardinalityViolations: Number(row.cardinality_violations),
    duplicateActiveAssignments: Number(row.duplicate_active_assignments),
    tenantIsolationFailures: Number(row.tenant_isolation_failures),
  };
}

async function writeReport(report: RegressionReport): Promise<void> {
  await writeFile(report.artifacts.json, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(report.artifacts.markdown, `${formatRegressionReport(report)}\n`, 'utf8');
}

export function formatRegressionReport(report: RegressionReport): string {
  const line = (label: string, value: string | number): string => `${label.padEnd(36)}${String(value).padStart(14)}`;
  return [
    'Policy Assignment Engine Certified Regression Evaluation',
    '',
    line('Employees:', report.employees.toLocaleString()),
    line('Evaluation rules:', report.rules.toLocaleString()),
    line('Mutations verified:', report.stateMutations.toLocaleString()),
    line('Batches verified:', report.batchesVerified.toLocaleString()),
    line('Oracle comparisons:', report.oracleComparisons.toLocaleString()),
    line('Localized batch size:', report.configuration.localizedBatchSize),
    line('Selected workers:', report.configuration.workerConcurrency),
    '',
    line('Assignment mismatches:', report.invariants.assignmentMismatches),
    line('Impact false negatives:', report.invariants.impactFalseNegatives),
    line('Cardinality violations:', report.invariants.cardinalityViolations),
    line('Determinism failures:', report.invariants.determinismFailures),
    line('Idempotency failures:', report.invariants.idempotencyFailures),
    line('Tenant isolation failures:', report.invariants.tenantIsolationFailures),
    line('Duplicate active assignments:', report.invariants.duplicateActiveAssignments),
    '',
    line('Reconciliation p50:', `${report.performance.reconciliationP50Ms} ms`),
    line('Reconciliation p95:', `${report.performance.reconciliationP95Ms} ms`),
    line('Reconciliation p99:', `${report.performance.reconciliationP99Ms} ms`),
    line('Localized mutation throughput:', `${report.performance.localizedMutationThroughputPerSecond}/s`),
    line('Affected scope throughput:', `${report.performance.affectedScopesPerSecond}/s`),
    line('Large rule-change p95:', `${report.performance.largeRuleChangeP95Ms} ms`),
    line('Temporal transition:', `${report.performance.temporalTransitionMs} ms`),
    line('Avg rules evaluated/mutation:', report.performance.averageRulesEvaluatedPerMutation),
    line('Rules actually evaluated:', report.performance.incrementalRulesEvaluated.toLocaleString()),
    line('Full-recompute rules evaluated:', report.performance.fullRecomputeRulesEvaluated.toLocaleString()),
    line('Work avoided vs full recompute:', `${report.performance.ruleEvaluationWorkAvoidedPercent}%`),
    line('Reconciliation jobs:', report.performance.reconciliationJobs.toLocaleString()),
    line('Jobs by scope:', JSON.stringify(report.performance.reconciliationJobsByScope)),
    line('Mutation runtime:', `${round(report.performance.mutationRuntimeMs / 1_000)} s`),
    line('Total eval runtime:', `${round(report.performance.totalRuntimeMs / 1_000)} s`),
  ].join('\n');
}

function nextDifferent(values: readonly string[], current: string, ordinal: number): string {
  if (values.length < 2) throw new Error('Mutation requires at least two observed values');
  const start = ordinal % values.length;
  for (let offset = 0; offset < values.length; offset += 1) {
    const value = values[(start + offset) % values.length]!;
    if (value !== current) return value;
  }
  throw new Error('No distinct observed mutation value exists');
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return round(ordered[Math.min(ordered.length - 1, Math.ceil(quantile * ordered.length) - 1)]!);
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function serializeMap(value: Map<string, string[]>): string {
  return JSON.stringify([...value.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

class RegressionMismatchError extends Error {
  constructor(message: string, readonly mismatches: Array<{ key: string; expected: string[]; actual: string[] }>) {
    super(message);
    this.name = 'RegressionMismatchError';
  }
}
