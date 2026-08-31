import { describe, expect, it } from 'vitest';
import {
  buildMutationBatches,
  generateMutationPlan,
  isGlobalMutation,
  mutationKinds,
} from '../../src/eval/mutations.js';

describe('deterministic regression mutation generator', () => {
  it('replays exactly from a seed and covers every required mutation family', () => {
    const input = { seed: 482_901, count: 20_000, employeeCount: 50_000, targetCount: 300 };
    const first = generateMutationPlan(input);
    const second = generateMutationPlan(input);
    expect(first).toEqual(second);
    expect(first).toHaveLength(20_000);
    expect(new Set(first.map((mutation) => mutation.kind))).toEqual(new Set(mutationKinds));
  });

  it('changes the sequence when the seed changes', () => {
    const first = generateMutationPlan({ seed: 1, count: 100, employeeCount: 10, targetCount: 10 });
    const second = generateMutationPlan({ seed: 2, count: 100, employeeCount: 10, targetCount: 10 });
    expect(first).not.toEqual(second);
  });

  it('batches only localized mutations and isolates every fan-out mutation', () => {
    const plan = generateMutationPlan({ seed: 482_901, count: 20_000, employeeCount: 50_000, targetCount: 300 });
    const batches = buildMutationBatches(plan, 500);
    expect(batches.flatMap((batch) => batch.mutations)).toEqual(plan);
    for (const batch of batches) {
      if (batch.kind === 'GLOBAL') {
        expect(batch.mutations).toHaveLength(1);
        expect(isGlobalMutation(batch.mutations[0]!)).toBe(true);
      } else {
        expect(batch.mutations.length).toBeLessThanOrEqual(500);
        expect(batch.mutations.every((mutation) => !isGlobalMutation(mutation))).toBe(true);
      }
    }
    expect(batches.some((batch) => batch.kind === 'LOCALIZED' && batch.mutations.length === 500)).toBe(true);
  });
});
