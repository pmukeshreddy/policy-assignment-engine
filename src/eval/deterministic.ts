import { createHash } from 'node:crypto';

export class DeterministicRandom {
  private state: number;

  constructor(seed: number) {
    if (!Number.isSafeInteger(seed)) throw new Error('Deterministic seed must be a safe integer');
    this.state = seed >>> 0;
    if (this.state === 0) this.state = 0x9e3779b9;
  }

  nextUint32(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state;
  }

  int(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive < 1) throw new Error('Random bound must be a positive integer');
    return this.nextUint32() % maxExclusive;
  }

  bool(numerator = 1, denominator = 2): boolean {
    if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || numerator < 0 || denominator < 1 || numerator > denominator) {
      throw new Error('Invalid deterministic probability');
    }
    return this.int(denominator) < numerator;
  }

  pick<T>(values: readonly T[]): T {
    if (values.length === 0) throw new Error('Cannot choose from an empty list');
    return values[this.int(values.length)]!;
  }
}

export function deterministicUuid(namespace: string): string {
  const bytes = Buffer.from(createHash('sha256').update(namespace).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function addDays(date: string, days: number): string {
  const epochDay = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
  return new Date((epochDay + days) * 86_400_000).toISOString().slice(0, 10);
}
