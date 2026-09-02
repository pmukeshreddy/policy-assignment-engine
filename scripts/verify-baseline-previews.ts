import { buildApp } from '../src/api/app.js';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';

interface EmployeeRow {
  id: string;
  external_id: string;
  display_name: string;
  location: string;
  department: string;
  employment_type: string;
  hire_date: string;
  attributes: Record<string, unknown>;
  group_ids: string[];
}

interface PreviewPolicy {
  id: string;
  name: string;
  ruleId?: string;
}

interface PreviewCategory {
  key: string;
  name: string;
  before: PreviewPolicy[];
  after: PreviewPolicy[];
  removed: Array<{ candidate: PreviewPolicy; reason: string }>;
}

interface EmployeePreview {
  summary: { assignmentsAdded: number; assignmentsRemoved: number; assignmentsUnchanged: number };
  categories: PreviewCategory[];
}

const config = loadConfig();
const pool = createPool(config);
const asOfDate = new Date().toISOString().slice(0, 10);
const app = buildApp({ pool, config: { LOG_LEVEL: 'silent', PREVIEW_MAX_EMPLOYEES: 50_000 }, clock: () => new Date(`${asOfDate}T12:00:00Z`) });

try {
  await app.ready();
  const workspace = await pool.query<{ company_id: string; name: string }>(
    `SELECT workspace.company_id, company.name
       FROM product_workspaces workspace
       JOIN companies company ON company.id = workspace.company_id
      WHERE workspace.dataset_id = 'k397-673e'
      ORDER BY workspace.created_at LIMIT 1`,
  );
  const product = workspace.rows[0];
  if (product === undefined) throw new Error('The NYC product workspace is not initialized');
  const companyId = product.company_id;
  const employees = await pool.query<EmployeeRow>(
    `SELECT e.id, e.external_id, ev.display_name, ev.location, ev.department, ev.employment_type,
            ev.hire_date::text, ev.attributes,
            coalesce(array_agg(gm.group_id::text ORDER BY gm.group_id)
              FILTER (WHERE gm.group_id IS NOT NULL), ARRAY[]::text[]) AS group_ids
       FROM employees e
       JOIN employee_versions ev ON ev.company_id = e.company_id AND ev.id = e.current_version_id
       LEFT JOIN group_memberships gm ON gm.company_id = e.company_id AND gm.employee_id = e.id
        AND gm.valid_from <= $2::date AND (gm.valid_to IS NULL OR gm.valid_to > $2::date)
      WHERE e.company_id = $1
      GROUP BY e.id, ev.id
      ORDER BY e.external_id
      LIMIT 2_000`,
    [companyId, asOfDate],
  );
  const ruleRows = await pool.query<{ id: string; key: string }>(
    'SELECT id, key FROM rules WHERE company_id = $1', [companyId],
  );
  const ruleKeys = new Map(ruleRows.rows.map((rule) => [rule.id, rule.key]));
  const locations = await distinctFact(companyId, 'location');
  const departments = await distinctFact(companyId, 'department');
  const employmentTypes = await distinctFact(companyId, 'employment_type');
  const rolePolicies = await pool.query<{ family: string; titles: string[] }>(
    `SELECT pv.metadata ->> 'segmentValue' AS family,
            ARRAY(SELECT jsonb_array_elements_text(pv.metadata -> 'observedTitles')) AS titles
       FROM policy_versions pv
       JOIN policies p ON p.company_id = pv.company_id AND p.id = pv.policy_id
       JOIN policy_categories pc ON pc.company_id = p.company_id AND pc.id = p.category_id
      WHERE pv.company_id = $1 AND pc.key = 'role-access-training'
        AND pv.valid_from <= $2::date AND (pv.valid_to IS NULL OR pv.valid_to > $2::date)
      ORDER BY pv.name`,
    [companyId, asOfDate],
  );
  const familyByTitle = new Map(rolePolicies.rows.flatMap((family) => family.titles.map((title) => [title, family.family] as const)));

  const location = await findReplacement(employees.rows, locations, (employee) => employee.location,
    (value) => ({ location: value }), 'location');
  const department = await findReplacement(employees.rows, departments, (employee) => employee.department,
    (value) => ({ department: value }), 'department');
  const employment = await findReplacement(employees.rows, employmentTypes, (employee) => employee.employment_type,
    (value) => ({ employmentType: value }), 'employment type');

  let jobTitle: Evidence | null = null;
  for (const employee of employees.rows) {
    const currentTitle = String(employee.attributes['job_title']);
    const currentFamily = familyByTitle.get(currentTitle);
    const alternate = rolePolicies.rows.find((family) => family.family !== currentFamily)?.titles[0];
    if (alternate === undefined) continue;
    const proposedAttributes = { ...employee.attributes, job_title: alternate };
    const preview = await previewEmployee(companyId, employee.id, { attributes: proposedAttributes });
    if (preview.summary.assignmentsAdded > 0 && preview.summary.assignmentsRemoved > 0) {
      jobTitle = evidence(employee, 'job title', currentTitle, alternate, preview);
      break;
    }
  }
  if (jobTitle === null) throw new Error('Could not discover a job-title replacement preview');

  let tenure: Evidence | null = null;
  for (const employee of employees.rows) {
    const currentDays = epochDay(asOfDate) - epochDay(employee.hire_date);
    const targetDays = currentDays < 730 ? 730 : 729;
    const alternateDate = fromEpochDay(epochDay(asOfDate) - targetDays);
    const preview = await previewEmployee(companyId, employee.id, { hireDate: alternateDate });
    if (preview.summary.assignmentsAdded > 0 && preview.summary.assignmentsRemoved > 0) {
      tenure = evidence(employee, 'hire date / tenure threshold', employee.hire_date, alternateDate, preview);
      break;
    }
  }
  if (tenure === null) throw new Error('Could not discover a tenure-threshold replacement preview');

  let groupMembership: Evidence | null = null;
  for (const employee of employees.rows.filter((candidate) => candidate.group_ids.length > 0)) {
    const afterGroups = employee.group_ids.slice(1);
    const preview = await previewEmployee(companyId, employee.id, { groupIds: afterGroups });
    if (preview.summary.assignmentsAdded > 0 || preview.summary.assignmentsRemoved > 0) {
      groupMembership = evidence(employee, 'group membership', employee.group_ids.join(', '), afterGroups.join(', ') || '(none)', preview);
      break;
    }
  }
  if (groupMembership === null) throw new Error('Could not discover a group-membership policy impact');

  process.stdout.write(`${JSON.stringify({
    company: product,
    asOfDate,
    endpoint: 'POST /employees/preview',
    location,
    department,
    employment,
    jobTitle,
    tenure,
    groupMembership,
  }, null, 2)}\n`);

  function evidence(employee: EmployeeRow, field: string, oldValue: string, newValue: string, preview: EmployeePreview): Evidence {
    const added: PolicyEvidence[] = [];
    const removed: PolicyEvidence[] = [];
    const unchanged: PolicyEvidence[] = [];
    for (const category of preview.categories) {
      const beforeIds = new Set(category.before.map((policy) => policy.id));
      const afterIds = new Set(category.after.map((policy) => policy.id));
      for (const policy of category.after) {
        (beforeIds.has(policy.id) ? unchanged : added).push(policyEvidence(category, policy));
      }
      for (const policy of category.before.filter((candidate) => !afterIds.has(candidate.id))) {
        const detail = category.removed.find((item) => item.candidate.id === policy.id);
        removed.push({ ...policyEvidence(category, policy), ...(detail === undefined ? {} : { reason: detail.reason }) });
      }
    }
    return {
      employee: { id: employee.id, externalId: employee.external_id, displayName: employee.display_name },
      field,
      oldValue,
      newValue,
      summary: preview.summary,
      removed,
      added,
      unchanged,
    };
  }

  function policyEvidence(category: PreviewCategory, policy: PreviewPolicy): PolicyEvidence {
    return {
      category: category.name,
      policy: policy.name,
      rule: policy.ruleId === undefined ? null : ruleKeys.get(policy.ruleId) ?? policy.ruleId,
    };
  }

  async function findReplacement(
    candidates: readonly EmployeeRow[],
    values: readonly string[],
    current: (employee: EmployeeRow) => string,
    proposed: (value: string) => Record<string, unknown>,
    field: string,
  ): Promise<Evidence> {
    for (const employee of candidates) {
      for (const alternate of values) {
        if (alternate === current(employee)) continue;
        const preview = await previewEmployee(companyId, employee.id, proposed(alternate));
        if (preview.summary.assignmentsAdded > 0 && preview.summary.assignmentsRemoved > 0) {
          return evidence(employee, field, current(employee), alternate, preview);
        }
      }
    }
    throw new Error(`Could not discover a ${field} replacement preview`);
  }

  async function previewEmployee(companyId: string, employeeId: string, proposed: Record<string, unknown>): Promise<EmployeePreview> {
    const response = await app.inject({
      method: 'POST',
      url: '/employees/preview',
      headers: { 'x-company-id': companyId },
      payload: { employeeId, asOfDate, ...proposed },
    });
    if (response.statusCode >= 400) throw new Error(`POST /employees/preview failed: ${response.statusCode} ${response.body}`);
    return response.json() as EmployeePreview;
  }
} finally {
  await app.close();
  await pool.end();
}

interface PolicyEvidence {
  category: string;
  policy: string;
  rule: string | null;
  reason?: string;
}

interface Evidence {
  employee: { id: string; externalId: string; displayName: string };
  field: string;
  oldValue: string;
  newValue: string;
  summary: EmployeePreview['summary'];
  removed: PolicyEvidence[];
  added: PolicyEvidence[];
  unchanged: PolicyEvidence[];
}

async function distinctFact(companyId: string, safeColumn: 'location' | 'department' | 'employment_type'): Promise<string[]> {
  const result = await pool.query<{ value: string }>(
    `SELECT DISTINCT ${safeColumn} AS value
       FROM employee_versions
      WHERE company_id = $1 AND ${safeColumn} IS NOT NULL
      ORDER BY value`,
    [companyId],
  );
  return result.rows.map((row) => row.value);
}

function epochDay(value: string): number {
  return Math.floor(Date.parse(`${value.slice(0, 10)}T00:00:00Z`) / 86_400_000);
}

function fromEpochDay(value: number): string {
  return new Date(value * 86_400_000).toISOString().slice(0, 10);
}
