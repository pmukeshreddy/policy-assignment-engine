# API guide

The API is JSON over HTTP. Except for company creation/listing, health, and static admin assets, tenant routes require:

```http
X-Company-Id: 4f3d…
Content-Type: application/json
```

Invalid bodies return structured `400 VALIDATION_ERROR`; cross-tenant/missing entities return `404`; effective-date conflicts return `409`; invalid references/constraints return `422`. Normal 500 responses do not expose stack traces.

## Companies

- `POST /companies` — `{ "name": "YOUR_COMPANY_NAME" }`
- `GET /companies`
- `GET /health`

## Employees

- `POST /employees`
- `GET /employees`
- `GET /employees/:id`
- `PATCH /employees/:id` — creates an immutable effective-dated version

```json
{
  "externalId": "EMPLOYEE_EXTERNAL_ID",
  "displayName": "EMPLOYEE_DISPLAY_NAME",
  "email": "EMPLOYEE_EMAIL",
  "location": "EMPLOYEE_LOCATION",
  "department": "EMPLOYEE_DEPARTMENT",
  "employmentType": "EMPLOYMENT_TYPE",
  "isManager": false,
  "hireDate": "YYYY-MM-DD",
  "attributes": {},
  "effectiveFrom": "YYYY-MM-DD"
}
```

`externalId` is a stable company-scoped identity and is not mutable. Patchable facts and each changed arbitrary-attribute key drive dependency impact.

Updates to existing employees, memberships, policies, published rule versions, and overrides cannot be backdated. Future-effective writes are accepted and their jobs remain unavailable until the effective date.

## Groups

- `POST /groups` — `{ "key": "engineering", "name": "Engineering" }`
- `GET /groups`
- `PATCH /groups/:id` — mutable display name/description; the stable key and rule dependency ID do not change
- `POST /groups/:id/members` — `{ "employeeId": "…", "effectiveFrom": "2026-08-30" }`
- `DELETE /groups/:groupId/members/:employeeId?effectiveDate=2026-09-01`

Membership intervals cannot overlap for the same employee/group.

## Policies

- `POST /policy-categories` — key, name, and `SINGLE`/`MULTIPLE`
- `GET /policy-categories`
- `PATCH /policy-categories/:id` — display name only; cardinality is immutable
- `POST /policies` — stable key/category plus first version
- `GET /policies`
- `POST /policies/:id/versions` — effective-dated name, description, enabled state, and metadata

Category membership and cardinality are immutable after creation; this keeps historical resolution semantics stable.

## Rules and preview

- `POST /rules` — create draft or publish first version
- `GET /rules` — all identities/versions
- `POST /rules/:id/versions` — create a draft; `publish: true` may publish immediately
- `POST /rules/:ruleId/versions/:versionId/publish`
- `POST /rules/preview`

Example published rule:

```json
{
  "key": "ca-full-time-compliance",
  "policyId": "POLICY_UUID",
  "priority": 20,
  "enabled": true,
  "validFrom": "2026-09-01",
  "validTo": null,
  "publish": true,
  "condition": {
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
}
```

Preview accepts the version fields plus optional `ruleId`, `asOfDate`, and `exampleLimit`. Supplying `ruleId` replaces that identity's active version in the dry run. It never writes assignments.

A rule identity is permanently scoped to one policy category. To move logic to another category, create a new rule identity; this keeps preview, impact, and historical cardinality semantics unambiguous.

## Manual controls

- `POST /manual-overrides`
- `GET /manual-overrides?employeeId=…`
- `DELETE /manual-overrides/:id` — effective revocation, not physical deletion

```json
{
  "employeeId": "EMPLOYEE_UUID",
  "policyId": "POLICY_UUID",
  "action": "ASSIGN",
  "priority": 100,
  "reason": "Approved payroll exception",
  "validFrom": "2026-08-30",
  "validTo": null
}
```

Manual precedence is above rules; priority resolves conflicts among manual controls.

## Assignment reads and explanations

- `GET /employees/:id/assignments` — materialized current state; no evaluation
- `GET /employees/:id/assignments/as-of?date=2026-08-01`
- `GET /employees/:employeeId/assignments/:assignmentId/explanation?date=2026-08-01`

The explanation response includes the exact employee snapshot, winning source/version/trace, all matched candidates, rejected competitors and reasons, decision timestamp, and next transition date.

## Reconciliation operations

- `POST /reconciliation/trigger` — queue a low-priority full-company check
- `GET /reconciliation/jobs` — latest 200 jobs with attempts/errors/timestamps

Normal source APIs already enqueue precise reconciliation transactionally. The full trigger is an operational correctness/backfill tool, not the normal mutation path.
