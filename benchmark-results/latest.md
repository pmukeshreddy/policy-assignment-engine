# Measured benchmark results

Generated 2026-08-30T04:57:20.865Z on v24.11.0 (darwin/arm64). Times are wall-clock measurements, not estimates.

| Employees | Rules | Full rule evaluations | Full ms | Incremental rules | p50 ms | p95 ms | p99 ms |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1,000 | 100 | 100,000 | 177.265 | 10 | 0.015 | 0.02 | 0.051 |
| 10,000 | 1,000 | 10,000,000 | 14127.781 | 100 | 0.127 | 0.278 | 0.784 |
| 100,000 | 100 | 10,000,000 | 16570.233 | 10 | 0.015 | 0.016 | 0.017 |
| 1,000 | 5,000 | 5,000,000 | 7145.115 | 500 | 0.61 | 0.794 | 0.901 |

Every incremental sample changes one employee's location and evaluates only the dependency-affected category. The full path evaluates every rule for every employee through the same compiled evaluator and conflict resolver. Compiled rules are warm, matching the steady-state worker.

PostgreSQL transaction benchmark: `{"executed":true,"samples":50,"workload":"idempotent employee/category reconciliation through PostgreSQL transaction","p50Ms":3.185,"p95Ms":4.922,"p99Ms":25.97}`.
