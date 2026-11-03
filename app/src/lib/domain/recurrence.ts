import { addDays, addMonths, diffDays, parts } from './dates';
export type Cadence = 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly';
export const CADENCES: Cadence[] = ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'];
const MONTHS: Partial<Record<Cadence, number>> = { monthly: 1, quarterly: 3, yearly: 12 };

/** Next occurrence strictly after `from`, DST-safe because we only use civil dates. `anchor` preserves e.g. the 31st. */
export function nextOccurrence(from: string, cadence: Cadence, anchorDay?: number): string {
  if (cadence === 'daily') return addDays(from, 1);
  if (cadence === 'weekly') return addDays(from, 7);
  if (cadence === 'biweekly') return addDays(from, 14);
  return addMonths(from, MONTHS[cadence]!, anchorDay ?? parts(from).d);
}
/** All occurrences in [start, end] beginning at `first`. */
export function occurrences(first: string, cadence: Cadence, start: string, end: string, endDate?: string | null, limit = 400): string[] {
  const out: string[] = []; const anchor = parts(first).d; let d = first, n = 0;
  while (diffDays(d, end) <= 0 && n++ < limit) {
    if (endDate && diffDays(d, endDate) > 0) break;
    if (diffDays(d, start) >= 0) out.push(d);
    d = nextOccurrence(d, cadence, anchor);
  }
  return out;
}
export const monthlyEquivalent = (amount: number, c: Cadence): number =>
  Math.round(({ daily: 365 / 12, weekly: 52 / 12, biweekly: 26 / 12, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12 } as const)[c] * amount);
