import { addMonths } from './dates';
export interface Debt { id: number | string; name: string; balance: number; aprPct: number; minPayment: number }
export type Strategy = 'avalanche' | 'snowball';
export interface PayoffResult {
  months: number; payoffDate: string | null; totalInterest: number; feasible: boolean;
  perDebt: { id: Debt['id']; name: string; paidOffMonth: number; interest: number }[];
  timeline: { month: number; total: number }[];
}
/** Month-by-month simulation. `extra` is added on top of all minimums and rolls over as debts are cleared. */
export function payoffPlan(debts: Debt[], strategy: Strategy, extra: number, startDate: string): PayoffResult {
  const ds = debts.filter((d) => d.balance > 0).map((d) => ({ ...d, bal: d.balance, interest: 0, paid: 0 }));
  const budget = ds.reduce((a, d) => a + d.minPayment, 0) + extra;
  const timeline: PayoffResult['timeline'] = [{ month: 0, total: ds.reduce((a, d) => a + d.bal, 0) }];
  let month = 0;
  while (ds.some((d) => d.bal > 0) && month < 1200) {
    month++;
    for (const d of ds) if (d.bal > 0) { const i = Math.round((d.bal * d.aprPct) / 1200); d.bal += i; d.interest += i; }
    let pool = budget;
    for (const d of ds) if (d.bal > 0) { const p = Math.min(d.bal, d.minPayment, pool); d.bal -= p; pool -= p; if (d.bal === 0 && !d.paid) d.paid = month; }
    const order = ds.filter((d) => d.bal > 0).sort((a, b) => strategy === 'avalanche' ? b.aprPct - a.aprPct || a.bal - b.bal : a.bal - b.bal || b.aprPct - a.aprPct);
    for (const d of order) { if (pool <= 0) break; const p = Math.min(d.bal, pool); d.bal -= p; pool -= p; if (d.bal === 0) d.paid = month; }
    timeline.push({ month, total: ds.reduce((a, d) => a + d.bal, 0) });
    if (budget <= 0) break;
  }
  const feasible = ds.every((d) => d.bal === 0);
  return {
    months: month, feasible, payoffDate: feasible ? addMonths(startDate, month) : null,
    totalInterest: ds.reduce((a, d) => a + d.interest, 0),
    perDebt: ds.map((d) => ({ id: d.id, name: d.name, paidOffMonth: d.paid, interest: d.interest })), timeline,
  };
}
