import type { ConditionTrace } from './rules.js';

export type Cardinality = 'SINGLE' | 'MULTIPLE';
export type CandidateSource = 'RULE' | 'MANUAL';
export type CandidateAction = 'ASSIGN' | 'EXCLUDE';

export interface AssignmentCandidate {
  candidateId: string;
  categoryId: string;
  policyId: string;
  source: CandidateSource;
  action: CandidateAction;
  priority: number;
  specificity: number;
  ruleId?: string;
  ruleVersionId?: string;
  overrideId?: string;
  trace?: readonly ConditionTrace[];
  reason?: string;
}

export interface RejectedCandidate {
  candidate: AssignmentCandidate;
  reason: string;
  wonByCandidateId?: string;
}

export interface ResolutionResult {
  winners: AssignmentCandidate[];
  rejected: RejectedCandidate[];
}

function comparePrecedence(left: AssignmentCandidate, right: AssignmentCandidate): number {
  const source = Number(right.source === 'MANUAL') - Number(left.source === 'MANUAL');
  if (source !== 0) return source;
  const priority = right.priority - left.priority;
  if (priority !== 0) return priority;
  const specificity = right.specificity - left.specificity;
  if (specificity !== 0) return specificity;
  const sourceId = left.candidateId.localeCompare(right.candidateId);
  if (sourceId !== 0) return sourceId;
  return left.policyId.localeCompare(right.policyId);
}

export function resolveCandidates(cardinality: Cardinality, candidates: readonly AssignmentCandidate[]): ResolutionResult {
  if (candidates.some((candidate) => candidate.categoryId !== candidates[0]?.categoryId)) {
    throw new Error('Conflict resolution requires candidates from exactly one category');
  }

  const rejected: RejectedCandidate[] = [];
  const policyWinners: AssignmentCandidate[] = [];
  const byPolicy = new Map<string, AssignmentCandidate[]>();
  for (const candidate of candidates) {
    const existing = byPolicy.get(candidate.policyId) ?? [];
    existing.push(candidate);
    byPolicy.set(candidate.policyId, existing);
  }

  for (const policyCandidates of byPolicy.values()) {
    const ordered = [...policyCandidates].sort(comparePrecedence);
    const controlling = ordered[0];
    if (controlling === undefined) continue;
    if (controlling.action === 'EXCLUDE') {
      rejected.push({ candidate: controlling, reason: 'Manual exclusion controlled this policy' });
      for (const candidate of ordered.slice(1)) {
        rejected.push({
          candidate,
          reason: 'Policy was vetoed by a higher-precedence manual exclusion',
          wonByCandidateId: controlling.candidateId,
        });
      }
      continue;
    }
    policyWinners.push(controlling);
    for (const candidate of ordered.slice(1)) {
      rejected.push({
        candidate,
        reason: 'Duplicate proposal for the same policy had lower precedence',
        wonByCandidateId: controlling.candidateId,
      });
    }
  }

  const orderedPolicies = policyWinners.sort(comparePrecedence);
  if (cardinality === 'MULTIPLE') return { winners: orderedPolicies, rejected };
  const winner = orderedPolicies[0];
  if (winner === undefined) return { winners: [], rejected };
  for (const candidate of orderedPolicies.slice(1)) {
    rejected.push({
      candidate,
      reason: describeLoss(candidate, winner),
      wonByCandidateId: winner.candidateId,
    });
  }
  return { winners: [winner], rejected };
}

function describeLoss(loser: AssignmentCandidate, winner: AssignmentCandidate): string {
  if (loser.source !== winner.source) return 'Another policy won because manual assignments outrank rule proposals';
  if (loser.priority !== winner.priority) return 'Another policy won because it had higher priority';
  if (loser.specificity !== winner.specificity) return 'Another policy won because its rule was more specific';
  return 'Another policy won by the stable candidate identifier tie-break';
}
