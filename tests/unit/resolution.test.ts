import { describe, expect, it } from 'vitest';
import { resolveCandidates, type AssignmentCandidate } from '../../src/domain/resolution.js';

const candidate = (overrides: Partial<AssignmentCandidate>): AssignmentCandidate => ({
  candidateId: 'rule:1', categoryId: 'category', policyId: 'policy-1', source: 'RULE', action: 'ASSIGN',
  priority: 10, specificity: 1, ...overrides,
});

describe('deterministic conflict resolution', () => {
  it('allows only one winner in SINGLE and uses priority then specificity then stable id', () => {
    const candidates = [
      candidate({ candidateId: 'rule:z', policyId: 'low', priority: 9, specificity: 100 }),
      candidate({ candidateId: 'rule:b', policyId: 'specific', priority: 10, specificity: 2 }),
      candidate({ candidateId: 'rule:a', policyId: 'winner', priority: 10, specificity: 2 }),
    ];
    const result = resolveCandidates('SINGLE', candidates);
    expect(result.winners.map((winner) => winner.policyId)).toEqual(['winner']);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected.every((entry) => entry.wonByCandidateId === 'rule:a')).toBe(true);
  });

  it('retains every distinct policy in MULTIPLE while deduplicating proposals', () => {
    const result = resolveCandidates('MULTIPLE', [
      candidate({ candidateId: 'rule:2', policyId: 'policy-1', priority: 5 }),
      candidate({ candidateId: 'rule:1', policyId: 'policy-1', priority: 10 }),
      candidate({ candidateId: 'rule:3', policyId: 'policy-2' }),
    ]);
    expect(result.winners.map((winner) => winner.policyId).sort()).toEqual(['policy-1', 'policy-2']);
    expect(result.rejected).toHaveLength(1);
  });

  it('makes manual assignment precedence explicit', () => {
    const result = resolveCandidates('SINGLE', [
      candidate({ candidateId: 'rule:high', policyId: 'rule-policy', priority: 999 }),
      candidate({ candidateId: 'manual:low', policyId: 'manual-policy', source: 'MANUAL', priority: -999 }),
    ]);
    expect(result.winners[0]?.policyId).toBe('manual-policy');
    expect(result.rejected[0]?.reason).toMatch(/manual assignments outrank/);
  });

  it('uses a manual exclusion as a policy veto but not as an assignment', () => {
    const result = resolveCandidates('MULTIPLE', [
      candidate({ candidateId: 'rule:1', policyId: 'blocked' }),
      candidate({ candidateId: 'manual:exclude', policyId: 'blocked', source: 'MANUAL', action: 'EXCLUDE' }),
      candidate({ candidateId: 'rule:2', policyId: 'allowed' }),
    ]);
    expect(result.winners.map((winner) => winner.policyId)).toEqual(['allowed']);
    expect(result.rejected.find((entry) => entry.candidate.policyId === 'blocked')?.reason).toBeTruthy();
  });

  it('returns identical results for every input order', () => {
    const candidates = [
      candidate({ candidateId: 'rule:c', policyId: 'p3' }),
      candidate({ candidateId: 'rule:a', policyId: 'p1' }),
      candidate({ candidateId: 'rule:b', policyId: 'p2' }),
    ];
    const expected = resolveCandidates('SINGLE', candidates).winners;
    for (const reordered of [candidates.toReversed(), [candidates[1]!, candidates[2]!, candidates[0]!]]) {
      expect(resolveCandidates('SINGLE', reordered).winners).toEqual(expected);
    }
  });
});
