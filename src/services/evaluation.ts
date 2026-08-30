import { isActiveOn } from '../domain/dates.js';
import {
  type AssignmentCandidate,
  type Cardinality,
  type RejectedCandidate,
  resolveCandidates,
} from '../domain/resolution.js';
import {
  fingerprint,
  type EmployeeSnapshot,
  type EvaluationResult,
  RuleCompilerCache,
  type RuleCondition,
} from '../domain/rules.js';

export interface EvaluatableRule {
  ruleId: string;
  ruleVersionId: string;
  policyId: string;
  categoryId: string;
  priority: number;
  enabled: boolean;
  validFrom: string;
  validTo: string | null;
  condition: RuleCondition;
  contentHash: string;
  specificity: number;
  policyEnabled: boolean;
}

export interface EvaluatableOverride {
  id: string;
  policyId: string;
  categoryId: string;
  action: 'ASSIGN' | 'EXCLUDE';
  priority: number;
  reason: string;
  validFrom: string;
  validTo: string | null;
}

export interface RuleEvaluationRecord {
  ruleVersionId: string;
  result: EvaluationResult;
}

export interface CategoryEvaluation {
  candidates: AssignmentCandidate[];
  winners: AssignmentCandidate[];
  rejected: RejectedCandidate[];
  ruleEvaluations: RuleEvaluationRecord[];
  inputFingerprint: string;
  nextTransitionDate: string | null;
  transitions: EvaluationTransition[];
}

export interface EvaluationTransition {
  sourceType: 'RULE' | 'OVERRIDE';
  sourceId: string;
  date: string;
  reason: string;
}

export class PolicyEvaluator {
  constructor(private readonly compiler = new RuleCompilerCache()) {}

  evaluateCategory(input: {
    snapshot: EmployeeSnapshot;
    categoryId: string;
    cardinality: Cardinality;
    rules: readonly EvaluatableRule[];
    overrides: readonly EvaluatableOverride[];
  }): CategoryEvaluation {
    const candidates: AssignmentCandidate[] = [];
    const ruleEvaluations: RuleEvaluationRecord[] = [];
    const transitions: EvaluationTransition[] = [];

    for (const rule of [...input.rules].sort((left, right) => left.ruleVersionId.localeCompare(right.ruleVersionId))) {
      if (rule.categoryId !== input.categoryId) throw new Error('Evaluation received a rule from another category');
      const compiled = this.compiler.get(rule.ruleVersionId, rule.condition, rule.contentHash);
      const result = compiled.evaluate(input.snapshot, { validFrom: rule.validFrom, validTo: rule.validTo });
      ruleEvaluations.push({ ruleVersionId: rule.ruleVersionId, result });
      if (result.nextTransitionDate !== null) {
        transitions.push({
          sourceType: 'RULE',
          sourceId: rule.ruleVersionId,
          date: result.nextTransitionDate,
          reason: 'Rule condition or effective window may change',
        });
      }
      if (!rule.enabled || !rule.policyEnabled || !isActiveOn(rule.validFrom, rule.validTo, input.snapshot.asOfDate)) continue;
      if (!result.matched) continue;
      candidates.push({
        candidateId: `rule:${rule.ruleVersionId}`,
        categoryId: rule.categoryId,
        policyId: rule.policyId,
        source: 'RULE',
        action: 'ASSIGN',
        priority: rule.priority,
        specificity: rule.specificity,
        ruleId: rule.ruleId,
        ruleVersionId: rule.ruleVersionId,
        trace: result.trace,
      });
    }

    for (const override of [...input.overrides].sort((left, right) => left.id.localeCompare(right.id))) {
      if (override.categoryId !== input.categoryId) throw new Error('Evaluation received an override from another category');
      if (override.validTo !== null && override.validTo > input.snapshot.asOfDate) {
        transitions.push({
          sourceType: 'OVERRIDE',
          sourceId: override.id,
          date: override.validTo,
          reason: 'Manual override expires',
        });
      }
      if (override.validFrom > input.snapshot.asOfDate) {
        transitions.push({
          sourceType: 'OVERRIDE',
          sourceId: override.id,
          date: override.validFrom,
          reason: 'Manual override becomes effective',
        });
      }
      if (!isActiveOn(override.validFrom, override.validTo, input.snapshot.asOfDate)) continue;
      candidates.push({
        candidateId: `manual:${override.id}`,
        categoryId: override.categoryId,
        policyId: override.policyId,
        source: 'MANUAL',
        action: override.action,
        priority: override.priority,
        specificity: Number.MAX_SAFE_INTEGER,
        overrideId: override.id,
        reason: override.reason,
      });
    }

    const resolution = resolveCandidates(input.cardinality, candidates);
    const uniqueTransitions = [...new Map(
      transitions
        .filter((transition) => transition.date > input.snapshot.asOfDate)
        .map((transition) => [`${transition.sourceType}:${transition.sourceId}:${transition.date}`, transition]),
    ).values()].sort((left, right) => left.date.localeCompare(right.date));
    const nextTransitionDate = uniqueTransitions[0]?.date ?? null;
    return {
      candidates,
      winners: resolution.winners,
      rejected: resolution.rejected,
      ruleEvaluations,
      nextTransitionDate,
      transitions: uniqueTransitions,
      inputFingerprint: fingerprint({
        snapshot: {
          ...input.snapshot,
          groupIds: [...input.snapshot.groupIds].sort(),
        },
        categoryId: input.categoryId,
        cardinality: input.cardinality,
        rules: input.rules.map((rule) => ({
          id: rule.ruleVersionId,
          hash: rule.contentHash,
          priority: rule.priority,
          enabled: rule.enabled,
          validFrom: rule.validFrom,
          validTo: rule.validTo,
          policyEnabled: rule.policyEnabled,
        })),
        overrides: input.overrides,
      }),
    };
  }
}
