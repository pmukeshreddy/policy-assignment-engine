# Policy Assignment Engine

## Project overview

The Policy Assignment Engine turns continuously changing employee and company state into deterministic, effective-dated policy assignments. Employee facts, group memberships, policy and rule versions, manual controls, and calendar boundaries are written as source state; PostgreSQL-backed reconciliation jobs reduce each change to the affected `(employee, policy category)` scopes and converge those scopes independently.

The core is a structured rule AST/compiler, dependency-driven impact analysis, deterministic `SINGLE`/`MULTIPLE` conflict resolution, and desired-vs-current minimal-diff reconciliation. Current assignments are materialized for reads while dated source versions, assignment history, decision snapshots, matched candidates, condition traces, and rejection reasons preserve the evidence behind each result.

Temporal transitions are scheduled rather than discovered by population-wide sweeps. Transactional job creation, dedupe keys, leases, ordered advisory locks, decision fingerprints, and retries provide idempotency and failure recovery; terminal `DEAD` state exposes jobs that exhaust retry attempts. The repository packages the engine as a TypeScript modular monolith with a Fastify API/admin UI, a background worker, PostgreSQL, an NYC Open Data evaluation workspace, and independent-oracle verification. The separately submitted PDF contains the deeper design argument; this README is the implementation and reviewer guide.

## What is actually implemented

| Area | Implementation |
|---|---|
| Source state | Company-scoped employees with effective-dated versions and arbitrary attributes; dated group memberships, policy versions, published rule windows, and manual `ASSIGN`/`EXCLUDE` controls |
| Rules | Zod-validated recursive AST, compilation cache, SHA-256 content hash, specificity, dependencies, safe mandatory selectors, evaluation traces, and exact backend previews |
| Impact | Changed employee keys map to dependent categories; group changes map through exact group dependencies; rule changes union old/new selector populations; policy changes include current assignees and candidate populations; overrides and temporal events target one employee/category |
| Resolution | Candidate generation is separate from stable precedence and `SINGLE`/`MULTIPLE` cardinality enforcement |
| Reconciliation | Per-scope advisory locking, input-fingerprint decision reuse, desired-vs-current inserts/deletes only, materialized current state, effective-dated assignment history, and scheduled transitions |
| Jobs and recovery | Source mutation plus job insertion in one SQL transaction; `SKIP LOCKED` claims, leases/heartbeats, exponential retry, dedupe keys, error retention, and terminal `DEAD` jobs |
| Broad rule changes | Rule impacts over 500 scopes become durable 500-scope child jobs that can be claimed by multiple workers; the parent completes only after every child succeeds |
| Product surface | Tenant-scoped JSON API, server-backed rule/employee/manual-control previews, assignment/explanation endpoints, and a static admin application at `/admin/` |
| Verification | Unit/property tests, PostgreSQL integration tests, a 50,000-employee/100,000-mutation independent-oracle regression, and an isolated latency/fan-out benchmark |

### Where the code lives

For the main execution path, follow [API source writes](src/api/app.ts) → [durable jobs](src/services/jobs.ts) → [worker processing](src/services/worker.ts) → [impact analysis](src/services/impact.ts) → [reconciliation](src/services/reconciliation.ts) → [evaluation](src/services/evaluation.ts) → [deterministic resolution](src/domain/resolution.ts). `reconciliation.ts` is the central desired-vs-current loop: it evaluates an affected employee/category scope, persists decision evidence, applies the assignment diff, updates history, and schedules the next transition.

| Review area | Primary files |
|---|---|
| Process entry points | [API server](src/server.ts), [background worker](src/worker-main.ts) |
| HTTP API and validation | [routes](src/api/app.ts), [request schemas](src/api/schemas.ts), [route helpers](src/api/helpers.ts) |
| Rule AST and compiler | [rules.ts](src/domain/rules.ts) |
| Evaluation and precedence | [evaluation.ts](src/services/evaluation.ts), [resolution.ts](src/domain/resolution.ts) |
| Incremental impact and reconciliation | [impact.ts](src/services/impact.ts), [reconciliation.ts](src/services/reconciliation.ts) |
| Durable job lifecycle | [jobs.ts](src/services/jobs.ts), [worker.ts](src/services/worker.ts) |
| Persistence and database model | [repository.ts](src/services/repository.ts), [base schema](migrations/0001_initial.sql), [subsequent migrations](migrations/) |
| Admin UI | [index.html](public/index.html), [app.js](public/app.js), [styles.css](public/styles.css) |
| NYC workspace and generated policy universe | [NYC importer](scripts/import-nyc.ts), [product seed](scripts/seed-product.ts), [universe generator](src/baseline/coherent-universe.ts) |
| Verification harness | [independent oracle](src/eval/oracle.ts), [regression runner](src/eval/regression.ts), [performance benchmark](scripts/benchmark-production-performance.ts), [tests](tests/) |

The implementation does **not** include authentication/authorization, a dedicated message broker, distributed caches, or partitioned decision-history tables. `X-Company-Id` enforces data scoping but is not identity proof. Those are deployment or future-scaling concerns, not features claimed by this repository. An explicit full-company reconciliation endpoint exists for initialization, repair, and backfill; it is not the normal mutation path.

## Reviewer quick start

### Docker: shortest path to the reviewer workspace

Prerequisite: Docker Desktop with Compose. The first startup needs a one-time network import because imported employee data is not committed.

```bash
cp .env.example .env
docker compose build
docker compose up -d postgres
docker compose run --rm migrate
docker compose run --rm migrate npm run data:nyc:start
docker compose up
```

The final command runs migrations and the idempotent product seed before starting the API and worker. Open <http://localhost:3000/admin/> and select **NYC Open Data Policy Workspace**. The database-backed health check is <http://localhost:3000/health>. On later starts, while the `policy-postgres` volume still contains the import, `docker compose up --build` is sufficient.

A useful five-minute review path is:

```text
Policies → Rules → Employees → Why? → preview an employee/rule edit → Audit
```

Employee and rule previews call backend services using the same evaluator and resolver as reconciliation; there is no browser-side rule engine.

### Local development

Prerequisites: Node.js 22+ and PostgreSQL 16+; Compose can provide PostgreSQL.

```bash
cp .env.example .env
npm ci
docker compose up -d postgres
npm run db:migrate
npm run data:nyc       # once per empty database; performs the network fetch
npm run seed:product   # offline copy + generated policy universe + initial reconciliation
npm run dev
```

Run the worker in a second terminal so subsequent mutations reconcile:

```bash
npm run worker
```

### Tests and static checks

The currently verified non-PostgreSQL path is explicit because the `npm test` script's unquoted glob changes test selection under shell expansion:

```bash
npx vitest run tests/unit tests/property  # 11 files, 36 tests
npm run typecheck
npm run lint
npm run build
```

The repository's full database commands are:

```bash
npm run test:integration
npm run test:all
```

Use a dedicated migrated database via `TEST_DATABASE_URL` when running them. As of 2026-09-03, the integration suite runs 22 tests: 21 pass and one assertion injects a `2026-09-01` application clock, expects `available_at` on `2026-09-02`, and receives PostgreSQL's current `2026-09-03` because job insertion uses `GREATEST(now(), requested_date)`. This README-only review leaves that date-sensitive test and the scheduling implementation unchanged.

### Data, regression, and benchmark commands

With PostgreSQL running and migrations applied:

```bash
npm run data:nyc
npm run seed:product
npm run eval:regression -- --seed=482901
npm run benchmark:production-performance -- --samples-per-type=50 --label=reviewer
```

`eval:regression` defaults to the certifying 100,000 mutations and does not call NYC during the run. For a non-certifying smoke check:

```bash
npm run eval:regression -- --seed=482901 --mutations=1000 --allow-small
```

The regression writes `eval-results/latest.json` and `eval-results/latest.md`; the benchmark writes JSON and Markdown under `artifacts/performance/` and deletes its disposable tenant unless `--keep-tenant` is supplied.

## One concrete end-to-end example

The seeded NYC workspace actually generates the following published rule, `compensation-employment-status-per-annum-active-5872ea74`, at priority `280`. It targets the `Per Annum Compensation Program` policy in the `SINGLE` category `compensation-program`:

```json
{
  "type": "and",
  "conditions": [
    {
      "type": "comparison",
      "fact": { "kind": "employee", "field": "employment_type" },
      "operator": "EQ",
      "value": "per Annum"
    },
    {
      "type": "comparison",
      "fact": { "kind": "attribute", "key": "employment_status" },
      "operator": "EQ",
      "value": "ACTIVE"
    }
  ]
}
```

For an anonymized employee snapshot with `employment_type = "per Annum"`, `attributes.pay_basis = "per Annum"`, and `attributes.employment_status = "ACTIVE"`, the flow is:

```text
effective employee facts
  → the rule above matches (priority 280, specificity 2)
  → two other generated rules also propose the same policy:
      employment_type = "per Annum" (priority 400, specificity 1)
      attributes.pay_basis = "per Annum" (priority 320, specificity 1)
  → candidates are grouped by policy; priority 400 controls that policy
  → SINGLE resolution retains Per Annum Compensation Program
  → desired {Per Annum Compensation Program} is diffed against current state
  → an empty scope gets one assignment/history insert; an unchanged retry gets no assignment write
  → the decision stores the snapshot, all matched candidates, the winner,
    rejected duplicate proposals and reasons, traces, fingerprint, and next transition
```

Priority is evaluated before specificity, which is why the priority-400 one-leaf rule controls the same-policy proposals. This example uses generated configuration and observed field values from the local workspace; it is not an NYC policy statement and does not expose an employee identity.

## NYC Open Data evaluation workspace

The employee source is NYC Open Data's [Citywide Payroll Data](https://data.cityofnewyork.us/api/v3/views/k397-673e/query.json), dataset `k397-673e`. `npm run data:nyc` discovers the latest fiscal year, pages the Socrata endpoint in `:id` order, validates each row, skips malformed rows with counted reasons, and continues until it has **exactly 50,000 usable normalized employee records**; it fails if that target cannot be met. `NYC_APP_TOKEN` is optional.

The importer maps source fields as follows:

| Citywide Payroll source | Engine field |
|---|---|
| `:id` plus dataset ID | Stable opaque hashed `external_id`; names are not used for identity or deduplication |
| `first_name`, `last_name`, `mid_init` | Source-name/display fields |
| `agency_name` | `department` |
| `agency_start_date` | `hire_date` |
| `work_location_borough` | `location` |
| `pay_basis` | `employment_type` and `attributes.pay_basis` |
| `title_description` | `attributes.job_title` |
| `leave_status_as_of_june_30` | `attributes.employment_status` |
| `payroll_number`, `fiscal_year` | `attributes.payroll_number`, `attributes.fiscal_year` |
| `base_salary`, `regular_hours`, `regular_gross_paid` | Same-named numeric attributes when present |
| `ot_hours`, `total_ot_paid`, `total_other_pay` | `attributes.overtime_hours`, `attributes.overtime_paid`, `attributes.other_pay` when present |

`dataset_imports` retains the source URL, exact SoQL query template, fetch/completion times, row counts, skip reasons, fiscal-year metadata, and a SHA-256 population checksum. `employee_import_records` retains source-row identity, per-record checksum, and normalized facts. No downloaded payroll JSON or imported employee rows are committed to Git.

This source provides a broad, irregular population across agencies, boroughs, titles, pay bases, employment statuses, pay values, and tenure. It is useful for exercising large rule populations, narrow employee changes, selector-based rule impact, temporal changes, and broad fan-out without generating uniform toy employees.

The policy configuration is entirely **fictional and synthetic**. It is not official NYC policy, law, eligibility guidance, or a claim about any employee. `createCertifiedBaseline()` derives six demonstration categories from observed fact distributions, creates eight cohort groups from the largest observed departments, and generates exactly 50 structured rules per category—**300 rules total**. For the frozen 50,000-row dataset the builder produced 146 policies. Product seeding and regression setup call the same builder; only tenant-local UUID namespaces differ.

`npm run seed:product` performs no network request. It copies the persisted normalized facts and provenance into a separate editable product tenant, builds the synthetic configuration, and drains the initial reconciliation job. `npm run seed:product:refresh-nyc` is the deliberate network-enabled path that replaces only the product workspace; normal product edits do not mutate the isolated evaluation tenant.

## Architecture and execution flow

The API and worker are separate processes over one PostgreSQL database but share the same domain and service modules:

```text
source change
  → effective-dated/versioned write + reconciliation job in one transaction
  → dependency and selector impact analysis
  → affected (employee, category) scopes
  → as-of employee/group/policy/rule/manual-control snapshot
  → compiled rule evaluation and matched candidates
  → deterministic resolution
  → desired-vs-current minimal diff under a per-scope advisory lock
  → materialized assignments + assignment history + decision evidence
  → replacement of future scheduled transitions for that scope
```

Current assignment reads use `materialized_assignments`; they do not execute rules. See [Architecture](docs/ARCHITECTURE.md) for the schema, transaction boundaries, indexes, and concurrency discussion, and [API guide](docs/API.md) for endpoint payloads.

## Incremental reconciliation

Incremental reconciliation is the normal execution model. Each source mutation writes a typed job payload, and impact analysis conservatively narrows work without omitting a scope that might change:

- Changed stable employee fields and `attributes.<key>` values select only categories whose published rules depend on those keys for that employee.
- A membership change selects categories whose rules depend on that exact group for that employee.
- A published rule version unions the previous and new category/selector populations, covering employees entering or leaving the selector. If no logically safe mandatory selector exists, that rule's category falls back to all active employees.
- A policy version selects current assignees plus selector populations for published rules targeting that policy.
- A manual assignment, exclusion, or revocation targets its exact employee/category.
- A due rule/override/tenure/calendar boundary targets its scheduled employee/category.
- A broad rule change becomes independently claimable 500-scope child jobs; each child still reconciles scopes in transactions of at most 500.

For every affected scope, reconciliation recomputes desired state from the effective snapshot without trusting the current assignment. It then inserts missing policies, removes stale policies, closes or deletes only the corresponding history intervals, and leaves unchanged assignment rows untouched. Replaying the scope therefore converges independently and produces an empty assignment diff when state is already correct.

## Rule engine

Rules are structured data, never arbitrary executable code. The recursive AST supports:

- `and`, `or`, and `not` nodes;
- comparisons with `EQ`, `NE`, `GT`, `GTE`, `LT`, `LTE`, `IN`, and `NOT_IN`;
- stable employee facts: `external_id`, `email`, `location`, `department`, `employment_type`, `is_manager`, and `hire_date`;
- arbitrary `attributes.<key>` facts;
- `tenure_days` and `as_of_date`; and
- group `MEMBER_OF` / `NOT_MEMBER_OF` nodes.

Missing facts do not match, including negative operators. Compilation validates the AST, canonicalizes and hashes content, counts leaf predicates as specificity, extracts field/attribute/group/time dependencies, and marks only logically safe positive equality/`IN`/membership selectors as mandatory. For `OR`, a selector is mandatory only when it appears in every branch; selectors under `NOT` never narrow impact.

Compiled rules are cached by immutable rule-version ID and checked against the stored content hash. Persisted dependencies drive impact analysis. Reconciliation, rule preview, employee preview, and manual-control preview reuse the same evaluator/resolver; its matched-candidate traces are then persisted for explanation reads.

## Deterministic resolution

Matching rules and active manual controls first produce candidates. Candidates are ordered by the implemented tuple:

```text
manual before rule
→ priority DESC
→ specificity DESC
→ candidate_id ASC
→ policy_id ASC
```

Resolution first chooses the controlling candidate for each distinct policy. If that candidate is a manual `EXCLUDE`, the policy is vetoed and the exclusion plus losing proposals are recorded as rejected evidence.

- `SINGLE`: sort the remaining per-policy winners by the same tuple and retain zero or one policy.
- `MULTIPLE`: retain one winning proposal for every non-vetoed distinct policy.

Manual candidates therefore outrank rule candidates even when their numeric priority is lower. Priority is the deliberate business-order control; specificity—the number of leaf predicates—breaks equal-priority ties, followed by immutable candidate IDs. Because evaluation and resolution explicitly sort stable identifiers, identical effective inputs produce identical winners regardless of SQL row order, input order, or worker timing.

## Effective dating, auditability, and “Why?”

The engine uses UTC calendar dates and half-open intervals `[valid_from, valid_to)`. Employee and policy facts are versioned; group memberships, rule versions, manual controls, and assignment history are dated. PostgreSQL exclusion constraints prevent overlapping employee versions, memberships, and assignment-history intervals. The current mutation API intentionally rejects backdated changes to existing identities.

Every evaluated employee/category scope has an `assignment_decisions` record or reuses one with the same as-of date and input fingerprint. A new record stores:

- the employee-version ID and complete effective snapshot, including sorted group IDs;
- the as-of date, input fingerprint, decision time, and source reconciliation-job ID;
- every matched rule/manual candidate;
- winning and rejected candidates, priority, specificity, rule-version or override IDs, winner references, and rejection reasons;
- condition paths plus actual/operator/expected/matched trace values for matched rule candidates; and
- the next computed transition date.

`assignment_history` identifies which decision opened each assignment interval. For “Why does employee X have policy Y as of date Z?”, the as-of endpoint resolves the assignment interval at `Z`; given that assignment ID, the explanation endpoint loads the latest decision at or before `Z` whose winner set contains the policy. The response enriches stored policy/rule IDs with dated names and keys and returns the employee snapshot, winning source, competing candidates, summary, and next transition. Non-matching rule evaluations are not persisted as candidates.

## Verification and measured results

The production-oriented verification harness uses the imported 50,000-employee population, the shared six-category/300-rule synthetic universe, normal mutation APIs and jobs, and an independently implemented full interpreter/resolver. These are reproducible engineering measurements, not production SLOs.

| Measurement | Verified result | What it means |
|---|---:|---|
| Independent oracle | **0 mismatches across 8,669,892 assignment-set comparisons** | The frozen 100,000-mutation regression found no materialized assignment divergence from the independent full oracle. |
| Rule-quality/business-transition checks | **103 / 103** | Expected transitions passed across location, department, employment/compensation, job role, tenure, and group membership. |
| Isolated reconciliation latency | **p50 249.663 ms / p95 507.949 ms / p99 693.981 ms** | Across 300 isolated normal API mutations, this measures durable job commit through visible assignment materialization and successful job completion; batch residence and oracle time are excluded. |
| 50,000-scope rule fan-out | **61,524.063 ms / 812.690 scopes/sec** | One rule change completed 100 durable 500-scope work units using 16 effective workers. |
| Incremental work avoided | **70.416%** | The frozen regression executed 30,480,640 rule evaluations instead of 103,030,324 for equivalent full recomputation. |

The committed [latest verified results](eval-results/latest.md) and [machine-readable artifact](eval-results/latest.json) combine the accepted isolated latency and fan-out measurements with the frozen 100,000-mutation correctness, transition-conformance, and avoided-work results.

The regression also gates cardinality, determinism, retry idempotency, duplicate active assignments, tenant isolation, and impact completeness. It fails on divergence and records the seed plus executed mutation prefix for replay. Localized employee, group, manual-control, and duplicate-delivery mutations are oracle-checked in batches of at most 1,000; temporal, rule, and policy fan-outs are singleton checkpoints. That verification batch size is independent of the worker's 500-scope reconciliation transaction bound.

## Tradeoffs and boundaries

- **Materialized reads vs. reconciliation writes:** assignment reads are simple PostgreSQL queries, but source changes converge asynchronously through jobs rather than evaluating rules in the request.
- **PostgreSQL coordination vs. a broker:** the database atomically owns source state, jobs, claims, locks, decisions, and assignments, reducing coordination components while placing queue/load responsibility on PostgreSQL.
- **Precise scheduling vs. sweeps:** persisted rule, override, tenure, and calendar transitions avoid population-wide polling, at the cost of maintaining future schedule rows per affected scope.
- **Bounded fan-out vs. globally atomic visibility:** broad rule changes make progress through independently committed partitions, so a very broad change has a temporary convergence window; the measured 50,000-scope run took 61,524.063 ms.
- **Calendar-day semantics:** the model resolves one final state per UTC date rather than intraday effective timestamps.

Operational failures and retry counts are visible through `GET /reconciliation/jobs`. `npm run db:reset` refuses production databases and, unless `ALLOW_DATABASE_RESET=true`, accepts only database names ending in `_test`.
