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

3. Localized end-to-end convergence latency
Overall p50 / p95 / p99:            60575.619 / 85304.018 / 96739.207 ms
   Employee fact p95:                 85313.749 ms
   Group membership p95:              85598.555 ms
   Manual override p95:               85018.372 ms

4. Population fan-out completion time
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
