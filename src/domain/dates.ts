import { isoDateSchema } from './rules.js';

export function todayUtc(clock: () => Date = () => new Date()): string {
  return clock().toISOString().slice(0, 10);
}

export function assertIsoDate(value: string): string {
  return isoDateSchema.parse(value);
}

export function isActiveOn(validFrom: string, validTo: string | null, asOfDate: string): boolean {
  return validFrom <= asOfDate && (validTo === null || validTo > asOfDate);
}
