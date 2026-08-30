import { createHash } from 'node:crypto';
import { z } from 'zod';

export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected an ISO calendar date');
const identifierSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.-]+$/);
const scalarSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);

const employeeFieldSchema = z.enum([
  'external_id',
  'email',
  'location',
  'department',
  'employment_type',
  'is_manager',
  'hire_date',
]);

export type EmployeeField = z.infer<typeof employeeFieldSchema>;
export type Scalar = z.infer<typeof scalarSchema>;

const factSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('employee'), field: employeeFieldSchema }).strict(),
  z.object({ kind: z.literal('attribute'), key: identifierSchema }).strict(),
  z.object({ kind: z.literal('tenure_days') }).strict(),
  z.object({ kind: z.literal('as_of_date') }).strict(),
]);

export type Fact = z.infer<typeof factSchema>;

const comparisonSchema = z
  .object({
    type: z.literal('comparison'),
    fact: factSchema,
    operator: z.enum(['EQ', 'NE', 'GT', 'GTE', 'LT', 'LTE', 'IN', 'NOT_IN']),
    value: z.union([scalarSchema, z.array(scalarSchema).min(1).max(1_000)]),
  })
  .strict()
  .superRefine((value, context) => {
    const expectsArray = value.operator === 'IN' || value.operator === 'NOT_IN';
    if (expectsArray !== Array.isArray(value.value)) {
      context.addIssue({
        code: 'custom',
        message: `${value.operator} ${expectsArray ? 'requires' : 'does not accept'} an array value`,
        path: ['value'],
      });
    }
    if (value.fact.kind === 'tenure_days') {
      const values = Array.isArray(value.value) ? value.value : [value.value];
      if (!values.every((item) => typeof item === 'number' && Number.isInteger(item) && item >= 0)) {
        context.addIssue({ code: 'custom', message: 'tenure_days values must be non-negative integers', path: ['value'] });
      }
    }
    if (value.fact.kind === 'as_of_date') {
      const values = Array.isArray(value.value) ? value.value : [value.value];
      if (!values.every((item) => typeof item === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item))) {
        context.addIssue({ code: 'custom', message: 'as_of_date values must be ISO dates', path: ['value'] });
      }
    }
  });

const groupSchema = z
  .object({
    type: z.literal('group'),
    groupId: z.string().uuid(),
    operator: z.enum(['MEMBER_OF', 'NOT_MEMBER_OF']),
  })
  .strict();

export type RuleCondition =
  | z.infer<typeof comparisonSchema>
  | z.infer<typeof groupSchema>
  | { type: 'and'; conditions: RuleCondition[] }
  | { type: 'or'; conditions: RuleCondition[] }
  | { type: 'not'; condition: RuleCondition };

export const ruleConditionSchema: z.ZodType<RuleCondition> = z.lazy(() =>
  z.discriminatedUnion('type', [
    comparisonSchema,
    groupSchema,
    z.object({ type: z.literal('and'), conditions: z.array(ruleConditionSchema).min(1).max(100) }).strict(),
    z.object({ type: z.literal('or'), conditions: z.array(ruleConditionSchema).min(1).max(100) }).strict(),
    z.object({ type: z.literal('not'), condition: ruleConditionSchema }).strict(),
  ]),
);

export interface EmployeeSnapshot {
  id: string;
  companyId: string;
  versionId: string;
  externalId: string;
  email: string | null;
  location: string | null;
  department: string | null;
  employmentType: string | null;
  isManager: boolean;
  hireDate: string | null;
  attributes: Readonly<Record<string, unknown>>;
  groupIds: ReadonlySet<string>;
  asOfDate: string;
}

export interface ConditionTrace {
  path: string;
  type: RuleCondition['type'];
  matched: boolean;
  fact?: string;
  actual?: unknown;
  operator?: string;
  expected?: unknown;
}

export interface EvaluationResult {
  matched: boolean;
  trace: ConditionTrace[];
  nextTransitionDate: string | null;
}

export type DependencyType = 'FIELD' | 'ATTRIBUTE' | 'GROUP' | 'TIME' | 'RULE_WINDOW';

export interface RuleDependency {
  type: DependencyType;
  key: string;
  operator: string | null;
  selectorValue: Scalar | readonly Scalar[] | null;
  mandatorySelector: boolean;
}

export interface CompiledRule {
  readonly condition: RuleCondition;
  readonly dependencies: readonly RuleDependency[];
  readonly specificity: number;
  readonly contentHash: string;
  evaluate(snapshot: EmployeeSnapshot, ruleWindow?: RuleWindow): EvaluationResult;
}

export interface RuleWindow {
  validFrom: string;
  validTo: string | null;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function epochDay(isoDate: string): number {
  const milliseconds = Date.parse(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(milliseconds)) throw new Error(`Invalid ISO date: ${isoDate}`);
  return Math.floor(milliseconds / 86_400_000);
}

function addDays(isoDate: string, days: number): string {
  return new Date((epochDay(isoDate) + days) * 86_400_000).toISOString().slice(0, 10);
}

function getFact(snapshot: EmployeeSnapshot, fact: Fact): unknown {
  if (fact.kind === 'attribute') return snapshot.attributes[fact.key];
  if (fact.kind === 'tenure_days') {
    return snapshot.hireDate === null ? undefined : Math.max(0, epochDay(snapshot.asOfDate) - epochDay(snapshot.hireDate));
  }
  if (fact.kind === 'as_of_date') return snapshot.asOfDate;
  const fields: Record<EmployeeField, unknown> = {
    external_id: snapshot.externalId,
    email: snapshot.email,
    location: snapshot.location,
    department: snapshot.department,
    employment_type: snapshot.employmentType,
    is_manager: snapshot.isManager,
    hire_date: snapshot.hireDate,
  };
  return fields[fact.field];
}

function scalarEqual(left: unknown, right: unknown): boolean {
  return left === right || (left !== undefined && right !== undefined && stableJson(left) === stableJson(right));
}

function compare(actual: unknown, operator: z.infer<typeof comparisonSchema>['operator'], expected: Scalar | Scalar[]): boolean {
  if (actual === undefined) return false;
  if (operator === 'IN' || operator === 'NOT_IN') {
    const found = (expected as Scalar[]).some((item) => scalarEqual(actual, item));
    return operator === 'IN' ? found : !found;
  }
  if (operator === 'EQ') return scalarEqual(actual, expected);
  if (operator === 'NE') return !scalarEqual(actual, expected);
  if (actual === null || expected === null || Array.isArray(expected)) return false;
  if (typeof actual !== typeof expected) return false;
  if (typeof actual !== 'number' && typeof actual !== 'string') return false;
  if (operator === 'GT') return actual > expected;
  if (operator === 'GTE') return actual >= expected;
  if (operator === 'LT') return actual < expected;
  return actual <= expected;
}

function factName(fact: Fact): string {
  if (fact.kind === 'employee') return `employee.${fact.field}`;
  if (fact.kind === 'attribute') return `employee.attributes.${fact.key}`;
  return fact.kind;
}

function evaluateNode(condition: RuleCondition, snapshot: EmployeeSnapshot, path: string, trace: ConditionTrace[]): boolean {
  if (condition.type === 'comparison') {
    const actual = getFact(snapshot, condition.fact);
    const matched = compare(actual, condition.operator, condition.value);
    trace.push({
      path,
      type: condition.type,
      matched,
      fact: factName(condition.fact),
      actual,
      operator: condition.operator,
      expected: condition.value,
    });
    return matched;
  }
  if (condition.type === 'group') {
    const isMember = snapshot.groupIds.has(condition.groupId);
    const matched = condition.operator === 'MEMBER_OF' ? isMember : !isMember;
    trace.push({
      path,
      type: condition.type,
      matched,
      fact: `group.${condition.groupId}`,
      actual: isMember,
      operator: condition.operator,
      expected: true,
    });
    return matched;
  }
  if (condition.type === 'not') {
    const matched = !evaluateNode(condition.condition, snapshot, `${path}.not`, trace);
    trace.push({ path, type: condition.type, matched });
    return matched;
  }
  const values = condition.conditions.map((child, index) =>
    evaluateNode(child, snapshot, `${path}.${condition.type}[${index}]`, trace),
  );
  const matched = condition.type === 'and' ? values.every(Boolean) : values.some(Boolean);
  trace.push({ path, type: condition.type, matched });
  return matched;
}

function conditionTransitionDates(condition: RuleCondition, snapshot: EmployeeSnapshot): string[] {
  if (condition.type === 'and' || condition.type === 'or') {
    return condition.conditions.flatMap((child) => conditionTransitionDates(child, snapshot));
  }
  if (condition.type === 'not') return conditionTransitionDates(condition.condition, snapshot);
  if (condition.type !== 'comparison') return [];
  if (condition.fact.kind === 'as_of_date') {
    const values = (Array.isArray(condition.value) ? condition.value : [condition.value]) as string[];
    return values.flatMap((value) => {
      if (condition.operator === 'GT' || condition.operator === 'LTE') return [addDays(value, 1)];
      if (condition.operator === 'EQ' || condition.operator === 'NE' || condition.operator === 'IN' || condition.operator === 'NOT_IN') {
        return [value, addDays(value, 1)];
      }
      return [value];
    });
  }
  if (condition.fact.kind !== 'tenure_days' || snapshot.hireDate === null) return [];
  const values = (Array.isArray(condition.value) ? condition.value : [condition.value]) as number[];
  return values.flatMap((value) => {
    if (condition.operator === 'GT' || condition.operator === 'LTE') return [addDays(snapshot.hireDate!, value + 1)];
    if (condition.operator === 'EQ' || condition.operator === 'NE' || condition.operator === 'IN' || condition.operator === 'NOT_IN') {
      return [addDays(snapshot.hireDate!, value), addDays(snapshot.hireDate!, value + 1)];
    }
    return [addDays(snapshot.hireDate!, value)];
  });
}

function nextDateAfter(asOfDate: string, values: readonly (string | null | undefined)[]): string | null {
  return [...new Set(values.filter((value): value is string => value !== null && value !== undefined && value > asOfDate))]
    .sort()[0] ?? null;
}

function dependencyIdentity(dependency: Pick<RuleDependency, 'type' | 'key'>): string {
  return `${dependency.type}:${dependency.key}`;
}

interface Selector {
  identity: string;
  dependency: RuleDependency;
}

function leafDependency(condition: RuleCondition): RuleDependency | null {
  if (condition.type === 'group') {
    return {
      type: 'GROUP',
      key: condition.groupId,
      operator: condition.operator,
      selectorValue: true,
      mandatorySelector: false,
    };
  }
  if (condition.type !== 'comparison') return null;
  if (condition.fact.kind === 'employee') {
    return {
      type: 'FIELD',
      key: condition.fact.field,
      operator: condition.operator,
      selectorValue: condition.value,
      mandatorySelector: false,
    };
  }
  if (condition.fact.kind === 'attribute') {
    return {
      type: 'ATTRIBUTE',
      key: condition.fact.key,
      operator: condition.operator,
      selectorValue: condition.value,
      mandatorySelector: false,
    };
  }
  return {
    type: 'TIME',
    key: condition.fact.kind,
    operator: condition.operator,
    selectorValue: condition.value,
    mandatorySelector: false,
  };
}

function safeSelector(condition: RuleCondition): Selector | null {
  const dependency = leafDependency(condition);
  if (dependency === null) return null;
  const positive = dependency.operator === 'EQ' || dependency.operator === 'IN' || dependency.operator === 'MEMBER_OF';
  if (!positive || dependency.type === 'TIME') return null;
  return { identity: `${dependencyIdentity(dependency)}:${stableJson(dependency.selectorValue)}`, dependency };
}

function mandatorySelectors(condition: RuleCondition): Map<string, RuleDependency> {
  const leaf = safeSelector(condition);
  if (leaf !== null) return new Map([[leaf.identity, { ...leaf.dependency, mandatorySelector: true }]]);
  if (condition.type === 'not' || condition.type === 'comparison' || condition.type === 'group') return new Map();
  const childMaps = condition.conditions.map(mandatorySelectors);
  if (condition.type === 'and') return new Map(childMaps.flatMap((map) => [...map.entries()]));
  if (childMaps.length === 0) return new Map();
  return new Map([...childMaps[0]!.entries()].filter(([key]) => childMaps.every((map) => map.has(key))));
}

function allDependencies(condition: RuleCondition): RuleDependency[] {
  if (condition.type === 'comparison' || condition.type === 'group') {
    const dependency = leafDependency(condition);
    return dependency === null ? [] : [dependency];
  }
  if (condition.type === 'not') return allDependencies(condition.condition);
  return condition.conditions.flatMap(allDependencies);
}

function specificity(condition: RuleCondition): number {
  if (condition.type === 'comparison' || condition.type === 'group') return 1;
  if (condition.type === 'not') return specificity(condition.condition);
  return condition.conditions.reduce((total, child) => total + specificity(child), 0);
}

export function compileRule(input: unknown): CompiledRule {
  const condition = ruleConditionSchema.parse(input);
  const mandatory = mandatorySelectors(condition);
  const merged = new Map<string, RuleDependency>();
  for (const dependency of allDependencies(condition)) {
    const key = dependencyIdentity(dependency);
    const selector = [...mandatory.values()].find((candidate) => dependencyIdentity(candidate) === key);
    merged.set(key, selector ?? dependency);
  }
  if ([...merged.values()].some((dependency) => dependency.type === 'TIME' && dependency.key === 'tenure_days')) {
    merged.set('FIELD:hire_date', {
      type: 'FIELD',
      key: 'hire_date',
      operator: null,
      selectorValue: null,
      mandatorySelector: false,
    });
  }
  const dependencies = [...merged.values()].sort((left, right) =>
    dependencyIdentity(left).localeCompare(dependencyIdentity(right)),
  );
  const contentHash = fingerprint(condition);
  return {
    condition,
    dependencies,
    specificity: specificity(condition),
    contentHash,
    evaluate(snapshot, ruleWindow) {
      const trace: ConditionTrace[] = [];
      const matched = evaluateNode(condition, snapshot, '$', trace);
      const nextTransitionDate = nextDateAfter(snapshot.asOfDate, [
        ...conditionTransitionDates(condition, snapshot),
        ruleWindow?.validFrom,
        ruleWindow?.validTo,
      ]);
      return { matched, trace, nextTransitionDate };
    },
  };
}

export class RuleCompilerCache {
  readonly #cache = new Map<string, CompiledRule>();

  constructor(private readonly maxEntries = 10_000) {}

  get(versionId: string, condition: unknown, expectedHash?: string): CompiledRule {
    const cached = this.#cache.get(versionId);
    if (cached !== undefined) {
      if (expectedHash !== undefined && cached.contentHash !== expectedHash) {
        throw new Error(`Rule version ${versionId} content hash changed after compilation`);
      }
      this.#cache.delete(versionId);
      this.#cache.set(versionId, cached);
      return cached;
    }
    const compiled = compileRule(condition);
    if (expectedHash !== undefined && compiled.contentHash !== expectedHash) {
      throw new Error(`Rule version ${versionId} failed content integrity validation`);
    }
    this.#cache.set(versionId, compiled);
    while (this.#cache.size > this.maxEntries) {
      const oldest = this.#cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
    return compiled;
  }

  clear(): void {
    this.#cache.clear();
  }
}
