# Policy Assignment Engine — Latest Verified Results

This reviewer summary combines the frozen 100,000-mutation certification with the accepted `optimized-targeted-v3` isolated performance measurements. The measurements are verification-harness results, not production SLOs.

| Measurement | Latest verified result |
|---|---:|
| Independent oracle | **0 mismatches across 8,669,892 assignment-set comparisons** |
| Business-transition conformance | **103 / 103 passed** |
| Isolated reconciliation latency (300 mutations) | **p50 249.663 ms / p95 507.949 ms / p99 693.981 ms** |
| 50,000-scope rule fan-out (100 work units, 16 effective workers) | **61,524.063 ms / 812.690 scopes/sec** |
| Incremental rule-evaluation work avoided | **70.416%** — 30,480,640 incremental evaluations vs. 103,030,324 equivalent full-recompute evaluations |

The [full final metrics report](final-submission-metrics.md) and [machine-readable artifact](final-submission-metrics.json) record the accepted values and their provenance. The original certification output is preserved unchanged in the [frozen certification directory](certification-100k-seed-482901-e6fa29b/).

## Frozen 100,000-mutation certification detail

The detail below is the pre-optimization coherent-universe regression output. Its correctness, transition, and avoided-work results remain canonical. Its original latency and fan-out sections are retained for provenance but have been superseded by the accepted isolated measurements above.

Policy Assignment Engine — Coherent-Universe Regression Evaluation

Employees:                                  50,000
Evaluation rules:                              300
Mutations verified:                        100,000

1. Assignment correctness against independent oracle
Assignment-set divergences:                      0
Total assignment-set comparisons:        8,669,892
Result:                                       PASS
   Correctness gates
   Cardinality violations:                       0
   Determinism failures:                         0
   Idempotency failures:                         0
   Duplicate active assignments:                 0
   Tenant isolation failures:                    0
   Impact misses with divergence:                0

2. Business-transition conformance
Expected transitions passed:             103 / 103
Result:                                       PASS
   location:                                 6 / 6
   department:                             44 / 44
   employmentType:                           4 / 4
   jobTitle:                               37 / 37
   tenure:                                   4 / 4
   groupMembership:                          8 / 8
   Diagnostic mutation outcomes from POST /employees/preview
location:                           add 1 / remove 7 / replace 16666 / same 0
department:                         add 3 / remove 176 / replace 16064 / same 44
employmentType:                     add 6 / remove 42 / replace 10971 / same 7
jobTitle:                           add 231 / remove 1006 / replace 9607 / same 391
tenure:                             add 0 / remove 0 / replace 41 / same 5551
groupMembership:                    add 12646 / remove 2200 / replace 1 / same 1863

3. Old localized end-to-end convergence latency (superseded)
Overall p50 / p95 / p99:            60575.619 / 85304.018 / 96739.207 ms
   Employee fact p95:                 85313.749 ms
   Group membership p95:              85598.555 ms
   Manual override p95:               85018.372 ms

4. Old population fan-out completion time (superseded)
Mutation:                           rule_condition_edit #95000
Affected employees:                         50,000
Affected scopes:                            50,000
Completion time:                     243834.926 ms
Completion rate:                    205.057 scopes/s

5. Rule-evaluation work avoided vs full recomputation
Overall work avoided:                      70.416%
   employeeFact:                           12.352%
   groupMembership:                        79.265%
   manualOverride:                         83.334%
   ruleChange:                             83.254%
   policyChange:                           83.444%
   temporal:                               83.333%
   duplicateDelivery:                           0%
   other:                                       0%
