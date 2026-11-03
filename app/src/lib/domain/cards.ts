/** Pure card helpers. Only the last four digits are ever stored; anything that looks like a full card number is rejected. */
import { diffDays, fmt, parts, daysInMonth } from './dates';

export const KINDS = ['debit', 'credit', 'prepaid', 'forex'] as const;
export const NETWORKS = ['visa', 'mastercard', 'rupay', 'amex', 'diners', 'other'] as const;
export const STATUSES = ['active', 'blocked', 'expired'] as const;

export function luhn(digits: string): boolean {
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) { let n = +digits[i]; if (alt) { n *= 2; if (n > 9) n -= 9; } sum += n; alt = !alt; }
  return sum % 10 === 0;
}
/** True when the text contains a 13-19 digit run (spaces/dashes allowed) that passes the Luhn check, i.e. a plausible full card number. */
export function containsCardNumber(text: string): boolean {
  for (const m of text.matchAll(/(?:\d[ -]?){13,19}/g)) { const d = m[0].replace(/[ -]/g, ''); if (d.length >= 13 && d.length <= 19 && luhn(d)) return true; }
  return false;
}
export type ExpiryState = 'unknown' | 'ok' | 'expiring' | 'expired';
/** Cards expire at the end of their expiry month. "expiring" = within 60 days. */
export function expiryState(month: number | null | undefined, year: number | null | undefined, today: string): { state: ExpiryState; daysLeft: number | null } {
  if (!month || !year) return { state: 'unknown', daysLeft: null };
  const y = year < 100 ? 2000 + year : year; const end = fmt(y, month, daysInMonth(y, month)); const d = diffDays(end, today);
  return { state: d < 0 ? 'expired' : d <= 60 ? 'expiring' : 'ok', daysLeft: d };
}
export const utilization = (used: number, limit: number | null | undefined) => (limit && limit > 0 ? Math.max(0, used) / limit : null);
/** Amber from 30%, red from 70%, the usual guidance for credit-score friendly utilization. */
export const utilizationBand = (u: number | null): 'good' | 'fair' | 'high' | 'unknown' => (u == null ? 'unknown' : u < 0.3 ? 'good' : u < 0.7 ? 'fair' : 'high');
export function feeWaiverProgress(spentYear: number, waiverSpend: number | null | undefined, annualFee: number | null | undefined) {
  if (!annualFee || !waiverSpend) return null;
  return { pct: Math.min(1, spentYear / waiverSpend), remaining: Math.max(0, waiverSpend - spentYear), fee: annualFee, waived: spentYear >= waiverSpend };
}
/** Next occurrence of a day-of-month on or after `today` (clamped to short months). */
export function nextDayOfMonth(day: number, today: string): string {
  const p = parts(today); const mk = (y: number, m: number) => fmt(y, m, Math.min(day, daysInMonth(y, m)));
  const cand = mk(p.y, p.m); if (cand >= today) return cand; return p.m === 12 ? mk(p.y + 1, 1) : mk(p.y, p.m + 1);
}
export const lastFour = (v: string) => /^\d{4}$/.test(v.trim());
