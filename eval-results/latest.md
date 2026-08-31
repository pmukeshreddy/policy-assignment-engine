Policy Assignment Engine Certified Regression Evaluation

Employees:                                  50,000
Evaluation rules:                              300
Mutations verified:                        100,000
Batches verified:                              227
Oracle comparisons:                      8,675,538
Localized batch size:                          500
Selected workers:                               12

Assignment mismatches:                           0
Impact false negatives:                          0
Cardinality violations:                          0
Determinism failures:                            0
Idempotency failures:                            0
Tenant isolation failures:                       0
Duplicate active assignments:                    0

Reconciliation p50:                      46.199 ms
Reconciliation p95:                     582.728 ms
Reconciliation p99:                      733.56 ms
Localized mutation throughput:            45.784/s
Affected scope throughput:                316.76/s
Large rule-change p95:                36629.193 ms
Temporal transition:                    3817.65 ms
Avg rules evaluated/mutation:              335.505
Rules actually evaluated:               33,550,536
Full-recompute rules evaluated:        421,438,330
Work avoided vs full recompute:            92.039%
Reconciliation jobs:                       101,269
Jobs by scope:                      {"EMPLOYEE":60824,"OVERRIDE":22440,"GROUP":16710,"TEMPORAL":1270,"RULE":21,"POLICY":4}
Mutation runtime:                       2779.814 s
Total eval runtime:                      3251.56 s
