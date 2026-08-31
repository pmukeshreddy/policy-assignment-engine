import { DeterministicRandom } from './deterministic.js';

export const mutationKinds = [
  'location_change',
  'department_change',
  'employment_type_change',
  'title_change',
  'hire_date_change',
  'group_membership_toggle',
  'manual_assign',
  'manual_exclude',
  'override_remove',
  'date_advance',
  'rule_create',
  'rule_condition_edit',
  'rule_enable_toggle',
  'rule_priority_change',
  'rule_effective_date_change',
  'policy_enable_toggle',
  'duplicate_job_retry',
] as const;

export type MutationKind = (typeof mutationKinds)[number];

export interface PlannedMutation {
  index: number;
  kind: MutationKind;
  employeeOrdinal: number;
  targetOrdinal: number;
  valueOrdinal: number;
  magnitude: number;
}

export type MutationBatchKind = 'LOCALIZED' | 'GLOBAL';

export interface PlannedMutationBatch {
  kind: MutationBatchKind;
  mutations: PlannedMutation[];
}

const globalMutationKinds: ReadonlySet<MutationKind> = new Set([
  'date_advance',
  'rule_create',
  'rule_condition_edit',
  'rule_enable_toggle',
  'rule_priority_change',
  'rule_effective_date_change',
  'policy_enable_toggle',
]);

const frequentKinds: readonly MutationKind[] = [
  'location_change', 'location_change', 'location_change',
  'department_change', 'department_change', 'department_change',
  'employment_type_change', 'employment_type_change',
  'title_change', 'title_change',
  'hire_date_change',
  'group_membership_toggle', 'group_membership_toggle',
  'manual_assign', 'manual_assign',
  'manual_exclude',
  'override_remove',
  'group_membership_toggle',
];

const globalKinds: readonly MutationKind[] = [
  'rule_create',
  'rule_condition_edit',
  'rule_enable_toggle',
  'rule_priority_change',
  'rule_effective_date_change',
  'policy_enable_toggle',
];

export function generateMutationPlan(input: {
  seed: number;
  count: number;
  employeeCount: number;
  targetCount: number;
}): PlannedMutation[] {
  if (!Number.isSafeInteger(input.seed)) throw new Error('Mutation seed must be a safe integer');
  if (!Number.isInteger(input.count) || input.count < mutationKinds.length) {
    throw new Error(`Mutation count must be at least ${mutationKinds.length}`);
  }
  if (!Number.isInteger(input.employeeCount) || input.employeeCount < 1) throw new Error('Mutation plan requires employees');
  if (!Number.isInteger(input.targetCount) || input.targetCount < 1) throw new Error('Mutation plan requires rule/policy targets');
  const random = new DeterministicRandom(input.seed);
  const planned: PlannedMutation[] = [];
  const forced: readonly MutationKind[] = [
    'location_change',
    'department_change',
    'employment_type_change',
    'title_change',
    'hire_date_change',
    'group_membership_toggle',
    'manual_assign',
    'manual_exclude',
    'override_remove',
    'date_advance',
    'rule_create',
    'rule_condition_edit',
    'rule_enable_toggle',
    'rule_priority_change',
    'rule_effective_date_change',
    'policy_enable_toggle',
    'duplicate_job_retry',
  ];
  for (let index = 0; index < input.count; index += 1) {
    let kind: MutationKind;
    if (index < forced.length) {
      kind = forced[index]!;
    } else if (index % 10_000 === 1) {
      kind = 'duplicate_job_retry';
    } else if (index % 5_000 === 0) {
      kind = globalKinds[Math.floor(index / 5_000) % globalKinds.length]!;
    } else {
      kind = random.pick(frequentKinds);
    }
    planned.push({
      index,
      kind,
      employeeOrdinal: random.int(input.employeeCount),
      targetOrdinal: random.int(input.targetCount),
      valueOrdinal: random.nextUint32(),
      magnitude: 1 + random.int(90),
    });
  }
  return planned;
}

export function isGlobalMutation(mutation: Pick<PlannedMutation, 'kind'>): boolean {
  return globalMutationKinds.has(mutation.kind);
}

/**
 * Keeps fan-out mutations as singleton correctness checkpoints while packing only
 * employee/category-local work into bounded batches.
 */
export function buildMutationBatches(
  mutations: readonly PlannedMutation[],
  localizedBatchSize: number,
): PlannedMutationBatch[] {
  if (!Number.isInteger(localizedBatchSize) || localizedBatchSize < 1 || localizedBatchSize > 10_000) {
    throw new Error('Localized mutation batch size must be between 1 and 10,000');
  }
  const batches: PlannedMutationBatch[] = [];
  let localized: PlannedMutation[] = [];
  const flushLocalized = (): void => {
    if (localized.length === 0) return;
    batches.push({ kind: 'LOCALIZED', mutations: localized });
    localized = [];
  };
  for (const mutation of mutations) {
    if (isGlobalMutation(mutation)) {
      flushLocalized();
      batches.push({ kind: 'GLOBAL', mutations: [mutation] });
      continue;
    }
    localized.push(mutation);
    if (localized.length === localizedBatchSize) flushLocalized();
  }
  flushLocalized();
  return batches;
}
