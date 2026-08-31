import { describe, expect, it } from 'vitest';
import { formatRegressionReport, type RegressionReport } from '../../src/eval/regression.js';

describe('regression runner report', () => {
  it('keeps correctness and performance metrics explicit and separate', () => {
    const report: RegressionReport = {
      status: 'PASSED', seed: 1, dataset: { id: 'dataset', importId: 'import', checksum: 'checksum' },
      employees: 50_000, rules: 300, stateMutations: 100_000, batchesVerified: 220, oracleComparisons: 600_000,
      configuration: { localizedBatchSize: 500, workerConcurrency: 12 },
      invariants: { assignmentMismatches: 0, impactFalseNegatives: 0, cardinalityViolations: 0, determinismFailures: 0, idempotencyFailures: 0, tenantIsolationFailures: 0, duplicateActiveAssignments: 0 },
      performance: { reconciliationP50Ms: 1, reconciliationP95Ms: 2, reconciliationP99Ms: 3, averageRulesEvaluatedPerMutation: 4, incrementalRulesEvaluated: 400_000, fullRecomputeRulesEvaluated: 30_000_000, ruleEvaluationWorkAvoidedPercent: 98.6, reconciliationJobs: 100_000, reconciliationJobsByScope: { EMPLOYEE: 80_000 }, jobThroughputPerSecond: 100, localizedMutationThroughputPerSecond: 200, affectedScopesPerSecond: 500, largePopulationChangeP50Ms: 100, largePopulationChangeP95Ms: 200, largePopulationChangeMaxMs: 300, largeRuleChangeP50Ms: 80, largeRuleChangeP95Ms: 160, largeRuleChangeMaxMs: 240, temporalTransitionMs: 500, mutationRuntimeMs: 900, totalRuntimeMs: 1_000 },
      baseline: { reconciliationJobs: 1, scopesReconciled: 300_000, durationMs: 100 },
      workerCalibration: { selectedConcurrency: 12, candidates: [{ concurrency: 12, jobs: 240, scopes: 1_440, durationMs: 100, scopesPerSecond: 14_400 }] },
      artifacts: { json: 'latest.json', markdown: 'latest.md', batches: 'batches.jsonl' },
    };
    const output = formatRegressionReport(report);
    expect(output).toContain('Assignment mismatches:');
    expect(output).toContain('Reconciliation p95:');
    expect(output).toContain('Work avoided vs full recompute:');
  });
});
