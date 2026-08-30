# Policy Assignment Engine

A production-minded, generic policy assignment system built as a TypeScript modular monolith with PostgreSQL. It versions source data, incrementally reconciles only impacted employee/category scopes, materializes product reads, records complete decisions, schedules date transitions, and previews rule changes through the same evaluator and resolver used in production.

The demo policies are seed data only. The engine has no Warp-specific policy names or business rules.

## What is implemented

- Arbitrary employee attributes plus versioned core employee facts
- Effective-dated groups and memberships
- `SINGLE` and `MULTIPLE` policy categories
- Immutable policy and rule versions
- Validated rule AST: `AND`, `OR`, `NOT`, equality/ordering/`IN`, arbitrary attributes, groups, calendar dates, and tenure
- Cached compiled rules and persisted dependency/selector metadata
- Deterministic precedence: manual controls, priority, specificity, stable ID
- Manual `ASSIGN` and `EXCLUDE` controls
- Transactional PostgreSQL outbox/jobs with leases, heartbeats, retries, dead-letter state, and `SKIP LOCKED`
- Dependency-aware employee impact and sound mandatory-selector rule impact
- Exact date/tenure transition scheduling
- Serialized, idempotent assignment diffing and materialized current reads
- Effective-dated assignment history and first-class explanation records
- Exact rule preview through the production evaluator/resolver
- Tenant-scoped API and a small admin console at `/admin/`
- Unit, PostgreSQL integration, concurrency, temporal, API, and randomized oracle tests
- Reproducible 1k/10k/100k employee and 100/1k/5k rule benchmarks

See [Architecture](docs/ARCHITECTURE.md), [API guide](docs/API.md), and [measured benchmark output](benchmark-results/latest.md).

## Quick start with Docker

Prerequisites: Docker Desktop with Compose.

```bash
cp .env.example .env
docker compose up --build
```

In another terminal, load the generic demo scenario:

```bash
docker compose exec app node dist/scripts/seed.js
```

Open <http://localhost:3000/admin/>. The seed command prints the company UUID; select the demo company in the console. The API health endpoint is <http://localhost:3000/health>.

PostgreSQL data persists in the `policy-postgres` volume. The `migrate` container must finish successfully before the API and worker start.

## Local development

Prerequisites: Node.js 22+ and PostgreSQL 16+ (or only PostgreSQL through Compose).

```bash
docker compose up -d postgres
npm ci
cp .env.example .env
npm run db:migrate
npm run seed
npm run dev
```

Run the worker in a second terminal:

```bash
npm run worker
```

Useful commands:

```bash
npm run typecheck
npm run lint
npm test                 # unit + 100-scenario randomized harness
npm run test:integration # PostgreSQL/API suite
npm run test:all         # every test, PostgreSQL must be available
npm run benchmark        # writes benchmark-results/latest.{json,md}
npm run build
```

`npm run db:reset` refuses production databases. It only accepts a database ending in `_test`, unless `ALLOW_DATABASE_RESET=true` is set explicitly.

## Rule representation

Rules are data, never executable code. A published version identifies a policy, priority, effective interval, enabled state, content hash, specificity, and dependencies.

```json
{
  "type": "and",
  "conditions": [
    {
      "type": "comparison",
      "fact": { "kind": "employee", "field": "location" },
      "operator": "EQ",
      "value": "CA"
    },
    {
      "type": "comparison",
      "fact": { "kind": "employee", "field": "employment_type" },
      "operator": "EQ",
      "value": "full_time"
    }
  ]
}
```

Supported facts are stable employee fields, arbitrary `attributes.<key>`, group membership, `as_of_date`, and integer `tenure_days`. Missing facts do not match, including `NE`; this avoids accidentally granting a policy because data is absent.

## Resolution semantics

Matching only proposes candidates. Resolution is separate and stable:

1. Manual candidates outrank rule candidates.
2. Higher numeric priority wins.
3. More leaf predicates (specificity) wins.
4. Lexicographically smaller immutable candidate ID is the final tie-break.

A manual `EXCLUDE` competes with assignments for the same policy and can veto lower-precedence proposals. In `SINGLE`, the best remaining distinct policy wins. In `MULTIPLE`, the best proposal for every non-vetoed policy survives. Every losing candidate and reason is retained in the decision.

## API example

All tenant data routes require `X-Company-Id`.

```bash
curl -X POST http://localhost:3000/companies \
  -H 'content-type: application/json' \
  -d '{"name":"Acme"}'

curl http://localhost:3000/employees/EMPLOYEE_UUID/assignments \
  -H 'X-Company-Id: COMPANY_UUID'

curl 'http://localhost:3000/employees/EMPLOYEE_UUID/assignments/as-of?date=2026-08-01' \
  -H 'X-Company-Id: COMPANY_UUID'
```

The complete workflow and endpoint list are in [docs/API.md](docs/API.md).

## Correctness evidence

The current suite contains 20 focused tests. The randomized harness runs **100 deterministic scenarios**, each with **30–60 mutations** across employee fields, groups, rule priority/state, overrides, and time. After every mutation it compares dependency-scoped materialization to an independently implemented full interpreter/resolver, then repeats the same scope to prove retry idempotency.

The PostgreSQL suite covers exact preview, manual precedence, rejected-candidate explanations, effective-dated history stability, group impact, tenant isolation, concurrent reconciliation serialization, duplicate retry safety, and a persisted tenure transition with no source-row mutation.

Latest verified command:

```text
Test Files  5 passed (5)
Tests       20 passed (20)
```

## Measured performance

Measured on Node v24.11.0, Apple arm64, with compiled rules warm:

| Employees | Rules | Full evaluations | Full recompute | Incremental rules | Incremental p95 |
|---:|---:|---:|---:|---:|---:|
| 1,000 | 100 | 100,000 | 177.265 ms | 10 | 0.020 ms |
| 10,000 | 1,000 | 10,000,000 | 14,127.781 ms | 100 | 0.278 ms |
| 100,000 | 100 | 10,000,000 | 16,570.233 ms | 10 | 0.016 ms |
| 1,000 | 5,000 | 5,000,000 | 7,145.115 ms | 500 | 0.794 ms |

Fifty real, idempotent PostgreSQL employee/category reconciliations measured **3.185 ms p50**, **4.922 ms p95**, and **25.970 ms p99**. These are local wall-clock observations, not capacity claims. Run `npm run benchmark` on the review machine for comparable results and full JSON metadata.

## Demo scenario

`npm run seed` creates five employees, engineering/sales groups, five categories, eight policies, eight generic rules, an approaching-tenure transition, a PTO conflict, and a manual payroll exception. It drains the initial full reconciliation before returning and is idempotent by demo company name.

## Operational notes

- PostgreSQL is authoritative; API assignment reads never run the rule engine.
- Dates are UTC calendar dates with half-open intervals `[valid_from, valid_to)`.
- Important identities/keys and category cardinality are immutable through the API. A new effective-dated version changes mutable policy, rule, and employee data.
- API authentication is intentionally left to a trusted admin gateway; `X-Company-Id` provides isolation, not identity proof.
- Worker failures are visible in `/reconciliation/jobs`; errors are retried with exponential backoff and become `DEAD` after the configured maximum.
