import { all, get, run } from './db';
import { Ctx } from './auth';
import * as S from './service';
import { addMonths, today, diffDays } from './domain/dates';
import { convert, formatMoney } from './domain/money';
import { CATALOG, evaluateOffers, OfferMetrics, OfferProfile } from './domain/offers';
import { getProfile } from './profile';

const LOOKBACK = 3;
export function offerMetrics(c: Ctx): OfferMetrics {
  const end = today(), start = addMonths(end, -LOOKBACK);
  const rows = S.spendRows(c, start, end); const byCat: Record<string, number> = {};
  for (const r of rows) byCat[r.cname ?? 'Uncategorized'] = (byCat[r.cname ?? 'Uncategorized'] ?? 0) + r.spend;
  for (const k of Object.keys(byCat)) byCat[k] = Math.round(byCat[k] / LOOKBACK);
  const monthlyExpense = Math.round(rows.reduce((a, r) => a + r.spend, 0) / LOOKBACK);
  const monthlyIncome = Math.round(S.incomeTotal(c, start, end) / LOOKBACK);
  const accts = S.accountsWithBalance(c).filter((a) => !a.is_archived);
  const sum = (f: (a: any) => boolean) => accts.filter(f).reduce((x, a) => x + a.balance_base, 0);
  const checkingBalance = Math.max(0, sum((a) => a.type === 'checking' || a.type === 'cash')), savingsBalance = Math.max(0, sum((a) => a.type === 'savings'));
  const debts = S.debts(c);
  const cards = debts.filter((d) => d.type === 'credit_card'); const cardBal = cards.reduce((a, d) => a + d.balance, 0);
  const cardDebt = cardBal > 0 ? { balance: cardBal, aprPct: Math.max(...cards.map((d) => d.aprPct)), limit: cards.reduce((a, d) => a + (d.limit ?? 0), 0) || null } : null;
  const loans = debts.filter((d) => d.type === 'loan').sort((a, b) => b.aprPct - a.aprPct)[0];
  const subs = S.subscriptionsClassified(c).filter((x) => x.discretionary); const mult: Record<string, number> = { monthly: 1, yearly: 1 / 12, quarterly: 1 / 3, weekly: 52 / 12, biweekly: 26 / 12 };
  const feeCats = ['Fees & Interest'];
  const fees3m = rows.filter((r) => r.cname && feeCats.includes(r.cname)).reduce((a, r) => a + r.spend, 0);
  const fx = all(`SELECT base_amount FROM transactions WHERE workspace_id=? AND deleted_at IS NULL AND kind='expense' AND currency!=? AND posted_date BETWEEN ? AND ?`, c.wid, c.base, start, end);
  const liquid = sum((a) => ['checking', 'savings', 'cash'].includes(a.type));
  return {
    monthly: byCat, monthlyExpense, monthlyIncome, checkingBalance, savingsBalance, hasSavingsAccount: accts.some((a) => a.type === 'savings'),
    cardDebt, loanMaxApr: loans ? { balance: loans.balance, aprPct: loans.aprPct } : null,
    subs: { count: subs.length, monthly: Math.round(subs.reduce((a, s) => a + Math.abs(s.amount) * (mult[s.cadence] ?? 1), 0)), priceHikes: subs.filter((s) => s.priceHike).length },
    fees3m, foreign: { count: fx.length, spend3m: fx.reduce((a, r) => a - r.base_amount, 0) },
    emergencyMonths: monthlyExpense > 0 ? Math.max(0, liquid) / monthlyExpense : null, months: LOOKBACK,
  };
}

const ageOf = (dob?: string | null) => (dob ? Math.floor(diffDays(today(), dob) / 365.25) : null);
export function offersFor(c: Ctx) {
  const prof = getProfile(c.userId);
  const p: OfferProfile = prof.personalize_offers ? { employment_type: prof.employment_type, goals: prof.goals, age: ageOf(prof.date_of_birth), household_size: prof.household_size, risk_tolerance: prof.risk_tolerance } : {};
  const r = S.rate('USD', c.base);
  const usd = (d: number) => convert(Math.round(d * 100), r, 'USD', c.base);
  const metrics = offerMetrics(c);
  const status = new Map(all('SELECT offer_id,status FROM offer_actions WHERE workspace_id=?', c.wid).map((x) => [x.offer_id as string, x.status as string]));
  const items = evaluateOffers(metrics, p, usd, (n) => formatMoney(n, c.base)).map((o) => ({ ...o, status: status.get(o.id) ?? 'new' }));
  const eligible = items.filter((o) => o.eligible);
  return {
    base: c.base, lookback_months: LOOKBACK, personalized_with_profile: !!prof.personalize_offers, sample_catalog: true,
    has_history: (get('SELECT COUNT(*) n FROM transactions WHERE workspace_id=? AND deleted_at IS NULL', c.wid) as { n: number }).n > 0,
    total_potential: eligible.filter((o) => o.status !== 'dismissed').reduce((a, o) => a + (o.annual_benefit ?? 0), 0),
    eligible, other: items.filter((o) => !o.eligible),
  };
}
export function setOfferStatus(c: Ctx, id: string, status: 'new' | 'saved' | 'dismissed') {
  if (!CATALOG.some((o) => o.id === id)) return false;
  if (status === 'new') run('DELETE FROM offer_actions WHERE workspace_id=? AND offer_id=?', c.wid, id);
  else run(`INSERT INTO offer_actions(workspace_id,offer_id,status) VALUES(?,?,?) ON CONFLICT(workspace_id,offer_id) DO UPDATE SET status=excluded.status, updated_at=CURRENT_TIMESTAMP`, c.wid, id, status);
  return true;
}
