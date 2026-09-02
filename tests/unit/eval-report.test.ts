import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MUTATION_BATCH_SIZE,
  formatRegressionReport,
  localizedReconciliationLatencies,
  type RegressionReport,
} from '../../src/eval/regression.js';

const emptyOutcome = { addOnly: 0, removeOnly: 0, replacement: 10, unchanged: 2 };
const transition = { passed: 2, total: 2, failures: [] };
const latency = { samples: 10, p50Ms: 5, p95Ms: 9, p99Ms: 12 };
const work = { incrementalRuleEvaluations: 100, equivalentFullRecomputeRuleEvaluations: 1_000, workAvoidedPercent: 90 };

describe('regression runner report', () => {
  it('presents exactly the five required headline metrics and keeps diagnostics subordinate', () => {
    expect(DEFAULT_MUTATION_BATCH_SIZE).toBe(1_000);
    const report: RegressionReport = {
      status: 'PASSED', seed: 1, dataset: { id: 'dataset', importId: 'import', checksum: 'checksum' },
      employees: 50_000, rules: 300, stateMutations: 100_000,
      headlineMetrics: {
        assignmentCorrectness: {
          assignmentSetDivergences: 0,
          totalAssignmentSetComparisons: 600_000,
          passed: true,
          correctnessGates: {
            assignmentSetDivergences: 0, impactMissesCausingAssignmentDivergence: 0,
            cardinalityViolations: 0, determinismFailures: 0, idempotencyFailures: 0,
            tenantIsolationFailures: 0, duplicateActiveAssignments: 0,
          },
        },
        businessTransitionConformance: {
          passedExpectedTransitions: 12,
          totalExpectedTransitions: 12,
          passed: true,
          byField: {
            location: transition, department: transition, employmentType: transition,
            jobTitle: transition, tenure: transition, groupMembership: transition,
          },
          mutationOutcomes: {
            location: emptyOutcome, department: emptyOutcome, employmentType: emptyOutcome,
            jobTitle: emptyOutcome, tenure: emptyOutcome, groupMembership: emptyOutcome,
          },
        },
        localizedEndToEndConvergenceLatency: {
          measurementBoundary: 'job start to materialization complete',
          overall: latency,
          byMutationClass: { employeeFact: latency, groupMembership: latency, manualOverride: latency },
        },
        populationFanOutCompletion: {
          broadestChange: {
            mutationIndex: 10, mutationKind: 'rule_create', affectedEmployees: 42_000,
            affectedScopes: 42_000, completionMs: 500, scopesPerSecond: 84_000,
          },
          changes: [],
        },
        ruleEvaluationWorkAvoided: {
          overall: work,
          byMutationClass: {
            employeeFact: work, groupMembership: work, manualOverride: work, ruleChange: work,
            policyChange: work, temporal: work, duplicateDelivery: work, other: work,
          },
        },
      },
      debug: {
        batchesVerified: 120, oracleComparisons: 600_000, localizedBatchSize: 1_000, workerConcurrency: 12,
        reconciliationP50Ms: 1, reconciliationP95Ms: 2, reconciliationP99Ms: 3,
        averageRulesEvaluatedPerMutation: 4, incrementalRulesEvaluated: 400_000,
        fullRecomputeRulesEvaluated: 30_000_000, ruleEvaluationWorkAvoidedPercent: 98.6,
        reconciliationJobs: 100_000, reconciliationJobsByScope: { EMPLOYEE: 80_000 },
        jobThroughputPerSecond: 100, localizedMutationThroughputPerSecond: 200, affectedScopesPerSecond: 500,
        largePopulationChangeP50Ms: 100, largePopulationChangeP95Ms: 200, largePopulationChangeMaxMs: 300,
        largeRuleChangeP50Ms: 80, largeRuleChangeP95Ms: 160, largeRuleChangeMaxMs: 240,
        temporalTransitionMs: 500, mutationRuntimeMs: 900, totalRuntimeMs: 1_000,
      },
      baseline: { reconciliationJobs: 1, scopesReconciled: 300_000, durationMs: 100 },
      workerCalibration: {
        selectedConcurrency: 12,
        candidates: [{ concurrency: 12, jobs: 240, scopes: 1_440, durationMs: 100, scopesPerSecond: 14_400 }],
      },
      artifacts: { json: 'latest.json', markdown: 'latest.md', batches: 'batches.jsonl' },
    };
    expect(Object.keys(report.headlineMetrics)).toEqual([
      'assignmentCorrectness',
      'businessTransitionConformance',
      'localizedEndToEndConvergenceLatency',
      'populationFanOutCompletion',
      'ruleEvaluationWorkAvoided',
    ]);
    const output = formatRegressionReport(report);
    expect(output.match(/^\d\. /gm)).toHaveLength(5);
    expect(output).toContain('1. Assignment correctness against independent oracle');
    expect(output).toContain('2. Business-transition conformance');
    expect(output).toContain('3. Localized end-to-end convergence latency');
    expect(output).toContain('4. Population fan-out completion time');
    expect(output).toContain('5. Rule-evaluation work avoided vs full recomputation');
    expect(output).toContain('Diagnostic mutation outcomes');
    expect(output).not.toContain('Localized mutation throughput:');
    expect(output).not.toContain('Total eval runtime:');
    expect(output).not.toContain('Selected workers:');
  });

  it('measures localized reconciliation work instead of verification-batch residence', () => {
    const batchResidenceMs = 60_000;
    const samples = localizedReconciliationLatencies([
      { job: { scope: 'EMPLOYEE' }, durationMs: 12, error: null },
      { job: { scope: 'GROUP' }, durationMs: 18, error: null },
      { job: { scope: 'OVERRIDE' }, durationMs: 9, error: null },
      { job: { scope: 'RULE' }, durationMs: batchResidenceMs, error: null },
    ]);
    expect(samples).toEqual({ employeeFact: [12], groupMembership: [18], manualOverride: [9] });
    expect(Object.values(samples).flat()).not.toContain(batchResidenceMs);
  });
});
