import { addDays, diffDays } from './dates';
import { Cadence, occurrences, nextOccurrence, monthlyEquivalent } from './recurrence';

export interface Txn { id: number; date: string; amount: number; merchant: string | null; category: string | null; kind: 'income' | 'expense' | 'transfer'; description?: string }

// ---------- Subscription detection (>=3 occurrences, near-constant amount, regular cadence) ----------
export interface DetectedSub { merchant: string; amount: number; cadence: Cadence; occurrences: number; lastDate: string; nextCharge: string; priceHike?: { from: number; to: number } }
const CAD: [Cadence, number, number][] = [['weekly', 7, 1], ['biweekly', 14, 2], ['monthly', 30.4, 4], ['quarterly', 91, 8], ['yearly', 365, 15]];
export function detectSubscriptions(txns: Txn[]): DetectedSub[] {
  const by = new Map<string, Txn[]>();
  for (const t of txns) if (t.kind === 'expense' && t.merchant) { const k = t.merchant; (by.get(k) ?? by.set(k, []).get(k)!).push(t); }
  const out: DetectedSub[] = [];
  for (const [merchant, list] of by) {
    if (list.length < 3) continue;
    list.sort((a, b) => a.date.localeCompare(b.date));
    const gaps = list.slice(1).map((t, i) => diffDays(t.date, list[i].date));
    const med = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
    const cad = CAD.find(([, d, tol]) => Math.abs(med - d) <= tol); if (!cad) continue;
    if (gaps.filter((g) => Math.abs(g - med) <= cad[2] + 2).length / gaps.length < 0.75) continue;
    const amts = list.map((t) => Math.abs(t.amount)); const last = amts[amts.length - 1];
    const base = [...amts].sort((a, b) => a - b)[Math.floor(amts.length / 2)];
    const stable = amts.slice(0, -1).every((a) => Math.abs(a - base) / base <= 0.1);
    if (!stable) continue;
    const lastDate = list[list.length - 1].date;
    out.push({ merchant, amount: last, cadence: cad[0], occurrences: list.length, lastDate, nextCharge: nextOccurrence(lastDate, cad[0]),
      priceHike: last > base * 1.05 ? { from: base, to: last } : undefined });
  }
  return out.sort((a, b) => monthlyEquivalent(b.amount, b.cadence) - monthlyEquivalent(a.amount, a.cadence));
}

// ---------- Cash-flow forecast: balance + scheduled items + trailing variable spend ----------
export interface Scheduled { name: string; amount: number; cadence: Cadence; nextDue: string; endDate?: string | null }
export function forecast(opts: { balance: number; today: string; days: number; scheduled: Scheduled[]; variableDailySpend: number; variableStd?: number }) {
  const end = addDays(opts.today, opts.days); const events = new Map<string, number>();
  for (const s of opts.scheduled) for (const d of occurrences(s.nextDue, s.cadence, opts.today, end, s.endDate)) events.set(d, (events.get(d) ?? 0) + s.amount);
  const pts: { date: string; base: number; low: number; high: number }[] = []; let bal = opts.balance;
  const std = opts.variableStd ?? opts.variableDailySpend * 0.3;
  for (let i = 0; i <= opts.days; i++) {
    const d = addDays(opts.today, i);
    if (i > 0) bal += (events.get(d) ?? 0) - opts.variableDailySpend;
    const band = std * Math.sqrt(i);
    pts.push({ date: d, base: Math.round(bal), low: Math.round(bal - band), high: Math.round(bal + band) });
  }
  return { points: pts, minBalance: Math.min(...pts.map((p) => p.low)), endBalance: pts[pts.length - 1].base };
}

// ---------- Safe-to-spend (plan 10.2) ----------
export function safeToSpend(i: { spendable: number; upcomingBills: number; sinkingSetAside: number; essentialsRemaining: number }) {
  const value = i.spendable - i.upcomingBills - i.sinkingSetAside - i.essentialsRemaining;
  return { value, ...i };
}

// ---------- Insights (rule-based; every insight carries its evidence transaction ids) ----------
export interface Insight { type: string; severity: 'info' | 'warn' | 'good'; title: string; detail: string; txnIds: number[] }
export function insights(i: { txns: Txn[]; thisMonth: string; lastMonth: string; subs: DetectedSub[]; fmt: (n: number) => string }): Insight[] {
  const out: Insight[] = []; const exp = i.txns.filter((t) => t.kind === 'expense');
  const sum = (m: string, cat?: string) => exp.filter((t) => t.date.startsWith(m) && (!cat || t.category === cat)).reduce((a, t) => a + Math.abs(t.amount), 0);
  const cats = new Set(exp.filter((t) => t.date.startsWith(i.thisMonth)).map((t) => t.category ?? 'Uncategorized'));
  for (const c of cats) {
    const a = sum(i.thisMonth, c === 'Uncategorized' ? undefined : c), b = sum(i.lastMonth, c === 'Uncategorized' ? undefined : c);
    if (c !== 'Uncategorized' && b > 0 && a > b * 1.3 && a - b > 2000)
      out.push({ type: 'category_up', severity: 'warn', title: `${c} spending is up ${Math.round(((a - b) / b) * 100)}%`, detail: `${i.fmt(a)} this month vs ${i.fmt(b)} last month.`, txnIds: exp.filter((t) => t.category === c && t.date.startsWith(i.thisMonth)).map((t) => t.id) });
  }
  // duplicate charges
  const seen = new Map<string, Txn>();
  for (const t of exp) { const k = `${t.merchant}|${t.amount}`; const p = seen.get(k); if (p && Math.abs(diffDays(t.date, p.date)) <= 1 && t.merchant) out.push({ type: 'duplicate', severity: 'warn', title: `Possible duplicate charge at ${t.merchant}`, detail: `${i.fmt(Math.abs(t.amount))} charged twice within a day.`, txnIds: [p.id, t.id] }); seen.set(k, t); }
  // unusual amount (>3x merchant median, min 3 prior)
  const byM = new Map<string, Txn[]>(); for (const t of exp) if (t.merchant) (byM.get(t.merchant) ?? byM.set(t.merchant, []).get(t.merchant)!).push(t);
  for (const [m, l] of byM) if (l.length >= 4) {
    const s = l.map((t) => Math.abs(t.amount)).sort((a, b) => a - b); const med = s[Math.floor(s.length / 2)];
    const big = l.filter((t) => t.date.startsWith(i.thisMonth) && Math.abs(t.amount) > med * 3 && Math.abs(t.amount) - med > 5000);
    for (const t of big) out.push({ type: 'unusual', severity: 'info', title: `Unusually large charge at ${m}`, detail: `${i.fmt(Math.abs(t.amount))} vs typical ${i.fmt(med)}.`, txnIds: [t.id] });
  }
  for (const s of i.subs) if (s.priceHike) out.push({ type: 'price_hike', severity: 'warn', title: `${s.merchant} price increased`, detail: `${i.fmt(s.priceHike.from)} → ${i.fmt(s.priceHike.to)} per ${s.cadence} charge.`, txnIds: [] });
  const inc = i.txns.filter((t) => t.kind === 'income' && t.date.startsWith(i.thisMonth)).reduce((a, t) => a + t.amount, 0), ex = sum(i.thisMonth);
  if (inc > 0 && ex < inc * 0.8) out.push({ type: 'saving', severity: 'good', title: `You're saving ${Math.round((1 - ex / inc) * 100)}% of income this month`, detail: `${i.fmt(inc - ex)} left after ${i.fmt(ex)} of spending.`, txnIds: [] });
  return out;
}

// ---------- Financial health score (explainable) ----------
export interface HealthFactor { name: string; score: number; weight: number; note: string }
export function healthScore(i: { savingsRate: number | null; emergencyMonths: number | null; debtToIncome: number | null; budgetAdherence: number | null; billsOnTime: number | null }) {
  const clamp = (x: number) => Math.max(0, Math.min(100, x));
  const f: HealthFactor[] = [];
  if (i.savingsRate != null) f.push({ name: 'Savings rate', weight: 30, score: clamp((i.savingsRate / 0.2) * 100), note: `${Math.round(i.savingsRate * 100)}% of income saved (target 20%)` });
  if (i.emergencyMonths != null) f.push({ name: 'Emergency fund', weight: 25, score: clamp((i.emergencyMonths / 6) * 100), note: `${i.emergencyMonths.toFixed(1)} months of expenses (target 6)` });
  if (i.debtToIncome != null) f.push({ name: 'Debt load', weight: 20, score: clamp(100 - (i.debtToIncome / 0.4) * 100), note: `Debt payments are ${Math.round(i.debtToIncome * 100)}% of income (healthy < 36%)` });
  if (i.budgetAdherence != null) f.push({ name: 'Budget adherence', weight: 15, score: clamp(i.budgetAdherence * 100), note: `${Math.round(i.budgetAdherence * 100)}% of budget lines on track` });
  if (i.billsOnTime != null) f.push({ name: 'Bills on time', weight: 10, score: clamp(i.billsOnTime * 100), note: `${Math.round(i.billsOnTime * 100)}% of bills paid on time` });
  const w = f.reduce((a, x) => a + x.weight, 0);
  return { score: w ? Math.round(f.reduce((a, x) => a + x.score * x.weight, 0) / w) : null, factors: f };
}

// ---------- Credit card cycle ----------
export function statementCycle(today: string, closeDay: number, dueDay: number) {
  const { y, m, d } = { y: +today.slice(0, 4), m: +today.slice(5, 7), d: +today.slice(8, 10) };
  const clamp = (yy: number, mm: number, day: number) => Math.min(day, new Date(Date.UTC(yy, mm, 0)).getUTCDate());
  const p = (yy: number, mm: number, dd: number) => `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  let cy = y, cm = m; if (d <= clamp(y, m, closeDay)) { cm -= 1; if (cm === 0) { cm = 12; cy -= 1; } }
  const lastClose = p(cy, cm, clamp(cy, cm, closeDay));
  let dy = cy, dm = cm; if (dueDay <= closeDay) { dm += 1; if (dm === 13) { dm = 1; dy += 1; } }
  const due = p(dy, dm, clamp(dy, dm, dueDay));
  return { lastClose, due, daysToDue: diffDays(due, today) };
}
