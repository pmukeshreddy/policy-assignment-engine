# Policy Assignment Engine

A production-minded, generic policy assignment system built as a TypeScript modular monolith with PostgreSQL. It versions source data, incrementally reconciles only impacted employee/category scopes, materializes product reads, records complete decisions, schedules date transitions, and previews rule changes through the same evaluator and resolver used in production.

The engine has no customer-specific logic. The default reviewer product is **NYC Open Data Policy Workspace**, an isolated tenant containing the same 50,000 normalized employee facts persisted by the NYC importer. One shared baseline builder derives a fictional, internally coherent company-policy universe from those observed facts: six domains, 146 policies for the current population, and exactly 300 normal DSL rules. Product initialization and regression evaluation use identical categories, policies, priorities, cardinalities, and conditions; only tenant-local UUIDs differ. These fictional company policies are not official NYC policies or laws.

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
- Reproducible 50,000-employee NYC Open Data regression evaluation with the shared coherent 300-rule universe and 100,000 mutations

See [Architecture](docs/ARCHITECTURE.md), the [API guide](docs/API.md), and the [UX design rationale](docs/UX_DESIGN.md).

## Quick start with Docker

Prerequisites: Docker Desktop with Compose.

```bash
cp .env.example .env
docker compose up --build
```

The persisted PostgreSQL volume must already contain the 50,000-row NYC import. If it does not, run the importer once before starting the full stack. The reviewer seed never calls the NYC API:

```bash
docker compose run --rm migrate
docker compose run --rm migrate npm run data:nyc:start
docker compose up --build
```

Open <http://localhost:3000/admin/>. **NYC Open Data Policy Workspace** is the default; the API health endpoint is <http://localhost:3000/health>.

The focused product journey is: Policies (what can be assigned) → Rules (who receives them) → Employees (which facts matched) → Why (how the winner was selected) → edit impact (what changes before saving) → Audit (what happened and why). Categories live inside Policies and manual overrides live on Employee detail. Employee and rule previews call backend services that use the production evaluator/resolver—there is no browser-side rule engine.

PostgreSQL data persists in the `policy-postgres` volume. Compose runs migrations and the idempotent product seed before the API and background worker start. Seeding copies persisted `employee_import_records` set-wise into an isolated editable tenant and does not perform a network request.

## Local development

Prerequisites: Node.js 22+ and PostgreSQL 16+ (or only PostgreSQL through Compose).

```bash
docker compose up -d postgres
npm ci
cp .env.example .env
npm run db:migrate
npm run data:nyc       # once, only when PostgreSQL does not already contain the import
npm run seed:product   # offline product tenant from persisted import facts + the certified baseline
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

The large regression harness uses the official [NYC Citywide Payroll Data](https://data.cityofnewyork.us/api/v3/views/k397-673e/query.json) as employee facts. It does **not** claim that the generated fictional company-policy universe represents NYC policy. The same data-derived baseline builder initializes both product and evaluation tenants.

With PostgreSQL running and migrations applied:

```bash
npm run data:nyc
npm run eval:regression -- --seed=482901
```

`data:nyc` performs the network operation. It discovers the latest fiscal year, pages the Socrata endpoint, validates every row, and continues until exactly 50,000 usable records have been imported. `NYC_APP_TOKEN` is optional. Public `First Name`, `Last Name`, and `Mid Init` values are imported explicitly as display/search fields. Stable opaque employee IDs remain derived from the dataset ID and Socrata row identity, so names are never used for identity or deduplication. Agency, agency start date, borough, title, pay basis, leave status, payroll number, fiscal year, and numeric pay facts are normalized into the production employee/version schema.

The import records its source URL, exact SoQL query, fetch time, counts, skip reasons, dataset/fiscal-year metadata, and SHA-256 checksum in `dataset_imports`. Per-employee provenance is retained in `employee_import_records`. No downloaded JSON or imported employee records are committed to Git.

`eval:regression` is offline with respect to NYC: it refuses to run unless PostgreSQL already contains the required imported population. It deterministically builds the shared 300-rule universe and runs at least 100,000 state mutations through:

```text
Fastify mutation API → transactional outbox → ImpactAnalyzer → worker
→ ReconciliationService → PostgreSQL materialization → independent full oracle
```

Every checkpoint compares exact policy IDs. The run fails immediately and writes the seed plus executed mutation prefix if assignment sets, impact completeness, cardinality, determinism, idempotency, duplicate protection, or tenant isolation diverge. Successful human and JSON summaries are written to `eval-results/latest.md` and `eval-results/latest.json`; per-batch replay ledgers and failure artifacts remain ignored because they are large and machine-specific.

During the long randomized phase, ordinary localized employee/group mutations are drained and oracle-verified in batches of up to 1,000. Temporal advances, rule and policy configuration changes, and every other full-population fan-out mutation remain singleton checkpoints that are drained and verified immediately. This verification batch size is independent of the worker's 500-scope reconciliation transaction bound.

The primary report contains exactly five headline metrics:

1. Assignment correctness against the independent full-recompute oracle.
2. Business-transition conformance across location, department, compensation, role, tenure, and group semantics. This is checked independently of oracle agreement.
3. Localized end-to-end convergence latency from API commit until correct materialization is visible, with employee-fact, group, and manual-override breakdowns.
4. Population fan-out completion time, including a measured change affecting at least 10% of the 50,000-person population.
5. Rule-evaluation work avoided versus equivalent full recomputation, overall and by mutation class.

Cardinality, determinism, idempotency, duplicate-assignment, tenant-isolation, and impact-completeness checks are correctness gates under metric 1. Mutation add/remove/replacement/unchanged counts are diagnostic evidence under metric 2. Worker calibration, batch counts, raw evaluation counts, and total runtime remain available only in the JSON `debug` section.

Useful options:

```bash
npm run eval:regression -- --seed=482901 --mutations=1000 --allow-small # non-certifying smoke run
npm run eval:regression -- --seed=482901 --reuse-prepared              # resume an interrupted pristine baseline
```

`--reuse-prepared` is guarded: it only requeues the baseline FULL job when the imported source universe still has version 1 facts, zero manual controls, the expected 300 rules, and no unrelated active jobs. Once mutations have begun, a deterministic rebuild is required. Evaluation tenants are excluded from unscoped production workers; the runner's company-scoped worker is the only process that claims their jobs.

Evaluation tenants are excluded from `GET /companies`. `npm run seed:product` creates a separate editable product tenant from the immutable `employee_import_records.normalized_facts` baseline, copies provenance into a product-owned import record, and invokes the same `createCertifiedBaseline()` implementation used by evaluation setup. It then drains one full reconciliation job. Existing product edits are never overwritten. Normal employee edits create new versions only in the product tenant. `npm run seed:product:refresh-nyc` is the deliberate network operation that fetches the same official dataset with the source name fields and transactionally replaces only the editable product tenant; it does not reset or mutate the certified evaluation tenant.

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

The current suite contains 36 focused tests. The in-memory randomized harness runs **100 deterministic scenarios**, each with **30–60 mutations** across employee fields, groups, rule priority/state, overrides, and time. After every mutation it compares dependency-scoped materialization to an independently implemented full interpreter/resolver, then repeats the same scope to prove retry idempotency. The PostgreSQL regression command above supplies the separate 50,000-employee/100,000-mutation evidence.

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
3. Ensure the private PostgreSQL database already contains the NYC import, then review the three resources from `render.yaml` and apply the Blueprint. The web pre-deploy command runs migrations and seeds the isolated product workspace without fetching NYC.
4. Wait for both `policy-assignment-engine-web` and `policy-assignment-engine-worker` to become live.
5. Open `https://YOUR-WEB-SERVICE.onrender.com/admin/`, select **NYC Open Data Policy Workspace**, and verify `/health` returns `{ "status": "ok" }`.

`DATABASE_URL` is wired from the private database by the Blueprint. Render supplies `PORT`; the application binds `HOST=0.0.0.0`. The NYC network import is a one-time data preparation step, never an application-load path. For a production organization, place the service behind an authenticated admin gateway that authorizes the company context; `X-Company-Id` is tenant isolation, not authentication.

## Operational notes

- PostgreSQL is authoritative; API assignment reads never run the rule engine.
- Dates are UTC calendar dates with half-open intervals `[valid_from, valid_to)`.
- Important identities/keys and category cardinality are immutable through the API. A new effective-dated version changes mutable policy, rule, and employee data.
- API authentication is intentionally left to a trusted admin gateway; `X-Company-Id` provides isolation, not identity proof.
- Worker failures are visible in `/reconciliation/jobs`; errors are retried with exponential backoff and become `DEAD` after the configured maximum.
