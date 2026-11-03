/** Turns bureau tradelines into the factors people can act on. Pure; used for both sandbox and live provider data. */
export type AccountType = 'credit_card' | 'personal_loan' | 'auto_loan' | 'home_loan' | 'consumer_loan';
export interface Tradeline { type: AccountType; lender: string; opened: string; limit_or_amount: number; balance: number; overdue: number; status: 'active' | 'closed'; dpd_history: number[] }   // paise; dpd_history: newest first, days past due per month
export interface Enquiry { date: string; lender: string; purpose: string }
export type Band = 'poor' | 'fair' | 'good' | 'very_good' | 'excellent';
export interface Factor { id: string; name: string; weight: number; value: string; status: 'good' | 'fair' | 'poor'; detail: string; tip: string }

export const bandOf = (s: number): Band => (s >= 800 ? 'excellent' : s >= 750 ? 'very_good' : s >= 650 ? 'good' : s >= 550 ? 'fair' : 'poor');
const clamp = (x: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const monthsBetween = (a: string, b: string) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));

export function analyze(lines: Tradeline[], enquiries: Enquiry[], today: string) {
  const active = lines.filter((l) => l.status === 'active'); const cards = active.filter((l) => l.type === 'credit_card');
  const hist = lines.flatMap((l) => l.dpd_history.slice(0, 24)); const onTime = hist.length ? hist.filter((d) => d === 0).length / hist.length : 1; const late90 = hist.filter((d) => d >= 90).length, late30 = hist.filter((d) => d >= 30 && d < 90).length;
  const limit = cards.reduce((a, l) => a + l.limit_or_amount, 0), owed = cards.reduce((a, l) => a + l.balance, 0); const util = limit ? owed / limit : 0;
  const ages = lines.map((l) => monthsBetween(l.opened, today)); const avgAge = ages.length ? ages.reduce((a, b) => a + b, 0) / ages.length : 0; const oldest = ages.length ? Math.max(...ages) : 0;
  const types = new Set(lines.map((l) => l.type)); const secured = lines.some((l) => l.type === 'home_loan' || l.type === 'auto_loan'); const enq6 = enquiries.filter((e) => monthsBetween(e.date, today) <= 6).length;
  const overdue = lines.reduce((a, l) => a + l.overdue, 0);
  const st = (v: number, good: number, fair: number): 'good' | 'fair' | 'poor' => (v >= good ? 'good' : v >= fair ? 'fair' : 'poor');
  const f: Factor[] = [
    { id: 'payment', name: 'Payment history', weight: 35, value: `${Math.round(onTime * 100)}% on time`, status: late90 ? 'poor' : st(onTime, 0.98, 0.9), detail: `${late30} payment(s) 30-89 days late and ${late90} 90+ days late in the last 24 months.`, tip: 'Set up auto-pay for at least the minimum due on every card and EMI; one 30-day delay can cost dozens of points.' },
    { id: 'utilization', name: 'Credit card utilization', weight: 30, value: limit ? `${Math.round(util * 100)}%` : 'no cards', status: limit ? (util <= 0.3 ? 'good' : util <= 0.5 ? 'fair' : 'poor') : 'good', detail: limit ? `Using ${Math.round(util * 100)}% of the combined card limit.` : 'No active credit cards.', tip: 'Keep each card below 30% of its limit: pay before the statement date or ask for a limit increase.' },
    { id: 'age', name: 'Credit age', weight: 15, value: `${(avgAge / 12).toFixed(1)} yrs average`, status: st(avgAge, 60, 24), detail: `Oldest account is ${(oldest / 12).toFixed(1)} years old.`, tip: 'Keep your oldest card open, even if you rarely use it.' },
    { id: 'mix', name: 'Credit mix', weight: 10, value: `${types.size} type(s)`, status: types.size >= 3 || (types.size >= 2 && secured) ? 'good' : types.size >= 2 ? 'fair' : 'poor', detail: secured ? 'Includes a secured loan.' : 'No secured loan (home or auto).', tip: 'A healthy mix of secured and unsecured credit helps, but do not borrow just to improve the mix.' },
    { id: 'enquiries', name: 'Recent enquiries', weight: 10, value: `${enq6} in 6 months`, status: enq6 <= 2 ? 'good' : enq6 <= 4 ? 'fair' : 'poor', detail: 'Each new credit application leaves a hard enquiry for 2 years.', tip: 'Space out applications; compare offers without applying where lenders allow it.' },
  ];
  // Transparent estimate, NOT the bureau's proprietary model: weighted sub-scores mapped onto 300-900.
  const sub = { payment: late90 ? 0.15 : clamp((onTime - 0.7) / 0.3) * (late30 ? 0.85 : 1), utilization: limit ? clamp(1 - Math.max(0, util - 0.1) / 0.8) : 0.8, age: clamp(avgAge / 84), mix: clamp(types.size / 4 + (secured ? 0.15 : 0)), enquiries: clamp(1 - enq6 / 6) };
  const w = { payment: 0.35, utilization: 0.3, age: 0.15, mix: 0.1, enquiries: 0.1 }; const raw = (Object.keys(w) as (keyof typeof w)[]).reduce((a, k) => a + sub[k] * w[k], 0);
  const estimate = Math.round(300 + raw * 600) - (overdue > 0 ? 25 : 0);
  return { factors: f, estimate: Math.max(300, Math.min(900, estimate)), summary: { accounts: lines.length, active: active.length, total_limit: limit, card_balance: owed, utilization: util, overdue_amount: overdue, enquiries_6m: enq6, on_time_pct: onTime } };
}
