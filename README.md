# Policy Assignment Engine

A production-minded, generic policy assignment system built as a TypeScript modular monolith with PostgreSQL. It versions source data, incrementally reconciles only impacted employee/category scopes, materializes product reads, records complete decisions, schedules date transitions, and previews rule changes through the same evaluator and resolver used in production.

The engine has no Warp-specific policy names or business rules. For reviewer usability, local and Render startup create one clearly labelled **Policy Assignment Demo** workspace with 24 fictional employees, 6 categories, 15 policies, 15 rules, 4 groups, intentional conflicts, and 2 manual exceptions. That workspace is isolated from the 50,000-record NYC evaluation tenant and is created through the real API, job, worker, and reconciliation path.

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
- Tenant-scoped API and a production admin application at `/admin/`
- Unit, PostgreSQL integration, concurrency, temporal, API, and randomized oracle tests
- Reproducible 50,000-employee NYC Open Data regression evaluation with 300 evaluation-only rules and 100,000 mutations

See [Architecture](docs/ARCHITECTURE.md), the [API guide](docs/API.md), and the [UX design rationale](docs/UX_DESIGN.md).

## Quick start with Docker

Prerequisites: Docker Desktop with Compose.

```bash
cp .env.example .env
docker compose up --build
```

Open <http://localhost:3000/admin/>. The **Policy Assignment Demo** workspace is ready to review; the API health endpoint is <http://localhost:3000/health>.

The focused reviewer journey is: Policies (what can be assigned) → Rules (who receives them) → Employees (which facts matched) → Why (how the winner was selected) → edit impact (what changes before saving) → Audit (what happened and why). Categories live inside Policies, manual overrides live on Employee detail, and technical reconciliation records are available only inside Audit's advanced disclosure. Employee and rule previews call backend services that use the production evaluator/resolver—there is no browser-side rule engine.

PostgreSQL data persists in the `policy-postgres` volume. Compose runs migrations and the idempotent demo seed before the API and background worker start.

## Local development

Prerequisites: Node.js 22+ and PostgreSQL 16+ (or only PostgreSQL through Compose).

```bash
docker compose up -d postgres
npm ci
cp .env.example .env
npm run db:migrate
npm run seed:demo
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
npm run build
```

`npm run db:reset` refuses production databases. It only accepts a database ending in `_test`, unless `ALLOW_DATABASE_RESET=true` is set explicitly.

## NYC Open Data regression evaluation

The large regression harness uses the official [NYC Citywide Payroll Data](https://data.cityofnewyork.us/api/v3/views/k397-673e/query.json) as employee facts. It does **not** claim that its generated policy universe represents NYC policy. Policies, groups, and rules are deterministic evaluation configuration derived from observed fact distributions and are labelled `evaluationOnly` in PostgreSQL.

With PostgreSQL running and migrations applied:

```bash
npm run data:nyc
npm run eval:regression -- --seed=482901
```

`data:nyc` performs the network operation. It discovers the latest fiscal year, pages the Socrata endpoint, validates every row, and continues until exactly 50,000 usable records have been imported. `NYC_APP_TOKEN` is optional. Names are discarded; stable opaque employee IDs are derived from the dataset ID and Socrata row identity. Agency, agency start date, borough, title, pay basis, leave status, payroll number, fiscal year, and numeric pay facts are normalized into the production employee/version schema.

The import records its source URL, exact SoQL query, fetch time, counts, skip reasons, dataset/fiscal-year metadata, and SHA-256 checksum in `dataset_imports`. Per-employee provenance is retained in `employee_import_records`. No downloaded JSON or imported employee records are committed to Git.

`eval:regression` is offline with respect to NYC: it refuses to run unless PostgreSQL already contains the required imported population. It deterministically builds 300 evaluation-only rules and runs at least 100,000 state mutations through:

```text
Fastify mutation API → transactional outbox → ImpactAnalyzer → worker
→ ReconciliationService → PostgreSQL materialization → independent full oracle
```

Every checkpoint compares exact policy IDs. The run fails immediately and writes the seed plus executed mutation prefix if assignments, impact completeness, cardinality, determinism, idempotency, duplicate protection, or tenant isolation diverge. Successful human and JSON summaries are written to `eval-results/latest.md` and `eval-results/latest.json`; the latest certified summaries are committed. Per-batch replay ledgers and failure artifacts remain ignored because they are large and machine-specific.

The certified seed-`482901` run completed on 2026-08-31 against the imported dataset checksum `dbf4a9c0fea6ddea244a37ef5e6b21901b4fc714826f3f18666162a4cb687eaf`:

```text
Employees:                              50,000
Initial evaluation rules:                  300
Mutations verified:                    100,000
Validation batches:                        227
Oracle assignment-scope comparisons: 8,675,538

Assignment mismatches:                       0
Impact false negatives:                      0
SINGLE-cardinality violations:               0
Determinism failures:                        0
Idempotency failures:                        0
Duplicate active assignments:                0
Tenant-isolation failures:                   0

Reconciliation p50:                  46.199 ms
Reconciliation p95:                 582.728 ms
Reconciliation p99:                  733.56 ms
Localized mutation throughput:        45.784/s
Affected-scope throughput:             316.76/s
Large rule-change p95:             36,629.193 ms
Temporal transition:                3,817.65 ms
Rules actually evaluated:          33,550,536
Equivalent full-rule evaluations: 421,438,330
Rule-evaluation work avoided:          92.039%
Mutation runtime:                    2,779.814 s
Total evaluation runtime:             3,251.56 s
```

The runner measured 8, 12, and 16 workers locally and selected 12 (`643.343`, `950.057`, and `858.103` calibration scopes/second respectively). Reconciliation percentiles exclude deterministic setup, import, baseline materialization, calibration, and oracle time. The mutation runtime includes API writes, production job draining, oracle comparisons, and per-batch invariant checks. Four rule-create mutations intentionally leave 304 rules at the end; the certified starting universe contains 300.

Useful options:

```bash
npm run eval:regression -- --seed=482901 --mutations=1000 --allow-small # non-certifying smoke run
npm run eval:regression -- --seed=482901 --reuse-prepared              # resume an interrupted pristine baseline
```

`--reuse-prepared` is guarded: it only requeues the baseline FULL job when the imported source universe still has version 1 facts, zero manual controls, the expected 300 rules, and no unrelated active jobs. Once mutations have begun, a deterministic rebuild is required. Evaluation tenants are excluded from unscoped production workers; the runner's company-scoped worker is the only process that claims their jobs.

Evaluation tenants are also excluded from `GET /companies`, so the NYC population never appears as a normal reviewer workspace. `npm run seed:demo` is idempotent: it accepts an already-complete demo workspace and fails explicitly rather than silently repairing or overwriting a partial/customized one.

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
  -d '{"name":"YOUR_COMPANY_NAME"}'

curl http://localhost:3000/employees/EMPLOYEE_UUID/assignments \
  -H 'X-Company-Id: COMPANY_UUID'

curl 'http://localhost:3000/employees/EMPLOYEE_UUID/assignments/as-of?date=2026-08-01' \
  -H 'X-Company-Id: COMPANY_UUID'
```

The complete workflow and endpoint list are in [docs/API.md](docs/API.md).

## Correctness evidence

The current suite contains 35 focused tests. The in-memory randomized harness runs **100 deterministic scenarios**, each with **30–60 mutations** across employee fields, groups, rule priority/state, overrides, and time. After every mutation it compares dependency-scoped materialization to an independently implemented full interpreter/resolver, then repeats the same scope to prove retry idempotency. The PostgreSQL regression command above supplies the separate 50,000-employee/100,000-mutation evidence.

The PostgreSQL suite covers exact preview, manual precedence, rejected-candidate explanations, effective-dated history stability, group impact, tenant isolation, concurrent reconciliation serialization, duplicate retry safety, and a persisted tenure transition with no source-row mutation.

Latest verified command:

```text
Test Files  11 passed (11)
Tests       35 passed (35)
```

## Render deployment

[`render.yaml`](render.yaml) defines one Fastify web service (API plus static admin application), one background reconciliation worker, and one private Render PostgreSQL database. Both Node processes build from the same commit and use the same strongly typed production modules. The web service exposes `/health`; migrations run as an advisory-lock-protected pre-deploy command before each service starts.

To deploy:

1. Push this repository to GitHub.
2. In Render, choose **New → Blueprint** and select the repository.
3. Review the three resources from `render.yaml` and apply the Blueprint. The web pre-deploy command runs migrations and seeds the reviewer workspace.
4. Wait for both `policy-assignment-engine-web` and `policy-assignment-engine-worker` to become live.
5. Open `https://YOUR-WEB-SERVICE.onrender.com/admin/`, select **Policy Assignment Demo**, and verify `/health` returns `{ "status": "ok" }`.

`DATABASE_URL` is wired from the private database by the Blueprint. Render supplies `PORT`; the application binds `HOST=0.0.0.0`. No NYC token or imported evaluation population is required for the reviewer product flow. For a production organization, place the service behind an authenticated admin gateway that authorizes the company context; `X-Company-Id` is tenant isolation, not authentication.

## Operational notes

- PostgreSQL is authoritative; API assignment reads never run the rule engine.
- Dates are UTC calendar dates with half-open intervals `[valid_from, valid_to)`.
- Important identities/keys and category cardinality are immutable through the API. A new effective-dated version changes mutable policy, rule, and employee data.
- API authentication is intentionally left to a trusted admin gateway; `X-Company-Id` provides isolation, not identity proof.
- Worker failures are visible in `/reconciliation/jobs`; errors are retried with exponential backoff and become `DEAD` after the configured maximum.
