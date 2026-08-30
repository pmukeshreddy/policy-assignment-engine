import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createPool } from '../src/db.js';
import { compileRule, type EmployeeSnapshot, type RuleCondition } from '../src/domain/rules.js';
import { PolicyEvaluator, type EvaluatableRule } from '../src/services/evaluation.js';
import { ReconciliationService } from '../src/services/reconciliation.js';

interface ScenarioResult {
  employees: number;
  rules: number;
  categories: number;
  fullRecomputationMs: number;
  fullRuleEvaluations: number;
  fullEvaluationsPerSecond: number;
  incremental: {
    mutation: string;
    rulesBeforeImpactFiltering: number;
    categoriesAffected: number;
    rulesActuallyEvaluated: number;
    reductionPercent: number;
    samples: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    assignmentRowsChanged: number;
  };
}

const scenarios = [
  { employees: 1_000, rules: 100 },
  { employees: 10_000, rules: 1_000 },
  { employees: 100_000, rules: 100 },
  { employees: 1_000, rules: 5_000 },
];
const categoryCount = 10;
const asOfDate = '2026-08-30';

const results: ScenarioResult[] = [];
for (const scenario of scenarios) {
  process.stdout.write(`Benchmarking ${scenario.employees.toLocaleString()} employees × ${scenario.rules.toLocaleString()} rules…\n`);
  results.push(runScenario(scenario.employees, scenario.rules));
}

const database = await runDatabaseBenchmark();
const output = {
  generatedAt: new Date().toISOString(),
  runtime: { node: process.version, platform: `${process.platform}/${process.arch}` },
  methodology: 'Compiled rule cache warm; full path uses PolicyEvaluator for every employee/category; incremental path uses dependency-to-category filtering and the same evaluator/resolver.',
  scenarios: results,
  database,
};
await mkdir('benchmark-results', { recursive: true });
await writeFile('benchmark-results/latest.json', `${JSON.stringify(output, null, 2)}\n`);
await writeFile('benchmark-results/latest.md', renderMarkdown(output));
process.stdout.write(`${renderMarkdown(output)}\nResults written to benchmark-results/latest.json and latest.md\n`);

function runScenario(employeeCount: number, ruleCount: number): ScenarioResult {
  const evaluator = new PolicyEvaluator();
  const rules = Array.from({ length: ruleCount }, (_, index) => makeRule(index));
  const byCategory = new Map<string, EvaluatableRule[]>();
  for (let category = 0; category < categoryCount; category += 1) {
    byCategory.set(`category-${category}`, rules.filter((rule) => rule.categoryId === `category-${category}`));
  }
  // Warm the compiled cache exactly as a long-running worker does.
  const warmEmployee = makeEmployee(0);
  for (const [categoryId, categoryRules] of byCategory) {
    evaluator.evaluateCategory({ snapshot: warmEmployee, categoryId, cardinality: 'SINGLE', rules: categoryRules, overrides: [] });
  }

  let checksum = 0;
  const fullStart = performance.now();
  for (let employeeIndex = 0; employeeIndex < employeeCount; employeeIndex += 1) {
    const employee = makeEmployee(employeeIndex);
    for (const [categoryId, categoryRules] of byCategory) {
      checksum += evaluator.evaluateCategory({
        snapshot: employee, categoryId, cardinality: 'SINGLE', rules: categoryRules, overrides: [],
      }).winners.length;
    }
  }
  const fullRecomputationMs = performance.now() - fullStart;
  if (checksum < 0) throw new Error('Unreachable benchmark checksum');

  const affectedCategory = 'category-0';
  const affectedRules = byCategory.get(affectedCategory)!;
  const samples = ruleCount >= 5_000 ? 100 : 500;
  const latencies: number[] = [];
  let assignmentRowsChanged = 0;
  for (let sample = 0; sample < samples; sample += 1) {
    const original = makeEmployee(sample % employeeCount);
    const before = evaluator.evaluateCategory({
      snapshot: original, categoryId: affectedCategory, cardinality: 'SINGLE', rules: affectedRules, overrides: [],
    });
    const changed: EmployeeSnapshot = {
      ...original,
      versionId: `${original.versionId}-mutated`,
      location: original.location === 'CA' ? 'NY' : 'CA',
    };
    const start = performance.now();
    const after = evaluator.evaluateCategory({
      snapshot: changed, categoryId: affectedCategory, cardinality: 'SINGLE', rules: affectedRules, overrides: [],
    });
    latencies.push(performance.now() - start);
    if (sample === 0) {
      const beforeIds = new Set(before.winners.map((winner) => winner.policyId));
      const afterIds = new Set(after.winners.map((winner) => winner.policyId));
      assignmentRowsChanged = [...beforeIds].filter((id) => !afterIds.has(id)).length
        + [...afterIds].filter((id) => !beforeIds.has(id)).length;
    }
  }
  latencies.sort((left, right) => left - right);
  return {
    employees: employeeCount,
    rules: ruleCount,
    categories: categoryCount,
    fullRecomputationMs: round(fullRecomputationMs),
    fullRuleEvaluations: employeeCount * ruleCount,
    fullEvaluationsPerSecond: Math.round((employeeCount * ruleCount) / (fullRecomputationMs / 1_000)),
    incremental: {
      mutation: 'one employee location CA↔NY',
      rulesBeforeImpactFiltering: ruleCount,
      categoriesAffected: 1,
      rulesActuallyEvaluated: affectedRules.length,
      reductionPercent: round((1 - affectedRules.length / ruleCount) * 100),
      samples,
      p50Ms: percentile(latencies, 0.5),
      p95Ms: percentile(latencies, 0.95),
      p99Ms: percentile(latencies, 0.99),
      assignmentRowsChanged,
    },
  };
}

function makeRule(index: number): EvaluatableRule {
  const category = index % categoryCount;
  const condition = conditionFor(category, index);
  const compiled = compileRule(condition);
  return {
    ruleId: `rule-${index}`,
    ruleVersionId: `rule-version-${index}`,
    policyId: `policy-${index}`,
    categoryId: `category-${category}`,
    priority: index % 50,
    enabled: true,
    validFrom: '2020-01-01',
    validTo: null,
    condition: compiled.condition,
    contentHash: compiled.contentHash,
    specificity: compiled.specificity,
    policyEnabled: true,
  };
}

function conditionFor(category: number, index: number): RuleCondition {
  if (category === 0) return { type: 'comparison', fact: { kind: 'employee', field: 'location' }, operator: 'EQ', value: index % 20 === 0 ? 'CA' : 'NY' };
  if (category === 1) return { type: 'comparison', fact: { kind: 'employee', field: 'department' }, operator: 'EQ', value: index % 2 ? 'Sales' : 'Engineering' };
  if (category === 2) return { type: 'comparison', fact: { kind: 'employee', field: 'employment_type' }, operator: 'EQ', value: index % 3 ? 'full_time' : 'contractor' };
  if (category === 3) return { type: 'comparison', fact: { kind: 'employee', field: 'is_manager' }, operator: 'EQ', value: index % 2 === 0 };
  if (category === 4) return { type: 'comparison', fact: { kind: 'attribute', key: 'level' }, operator: 'GTE', value: index % 10 };
  if (category === 5) return { type: 'comparison', fact: { kind: 'attribute', key: 'country' }, operator: 'EQ', value: index % 4 ? 'US' : 'CA' };
  if (category === 6) return { type: 'group', groupId: '00000000-0000-4000-8000-000000000001', operator: 'MEMBER_OF' };
  if (category === 7) return { type: 'comparison', fact: { kind: 'employee', field: 'external_id' }, operator: 'EQ', value: `E-${index % 1_000}` };
  if (category === 8) return { type: 'comparison', fact: { kind: 'tenure_days' }, operator: 'GTE', value: 365 + (index % 1_000) };
  return { type: 'comparison', fact: { kind: 'as_of_date' }, operator: 'GTE', value: index % 2 ? '2020-01-01' : '2030-01-01' };
}

function makeEmployee(index: number): EmployeeSnapshot {
  return {
    id: `employee-${index}`,
    companyId: 'benchmark-company',
    versionId: `employee-version-${index}`,
    externalId: `E-${index}`,
    email: null,
    location: index % 5 === 0 ? 'CA' : 'NY',
    department: index % 2 === 0 ? 'Engineering' : 'Sales',
    employmentType: index % 7 === 0 ? 'contractor' : 'full_time',
    isManager: index % 10 === 0,
    hireDate: `202${index % 5}-01-01`,
    attributes: { level: index % 10, country: 'US' },
    groupIds: index % 2 === 0 ? new Set(['00000000-0000-4000-8000-000000000001']) : new Set(),
    asOfDate,
  };
}

async function runDatabaseBenchmark(): Promise<Record<string, unknown>> {
  const databaseUrl = process.env.DATABASE_URL ?? 'postgres://policy:policy@localhost:5432/policy_engine';
  const pool = createPool({ DATABASE_URL: databaseUrl });
  try {
    const target = await pool.query<{ company_id: string; employee_id: string; category_id: string }>(
      `SELECT ma.company_id, ma.employee_id, ma.category_id
         FROM materialized_assignments ma
         JOIN companies c ON c.id = ma.company_id
        WHERE c.name = 'Warp Policy Demo'
        ORDER BY ma.employee_id, ma.category_id
        LIMIT 1`,
    );
    const row = target.rows[0];
    if (row === undefined) return { executed: false, reason: 'Run npm run seed to enable the PostgreSQL reconciliation benchmark.' };
    const service = new ReconciliationService(pool);
    const latencies: number[] = [];
    for (let index = 0; index < 50; index += 1) {
      const start = performance.now();
      const result = await service.reconcileEmployeeCategory({
        companyId: row.company_id,
        employeeId: row.employee_id,
        categoryId: row.category_id,
        asOfDate,
      });
      latencies.push(performance.now() - start);
      if (result.addedPolicyIds.length > 0 || result.removedPolicyIds.length > 0) {
        throw new Error('Idempotent database benchmark unexpectedly changed assignments');
      }
    }
    latencies.sort((left, right) => left - right);
    return {
      executed: true,
      samples: latencies.length,
      workload: 'idempotent employee/category reconciliation through PostgreSQL transaction',
      p50Ms: percentile(latencies, 0.5),
      p95Ms: percentile(latencies, 0.95),
      p99Ms: percentile(latencies, 0.99),
    };
  } catch (error) {
    return { executed: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    await pool.end();
  }
}

function percentile(sorted: number[], fraction: number): number {
  return round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0);
}

function round(value: number): number { return Math.round(value * 1_000) / 1_000; }

function renderMarkdown(output: {
  generatedAt: string;
  runtime: { node: string; platform: string };
  scenarios: ScenarioResult[];
  database: Record<string, unknown>;
}): string {
  const rows = output.scenarios.map((scenario) =>
    `| ${scenario.employees.toLocaleString()} | ${scenario.rules.toLocaleString()} | ${scenario.fullRuleEvaluations.toLocaleString()} | ${scenario.fullRecomputationMs} | ${scenario.incremental.rulesActuallyEvaluated.toLocaleString()} | ${scenario.incremental.p50Ms} | ${scenario.incremental.p95Ms} | ${scenario.incremental.p99Ms} |`,
  ).join('\n');
  return `# Measured benchmark results

Generated ${output.generatedAt} on ${output.runtime.node} (${output.runtime.platform}). Times are wall-clock measurements, not estimates.

| Employees | Rules | Full rule evaluations | Full ms | Incremental rules | p50 ms | p95 ms | p99 ms |
|---:|---:|---:|---:|---:|---:|---:|---:|
${rows}

Every incremental sample changes one employee's location and evaluates only the dependency-affected category. The full path evaluates every rule for every employee through the same compiled evaluator and conflict resolver. Compiled rules are warm, matching the steady-state worker.

PostgreSQL transaction benchmark: \`${JSON.stringify(output.database)}\`.
`;
}
