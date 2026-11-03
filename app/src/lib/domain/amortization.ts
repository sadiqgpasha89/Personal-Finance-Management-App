import { addMonths } from './dates';
export interface AmortRow { n: number; date: string; payment: number; principal: number; interest: number; extra: number; balance: number }
/** Fixed payment for a fixed-rate loan, in minor units (rounded). */
export function monthlyPayment(principal: number, aprPct: number, termMonths: number): number {
  const r = aprPct / 100 / 12;
  if (termMonths <= 0) return principal;
  if (r === 0) return Math.round(principal / termMonths);
  return Math.round((principal * r) / (1 - Math.pow(1 + r, -termMonths)));
}
export function schedule(opts: { principal: number; aprPct: number; payment: number; startDate: string; extraMonthly?: number; maxMonths?: number }) {
  const { principal, aprPct, payment, startDate, extraMonthly = 0, maxMonths = 1200 } = opts;
  const r = aprPct / 100 / 12; const rows: AmortRow[] = []; let bal = principal, totalInterest = 0;
  for (let n = 1; bal > 0 && n <= maxMonths; n++) {
    const interest = Math.round(bal * r);
    if (payment + extraMonthly <= interest && r > 0) return { rows, totalInterest, payoffDate: null as string | null, neverPaysOff: true };
    let principalPart = Math.min(bal, payment - interest);
    let extra = Math.min(bal - principalPart, extraMonthly);
    const pay = principalPart + interest + extra;
    bal -= principalPart + extra; totalInterest += interest;
    rows.push({ n, date: addMonths(startDate, n), payment: pay - extra, principal: principalPart, interest, extra, balance: bal });
  }
  return { rows, totalInterest, payoffDate: rows.length ? rows[rows.length - 1].date : startDate, neverPaysOff: false };
}
