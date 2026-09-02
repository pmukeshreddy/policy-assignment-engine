import { createHash } from 'node:crypto';
import type { DbClient, DbPool } from '../db.js';
import { inTransaction } from '../db.js';
import { enqueueJob } from '../services/jobs.js';

export const NYC_DATASET_ID = 'k397-673e';
export const NYC_DATASET_URL = `https://data.cityofnewyork.us/api/v3/views/${NYC_DATASET_ID}/query.json`;
export const NYC_EVALUATION_TENANT_KEY = 'nyc-open-data-regression';
export const NYC_IMPORT_COUNT = 50_000;

const selectedColumns = [
  'fiscal_year',
  'payroll_number',
  'agency_name',
  'last_name',
  'first_name',
  'mid_init',
  'agency_start_date',
  'work_location_borough',
  'title_description',
  'leave_status_as_of_june_30',
  'base_salary',
  'pay_basis',
  'regular_hours',
  'regular_gross_paid',
  'ot_hours',
  'total_ot_paid',
  'total_other_pay',
  ':id',
] as const;

export interface NormalizedNycEmployee {
  sourceRowId: string;
  sourceRecordChecksum: string;
  externalId: string;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  middleInitial: string | null;
  location: string;
  department: string;
  employmentType: string;
  hireDate: string;
  attributes: Record<string, string | number>;
}

export interface NycFetchResult {
  employees: NormalizedNycEmployee[];
  fiscalYear: string;
  fetchedAt: string;
  fetchedRows: number;
  skippedRows: number;
  skippedReasons: Record<string, number>;
  sourceQuery: string;
  checksum: string;
}

export interface NycImportResult extends Omit<NycFetchResult, 'employees'> {
  companyId: string;
  importId: string;
  importedRows: number;
  reconciliationJobId: string;
}

export interface NycNameBackfillResult {
  employeesMatched: number;
  employeesNamed: number;
  versionsUpdated: number;
}

export interface NycFetchOptions {
  targetCount?: number;
  pageSize?: number;
  appToken?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  maxAttempts?: number;
}

export async function fetchNycEmployees(options: NycFetchOptions = {}): Promise<NycFetchResult> {
  const targetCount = options.targetCount ?? NYC_IMPORT_COUNT;
  const pageSize = options.pageSize ?? 5_000;
  if (!Number.isInteger(targetCount) || targetCount < 1) throw new Error('NYC import target count must be a positive integer');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50_000) {
    throw new Error('NYC import page size must be an integer between 1 and 50,000');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxAttempts = options.maxAttempts ?? 5;
  const latest = await fetchRows(
    'SELECT max(fiscal_year) AS latest_fiscal_year',
    { fetchImpl, maxAttempts, ...(options.appToken === undefined ? {} : { appToken: options.appToken }) },
  );
  const fiscalYearValue = latest[0]?.['latest_fiscal_year'];
  if (typeof fiscalYearValue !== 'string' || !/^\d{4}$/.test(fiscalYearValue)) {
    throw new Error('NYC dataset did not return a valid latest fiscal year');
  }

  const employees: NormalizedNycEmployee[] = [];
  const seenSourceRows = new Set<string>();
  const skippedReasons = new Map<string, number>();
  let fetchedRows = 0;
  let offset = 0;
  const queryPrefix = `SELECT ${selectedColumns.join(', ')} WHERE fiscal_year = '${fiscalYearValue}' ORDER BY :id`;
  while (employees.length < targetCount) {
    const remaining = targetCount - employees.length;
    const limit = Math.min(pageSize, remaining);
    const query = `${queryPrefix} LIMIT ${limit} OFFSET ${offset}`;
    const rows = await fetchRows(query, {
      fetchImpl,
      maxAttempts,
      ...(options.appToken === undefined ? {} : { appToken: options.appToken }),
    });
    if (rows.length === 0) break;
    fetchedRows += rows.length;
    offset += rows.length;
    for (const row of rows) {
      const normalized = normalizeNycRow(row);
      if (!normalized.ok) {
        skippedReasons.set(normalized.reason, (skippedReasons.get(normalized.reason) ?? 0) + 1);
        continue;
      }
      if (seenSourceRows.has(normalized.employee.sourceRowId)) {
        const reason = 'duplicate_source_row_id';
        skippedReasons.set(reason, (skippedReasons.get(reason) ?? 0) + 1);
        continue;
      }
      seenSourceRows.add(normalized.employee.sourceRowId);
      employees.push(normalized.employee);
    }
    if (rows.length < limit) break;
  }
  if (employees.length !== targetCount) {
    throw new Error(
      `NYC dataset yielded ${employees.length.toLocaleString()} usable rows after fetching ${fetchedRows.toLocaleString()}; expected exactly ${targetCount.toLocaleString()}`,
    );
  }
  const fetchedAt = (options.now ?? (() => new Date()))().toISOString();
  const checksum = sha256(employees.map((employee) => employee.sourceRecordChecksum).join('\n'));
  return {
    employees,
    fiscalYear: fiscalYearValue,
    fetchedAt,
    fetchedRows,
    skippedRows: fetchedRows - employees.length,
    skippedReasons: Object.fromEntries([...skippedReasons.entries()].sort(([left], [right]) => left.localeCompare(right))),
    sourceQuery: `${queryPrefix} LIMIT <page-size> OFFSET <offset>`,
    checksum,
  };
}

export function normalizeNycRow(row: Record<string, unknown>):
  | { ok: true; employee: NormalizedNycEmployee }
  | { ok: false; reason: string } {
  const sourceRowId = requiredText(row[':id'], 200);
  if (sourceRowId === null) return { ok: false, reason: 'missing_source_row_id' };
  const fiscalYear = requiredText(row['fiscal_year'], 4);
  if (fiscalYear === null || !/^\d{4}$/.test(fiscalYear)) return { ok: false, reason: 'invalid_fiscal_year' };
  const department = requiredText(row['agency_name'], 200);
  if (department === null) return { ok: false, reason: 'missing_agency' };
  const firstName = optionalName(row['first_name'], 200);
  const lastName = optionalName(row['last_name'], 200);
  const middleInitial = optionalName(row['mid_init'], 50);
  const hireDate = parseDate(row['agency_start_date']);
  if (hireDate === null) return { ok: false, reason: 'invalid_agency_start_date' };
  const location = requiredText(row['work_location_borough'], 200);
  if (location === null) return { ok: false, reason: 'missing_work_location_borough' };
  const jobTitle = requiredText(row['title_description'], 500);
  if (jobTitle === null) return { ok: false, reason: 'missing_title_description' };
  const payBasis = requiredText(row['pay_basis'], 200);
  if (payBasis === null) return { ok: false, reason: 'missing_pay_basis' };
  const employmentStatus = requiredText(row['leave_status_as_of_june_30'], 200);
  if (employmentStatus === null) return { ok: false, reason: 'missing_leave_status' };
  const payrollNumber = requiredText(row['payroll_number'], 100);
  if (payrollNumber === null) return { ok: false, reason: 'missing_payroll_number' };

  const identityHash = sha256(`${NYC_DATASET_ID}:${sourceRowId}`);
  const attributes: Record<string, string | number> = {
    job_title: jobTitle,
    employment_status: employmentStatus,
    pay_basis: payBasis,
    fiscal_year: Number(fiscalYear),
    payroll_number: payrollNumber,
    source_dataset_id: NYC_DATASET_ID,
  };
  for (const [source, target] of [
    ['base_salary', 'base_salary'],
    ['regular_hours', 'regular_hours'],
    ['regular_gross_paid', 'regular_gross_paid'],
    ['ot_hours', 'overtime_hours'],
    ['total_ot_paid', 'overtime_paid'],
    ['total_other_pay', 'other_pay'],
  ] as const) {
    const parsed = optionalNumber(row[source]);
    if (parsed !== null) attributes[target] = parsed;
  }
  const canonical = {
    sourceRowId,
    fiscalYear,
    payrollNumber,
    firstName,
    lastName,
    middleInitial,
    department,
    hireDate,
    location,
    jobTitle,
    payBasis,
    employmentStatus,
    attributes,
  };
  return {
    ok: true,
    employee: {
      sourceRowId,
      sourceRecordChecksum: sha256(stableJson(canonical)),
      externalId: `nyc-${identityHash.slice(0, 40)}`,
      displayName: firstName !== null && lastName !== null
        ? [firstName, middleInitial, lastName].filter((value): value is string => value !== null).join(' ')
        : `Record ${identityHash.slice(0, 12).toLocaleUpperCase('en-US')}`,
      firstName,
      lastName,
      middleInitial,
      location,
      department,
      employmentType: payBasis,
      hireDate,
      attributes,
    },
  };
}

export async function importNycEmployees(pool: DbPool, fetched: NycFetchResult): Promise<NycImportResult> {
  if (fetched.employees.length < 1) throw new Error('Cannot import an empty NYC employee population');
  return inTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
      'evaluation-dataset-import',
      NYC_DATASET_ID,
    ]);
    const companyId = await evaluationCompanyId(client);
    await resetEvaluationTenant(client, companyId);
    const persisted = await persistNycEmployeeImport(client, companyId, fetched, {
      createdBy: 'nyc-open-data-importer',
      purpose: 'evaluation-source',
      enqueueReconciliation: true,
    });
    if (persisted.reconciliationJobId === null) throw new Error('Evaluation import did not enqueue reconciliation');
    return {
      companyId,
      importId: persisted.importId,
      reconciliationJobId: persisted.reconciliationJobId,
      fiscalYear: fetched.fiscalYear,
      fetchedAt: fetched.fetchedAt,
      fetchedRows: fetched.fetchedRows,
      importedRows: fetched.employees.length,
      skippedRows: fetched.skippedRows,
      skippedReasons: fetched.skippedReasons,
      sourceQuery: fetched.sourceQuery,
      checksum: fetched.checksum,
    };
  });
}

export async function persistNycEmployeeImport(
  client: DbClient,
  companyId: string,
  fetched: NycFetchResult,
  options: { createdBy: string; purpose: string; enqueueReconciliation: boolean },
): Promise<{ importId: string; reconciliationJobId: string | null }> {
    if (fetched.employees.length < 1) throw new Error('Cannot import an empty NYC employee population');
    const importResult = await client.query<{ id: string }>(
      `INSERT INTO dataset_imports
         (company_id, dataset_id, source_url, source_query, fetched_at, requested_rows,
          fetched_rows, imported_rows, skipped_rows, checksum, skipped_reasons, metadata)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb)
       RETURNING id`,
      [
        companyId,
        NYC_DATASET_ID,
        NYC_DATASET_URL,
        fetched.sourceQuery,
        fetched.fetchedAt,
        fetched.employees.length,
        fetched.fetchedRows,
        fetched.employees.length,
        fetched.skippedRows,
        fetched.checksum,
        JSON.stringify(fetched.skippedReasons),
        JSON.stringify({
          fiscalYear: fetched.fiscalYear,
          purpose: options.purpose,
          identifiers: 'sha256(dataset_id + Socrata row id); stable source identity is independent of employee names',
          nameFields: ['first_name', 'last_name', 'mid_init'],
        }),
      ],
    );
    const importId = importResult.rows[0]!.id;
    await stageEmployees(client, fetched.employees);
    await client.query(
      `INSERT INTO employees (company_id, external_id)
       SELECT $1, external_id FROM nyc_employee_staging ORDER BY external_id`,
      [companyId],
    );
    await client.query(
      `INSERT INTO employee_versions
         (company_id, employee_id, version, valid_from, display_name, first_name, last_name,
          middle_initial, location, department, employment_type, is_manager, hire_date,
          attributes, changed_fields, created_by)
       SELECT $1, e.id, 1, $2::date, staged.display_name, staged.first_name, staged.last_name,
              staged.middle_initial, staged.location, staged.department, staged.employment_type,
              false, staged.hire_date, staged.attributes, ARRAY['created', 'dataset_import'], $3
         FROM nyc_employee_staging staged
         JOIN employees e ON e.company_id = $1 AND e.external_id = staged.external_id
        ORDER BY e.id`,
      [companyId, `${fetched.fiscalYear}-06-30`, options.createdBy],
    );
    await client.query(
      `UPDATE employees e
          SET current_version_id = ev.id, updated_at = now()
         FROM employee_versions ev
        WHERE e.company_id = $1
          AND ev.company_id = e.company_id
          AND ev.employee_id = e.id
          AND ev.version = 1`,
      [companyId],
    );
    await client.query(
      `INSERT INTO employee_import_records
         (company_id, employee_id, import_id, dataset_id, source_row_id, source_record_checksum, normalized_facts)
       SELECT $1, e.id, $2, $3, staged.source_row_id, staged.source_record_checksum,
              jsonb_build_object(
                'externalId', staged.external_id,
                'displayName', staged.display_name,
                'firstName', staged.first_name,
                'lastName', staged.last_name,
                'middleInitial', staged.middle_initial,
                'location', staged.location,
                'department', staged.department,
                'employmentType', staged.employment_type,
                'hireDate', staged.hire_date,
                'attributes', staged.attributes
              )
         FROM nyc_employee_staging staged
         JOIN employees e ON e.company_id = $1 AND e.external_id = staged.external_id
        ORDER BY e.id`,
      [companyId, importId, NYC_DATASET_ID],
    );
    const count = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM employee_import_records WHERE company_id = $1 AND import_id = $2',
      [companyId, importId],
    );
    if (Number(count.rows[0]?.count) !== fetched.employees.length) {
      throw new Error(`Imported row count ${count.rows[0]?.count ?? '0'} does not match validated population ${fetched.employees.length}`);
    }
    const reconciliationJobId = options.enqueueReconciliation
      ? await enqueueJob(client, {
        companyId,
        eventType: 'DATASET_IMPORT_COMPLETED',
        scope: 'FULL',
        payload: { importId, datasetId: NYC_DATASET_ID, importedRows: fetched.employees.length },
        dedupeKey: `dataset-import:${importId}`,
        priority: 50,
      })
      : null;
    return { importId, reconciliationJobId };
}

export async function backfillNycEmployeeNames(
  pool: DbPool,
  companyId: string,
  fetched: NycFetchResult,
): Promise<NycNameBackfillResult> {
  if (fetched.employees.length < 1) throw new Error('Cannot backfill names from an empty NYC employee population');
  return inTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', ['nyc-name-backfill', companyId]);
    await stageEmployees(client, fetched.employees);
    const validation = await client.query<{
      imported_rows: number;
      matched_rows: number;
      named_rows: number;
      fact_mismatches: number;
      import_ids: number;
    }>(
      `SELECT count(*)::int AS imported_rows,
              count(staged.external_id)::int AS matched_rows,
              count(*) FILTER (WHERE staged.first_name IS NOT NULL AND staged.last_name IS NOT NULL)::int AS named_rows,
              count(*) FILTER (WHERE staged.external_id IS NOT NULL AND (
                records.source_row_id IS DISTINCT FROM staged.source_row_id
                OR records.normalized_facts ->> 'externalId' IS DISTINCT FROM staged.external_id
                OR records.normalized_facts ->> 'location' IS DISTINCT FROM staged.location
                OR records.normalized_facts ->> 'department' IS DISTINCT FROM staged.department
                OR records.normalized_facts ->> 'employmentType' IS DISTINCT FROM staged.employment_type
                OR records.normalized_facts ->> 'hireDate' IS DISTINCT FROM staged.hire_date::text
                OR records.normalized_facts -> 'attributes' IS DISTINCT FROM staged.attributes
              ))::int AS fact_mismatches,
              count(DISTINCT records.import_id)::int AS import_ids
         FROM employees employee
         JOIN employee_import_records records
           ON records.company_id = employee.company_id AND records.employee_id = employee.id
         LEFT JOIN nyc_employee_staging staged
           ON staged.external_id = employee.external_id
        WHERE employee.company_id = $1 AND records.dataset_id = $2`,
      [companyId, NYC_DATASET_ID],
    );
    const checked = validation.rows[0];
    if (checked === undefined
      || checked.imported_rows !== fetched.employees.length
      || checked.matched_rows !== fetched.employees.length
      || checked.fact_mismatches !== 0
      || checked.import_ids !== 1) {
      throw new Error('Refusing to backfill NYC names because the persisted employee population does not exactly match the fetched source facts');
    }
    const versions = await client.query<{ count: number }>(
      `WITH updated AS (
         UPDATE employee_versions version
            SET display_name = staged.display_name,
                first_name = staged.first_name,
                last_name = staged.last_name,
                middle_initial = staged.middle_initial
           FROM employees employee
           JOIN nyc_employee_staging staged ON staged.external_id = employee.external_id
          WHERE employee.company_id = $1
            AND version.company_id = employee.company_id
            AND version.employee_id = employee.id
         RETURNING version.id
       ) SELECT count(*)::int AS count FROM updated`,
      [companyId],
    );
    await client.query(
      `UPDATE employee_import_records records
          SET normalized_facts = records.normalized_facts || jsonb_build_object(
                'displayName', staged.display_name,
                'firstName', staged.first_name,
                'lastName', staged.last_name,
                'middleInitial', staged.middle_initial
              ),
              source_record_checksum = staged.source_record_checksum
         FROM employees employee
         JOIN nyc_employee_staging staged ON staged.external_id = employee.external_id
        WHERE employee.company_id = $1
          AND records.company_id = employee.company_id
          AND records.employee_id = employee.id
          AND records.source_row_id = staged.source_row_id`,
      [companyId],
    );
    await client.query(
      `UPDATE dataset_imports imported
          SET source_url = $3,
              source_query = $4,
              fetched_at = $5::timestamptz,
              completed_at = now(),
              requested_rows = $6,
              fetched_rows = $7,
              imported_rows = $6,
              skipped_rows = $8,
              checksum = $9,
              skipped_reasons = $10::jsonb,
              metadata = metadata || jsonb_build_object(
                'fiscalYear', $11::text,
                'nameFields', jsonb_build_array('first_name', 'last_name', 'mid_init'),
                'namesBackfilledAt', now()
              )
        WHERE imported.company_id = $1
          AND imported.id = (
            SELECT records.import_id
              FROM employee_import_records records
             WHERE records.company_id = $1 AND records.dataset_id = $2
             LIMIT 1
          )`,
      [
        companyId,
        NYC_DATASET_ID,
        NYC_DATASET_URL,
        fetched.sourceQuery,
        fetched.fetchedAt,
        fetched.employees.length,
        fetched.fetchedRows,
        fetched.skippedRows,
        fetched.checksum,
        JSON.stringify(fetched.skippedReasons),
        fetched.fiscalYear,
      ],
    );
    return {
      employeesMatched: checked.matched_rows,
      employeesNamed: checked.named_rows,
      versionsUpdated: versions.rows[0]?.count ?? 0,
    };
  });
}

async function fetchRows(
  query: string,
  input: { fetchImpl: typeof fetch; appToken?: string; maxAttempts: number },
): Promise<Array<Record<string, unknown>>> {
  const url = new URL(NYC_DATASET_URL);
  url.searchParams.set('query', query);
  for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (input.appToken !== undefined && input.appToken.length > 0) headers['x-app-token'] = input.appToken;
    let response: Response;
    try {
      response = await input.fetchImpl(url, { headers, signal: AbortSignal.timeout(60_000) });
    } catch (error) {
      if (attempt === input.maxAttempts) throw new Error(`NYC API request failed after ${attempt} attempts`, { cause: error });
      await delay(250 * 2 ** (attempt - 1));
      continue;
    }
    if (response.ok) {
      const payload: unknown = await response.json();
      if (!Array.isArray(payload) || !payload.every(isRecord)) throw new Error('NYC API returned a non-array response');
      return payload;
    }
    const body = (await response.text()).slice(0, 1_000);
    if (attempt === input.maxAttempts || (response.status !== 429 && response.status < 500)) {
      throw new Error(`NYC API returned ${response.status}: ${body}`);
    }
    const retryAfter = Number(response.headers.get('retry-after'));
    await delay(Number.isFinite(retryAfter) ? Math.min(10_000, retryAfter * 1_000) : 250 * 2 ** (attempt - 1));
  }
  throw new Error('NYC API retry loop ended unexpectedly');
}

async function evaluationCompanyId(client: DbClient): Promise<string> {
  const existing = await client.query<{ company_id: string }>(
    'SELECT company_id FROM evaluation_tenants WHERE key = $1 FOR UPDATE',
    [NYC_EVALUATION_TENANT_KEY],
  );
  if (existing.rows[0] !== undefined) return existing.rows[0].company_id;
  const company = await client.query<{ id: string }>(
    'INSERT INTO companies (name) VALUES ($1) RETURNING id',
    [`NYC Open Data Evaluation — ${NYC_DATASET_ID}`],
  );
  await client.query(
    'INSERT INTO evaluation_tenants (key, company_id, dataset_id) VALUES ($1, $2, $3)',
    [NYC_EVALUATION_TENANT_KEY, company.rows[0]!.id, NYC_DATASET_ID],
  );
  return company.rows[0]!.id;
}

async function resetEvaluationTenant(client: DbClient, companyId: string): Promise<void> {
  await client.query('DELETE FROM assignment_history WHERE company_id = $1', [companyId]);
  await client.query('DELETE FROM materialized_assignments WHERE company_id = $1', [companyId]);
  await client.query('DELETE FROM scheduled_evaluations WHERE company_id = $1', [companyId]);
  await client.query('DELETE FROM assignment_decisions WHERE company_id = $1', [companyId]);
  await client.query('DELETE FROM reconciliation_jobs WHERE company_id = $1', [companyId]);
  await client.query('DELETE FROM manual_overrides WHERE company_id = $1', [companyId]);
  await client.query('DELETE FROM rules WHERE company_id = $1', [companyId]);
  await client.query('DELETE FROM policy_categories WHERE company_id = $1', [companyId]);
  await client.query('DELETE FROM groups WHERE company_id = $1', [companyId]);
  await client.query('DELETE FROM employees WHERE company_id = $1', [companyId]);
}

async function stageEmployees(client: DbClient, employees: readonly NormalizedNycEmployee[]): Promise<void> {
  await client.query(
    `CREATE TEMP TABLE nyc_employee_staging (
       external_id text PRIMARY KEY,
       display_name text NOT NULL,
       first_name text,
       last_name text,
       middle_initial text,
       location text NOT NULL,
       department text NOT NULL,
       employment_type text NOT NULL,
       hire_date date NOT NULL,
       attributes jsonb NOT NULL,
       source_row_id text NOT NULL UNIQUE,
       source_record_checksum text NOT NULL
     ) ON COMMIT DROP`,
  );
  for (let offset = 0; offset < employees.length; offset += 1_000) {
    const batch = employees.slice(offset, offset + 1_000);
    await client.query(
      `INSERT INTO nyc_employee_staging
         (external_id, display_name, first_name, last_name, middle_initial, location, department,
          employment_type, hire_date, attributes, source_row_id, source_record_checksum)
       SELECT * FROM unnest(
         $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
         $7::text[], $8::text[], $9::date[], $10::jsonb[], $11::text[], $12::text[]
       )`,
      [
        batch.map((employee) => employee.externalId),
        batch.map((employee) => employee.displayName),
        batch.map((employee) => employee.firstName),
        batch.map((employee) => employee.lastName),
        batch.map((employee) => employee.middleInitial),
        batch.map((employee) => employee.location),
        batch.map((employee) => employee.department),
        batch.map((employee) => employee.employmentType),
        batch.map((employee) => employee.hireDate),
        batch.map((employee) => JSON.stringify(employee.attributes)),
        batch.map((employee) => employee.sourceRowId),
        batch.map((employee) => employee.sourceRecordChecksum),
      ],
    );
  }
}

function requiredText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : null;
}

function usableName(value: unknown, maxLength: number): string | null {
  const normalized = requiredText(value, maxLength);
  if (normalized === null || /^(?:x{2,}|redacted|unknown|n\/?a)$/i.test(normalized)) return null;
  return normalized;
}

function optionalName(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined || value === '') return null;
  return usableName(value, maxLength);
}

function parseDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const date = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date ? date : null;
}

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
