import { z } from 'zod';
import { all, get } from '../db';
import { Ctx } from '../auth';
import * as S from '../service';
import { offersFor } from '../offers';
import { listCards } from '../cards';
import { upiSummary } from '../upi';
import { creditOverview } from '../credit';
import { addDays, isDate, today } from '../domain/dates';
import { formatMoney } from '../domain/money';

/**
 * Read-only data tools shared by the Claude agent and the offline engine.
 * The model never sees SQL or other workspaces: every tool is scoped to the caller's workspace and returns
 * display-ready values (money as formatted strings, numbers as plain figures) so it does not do currency arithmetic.
 */
const fmt0 = (n: number, cur: string) => formatMoney(n, cur);
const dateStr = z.string().refine(isDate, 'Use YYYY-MM-DD');
const f = (c: Ctx) => (n: number) => formatMoney(n, c.base);
const catId = (c: Ctx, name?: string) => {
  if (!name) return undefined;
  const r = get(`SELECT id FROM categories WHERE workspace_id=? AND (name=? COLLATE NOCASE OR name LIKE ? COLLATE NOCASE) ORDER BY (name=? COLLATE NOCASE) DESC LIMIT 1`, c.wid, name, `%${name.replace(/[%_]/g, '')}%`, name);
  return r?.id as number | undefined;
};

interface Tool<T extends z.ZodTypeAny = z.ZodTypeAny> { name: string; description: string; schema: T; run: (c: Ctx, a: z.infer<T>) => unknown }
const tool = <T extends z.ZodTypeAny>(t: Tool<T>) => t as unknown as Tool;

export const TOOLS: Tool[] = [
  tool({
    name: 'search_transactions',
    description: 'Find individual transactions. Use for "show/list/find" questions, the largest or most recent purchases, or a specific merchant. Returns up to `limit` rows plus the total count and sum over ALL matches. Amounts are negative for money out. For "biggest purchases/expenses" set kind to expense, otherwise income and transfers can appear.',
    schema: z.object({
      text: z.string().optional().describe('Free text matched against description, merchant and notes, e.g. "uber" or "rent"'),
      category: z.string().optional().describe('Category name, e.g. Dining, Groceries, Transport'),
      kind: z.enum(['income', 'expense', 'transfer']).optional(), account: z.string().optional().describe('Account name or part of it'),
      from: dateStr.optional(), to: dateStr.optional(),
      sort: z.enum(['newest', 'oldest', 'largest']).optional(), limit: z.number().int().min(1).max(25).optional(),
    }),
    run: (c, a) => {
      const acct = a.account ? (all('SELECT id FROM accounts WHERE workspace_id=? AND name LIKE ? COLLATE NOCASE', c.wid, `%${a.account}%`)[0]?.id as number | undefined) : undefined;
      if (a.account && !acct) return { error: `No account matching "${a.account}"` };
      const cid = catId(c, a.category); if (a.category && !cid) return { error: `No category matching "${a.category}"`, categories: all('SELECT name FROM categories WHERE workspace_id=?', c.wid).map((r) => r.name) };
      const r = S.listTxns(c, { q: a.text, category_id: cid, kind: a.kind, account_id: acct, from: a.from, to: a.to, limit: a.limit ?? 10, sort: a.sort === 'largest' ? 'amount' : a.sort === 'oldest' ? 'date_asc' : undefined });
      const fm = f(c);
      return { currency: c.base, matches: r.total, total_of_all_matches: fm(r.sum_base), shown: r.items.length, transactions: (r.items as any[]).map((t) => ({ date: t.posted_date, description: t.description, merchant: t.merchant, category: t.category, account: t.account_name, amount: formatMoney(t.amount, t.currency), amount_in_base: fm(t.base_amount) })) };
    },
  }),
  tool({
    name: 'spending_summary',
    description: 'Total spending (expenses, excluding transfers) and income for a date range, optionally grouped. Use for "how much did I spend on X", "where does my money go", comparisons between periods (call twice). Splits and reimbursements are already handled.',
    schema: z.object({
      from: dateStr, to: dateStr, group_by: z.enum(['category', 'merchant', 'month']).optional(),
      category: z.string().optional().describe('Limit to one category'), merchant: z.string().optional().describe('Limit to merchants containing this text'),
    }),
    run: (c, a) => {
      const fm = f(c); let rows = S.spendRows(c, a.from, a.to);
      if (a.category) { const cid = catId(c, a.category); if (!cid) return { error: `No category matching "${a.category}"` }; rows = rows.filter((r) => r.cid === cid); }
      if (a.merchant) rows = rows.filter((r) => (r.merchant ?? '').toLowerCase().includes(a.merchant!.toLowerCase()));
      const total = rows.reduce((s, r) => s + r.spend, 0); const out: Record<string, unknown> = { currency: c.base, from: a.from, to: a.to, spent: fm(total), transactions: new Set(rows.map((r) => r.id)).size };
      if (!a.category && !a.merchant) out.income = fm(S.incomeTotal(c, a.from, a.to));
      if (a.group_by) {
        const m = new Map<string, number>(); for (const r of rows) { const k = a.group_by === 'category' ? r.cname ?? 'Uncategorized' : a.group_by === 'merchant' ? r.merchant ?? 'Unknown' : r.date.slice(0, 7); m.set(k, (m.get(k) ?? 0) + r.spend); }
        out.groups = [...m.entries()].sort((x, y) => (a.group_by === 'month' ? x[0].localeCompare(y[0]) : y[1] - x[1])).slice(0, 15).map(([name, v]) => ({ name, amount: fm(v), share: total ? `${Math.round((v / total) * 100)}%` : '0%' }));
      }
      return out;
    },
  }),
  tool({ name: 'list_subscriptions', description: 'Detected recurring charges. `subscriptions` are discretionary services (streaming, gym, software); `other_recurring` are essential fixed costs such as rent, loan payments and utilities. Includes amount, cadence, next charge and any recent price increase.', schema: z.object({}), run: (c) => {
    const fm = f(c); const all_ = S.subscriptionsClassified(c);
    const row = (s: (typeof all_)[number]) => ({ merchant: s.merchant, category: s.category, amount: fm(Math.abs(s.amount)), cadence: s.cadence, next_charge: s.nextCharge, last_charge: s.lastDate, price_increase: s.priceHike ? `${fm(Math.abs(s.priceHike.from))} → ${fm(Math.abs(s.priceHike.to))}` : null });
    const subs = all_.filter((s) => s.discretionary); const mo = { monthly: 1, yearly: 1 / 12, quarterly: 1 / 3, weekly: 52 / 12, biweekly: 26 / 12 } as Record<string, number>;
    return { currency: c.base, count: subs.length, monthly_cost_of_subscriptions: fm(Math.round(subs.reduce((a, s) => a + Math.abs(s.amount) * (mo[s.cadence] ?? 1), 0))), subscriptions: subs.map(row), other_recurring: all_.filter((s) => !s.discretionary).map(row) };
  } }),
  tool({ name: 'upcoming_bills', description: 'Bills and scheduled income due in the next N days (default 30), including overdue unpaid items.', schema: z.object({ days: z.number().int().min(1).max(120).optional() }), run: (c, a) => {
    const fm = f(c); S.rollRecurring(c);
    return { currency: c.base, items: S.upcomingBills(c, addDays(today(), -31), addDays(today(), a.days ?? 30)).filter((b) => !b.paid).map((b) => ({ name: b.name, type: b.kind, amount: fm(b.amount), due: b.due, overdue: b.overdue, cadence: b.cadence })) };
  } }),
  tool({ name: 'account_balances', description: 'Current balance of each account, plus net worth (assets, liabilities).', schema: z.object({}), run: (c) => {
    const fm = f(c); const nw = S.netWorth(c);
    return { currency: c.base, accounts: S.accountsWithBalance(c).filter((a) => !a.is_archived).map((a) => ({ name: a.name, type: a.type, balance: formatMoney(a.balance, a.currency) })), net_worth: fm(nw.net_worth), assets: fm(nw.assets), liabilities: fm(nw.liabilities) };
  } }),
  tool({ name: 'budget_status', description: 'Budget progress for the current period: budgeted, spent and remaining per category.', schema: z.object({}), run: (c) => {
    const fm = f(c); const b = S.budgetSummary(c);
    return { currency: c.base, period: b.period, totals: { budgeted: fm(b.totals.budgeted), spent: fm(b.totals.spent), left: fm(b.totals.left) }, categories: b.lines.map((l) => ({ category: l.category, budgeted: fm(l.budgeted), spent: fm(l.spent), left: fm(l.left), used: `${Math.round(l.pct * 100)}%`, over_budget: l.left < 0 })) };
  } }),
  tool({ name: 'safe_to_spend', description: 'How much the user can spend until the next income after bills and savings set-asides, with the working shown.', schema: z.object({}), run: (c) => {
    const s: any = S.safeToSpendNow(c); const fm = f(c); const o: Record<string, unknown> = { currency: c.base };
    for (const [k, v] of Object.entries(s)) o[k] = typeof v === 'number' && !/day|^until|income/.test(k) ? fm(v) : v; return o;
  } }),
  tool({ name: 'goals', description: 'Savings goals with progress and the monthly amount needed.', schema: z.object({}), run: (c) => {
    const fm = f(c); const rows = all('SELECT * FROM goals WHERE workspace_id=?', c.wid); const accts = new Map(S.accountsWithBalance(c).map((a) => [a.id, a.balance_base as number]));
    return { currency: c.base, goals: rows.map((g) => { const cur = g.linked_account_id ? accts.get(g.linked_account_id) ?? 0 : g.current_amount; return { name: g.name, target: fm(g.target_amount), saved: fm(cur), progress: `${Math.round((cur / g.target_amount) * 100)}%`, target_date: g.target_date }; }) };
  } }),
  tool({ name: 'debts', description: 'Credit cards and loans: balance, APR, minimum payment and card utilization.', schema: z.object({}), run: (c) => {
    const fm = f(c); return { currency: c.base, debts: S.debts(c).map((d) => ({ name: d.name, type: d.type, balance: fm(d.balance), apr: `${d.aprPct}%`, minimum_payment: fm(d.minPayment), utilization: d.utilization != null ? `${Math.round(d.utilization * 100)}%` : null, due_day: d.due_day })) };
  } }),
  tool({ name: 'financial_health', description: 'Overall financial health score with the factors behind it, plus current insights (unusual spending, price hikes, etc.).', schema: z.object({}), run: (c) => ({ health: S.health(c), insights: S.currentInsights(c).map((i) => ({ title: i.title, detail: i.detail, severity: i.severity })) }) }),
  tool({ name: 'monthly_trend', description: 'Income, spending and net for each of the last N months (default 6).', schema: z.object({ months: z.number().int().min(1).max(12).optional() }), run: (c, a) => {
    const fm = f(c); return { currency: c.base, months: S.monthlySeries(c, a.months ?? 6).map((m) => ({ month: m.month, income: fm(m.income), spending: fm(m.expense), net: fm(m.net) })) };
  } }),
  tool({ name: 'cards_overview', description: 'Debit and credit cards: spending per card this period, credit utilization, limits, payment due dates, expiry and fee-waiver progress.', schema: z.object({}), run: (c) => {
    const fm = f(c); const r = listCards(c);
    return { currency: c.base, total_credit_limit: fm(r.summary.total_limit), total_owed: fm(r.summary.total_owed), overall_utilization: r.summary.utilization != null ? `${Math.round(r.summary.utilization * 100)}%` : null, alerts: r.alerts.map((a) => a.text),
      cards: r.items.map((k) => ({ name: k.nickname, type: k.kind, last4: k.last4, status: k.status, spent_this_period: fm(k.spent_period), spent_this_year: fm(k.spent_ytd), utilization: k.utilization != null ? `${Math.round(k.utilization * 100)}%` : null, limit: k.credit_limit ? fm(k.credit_limit) : null, payment_due: k.next_due, expires_in_days: k.expiry.daysLeft })) };
  } }),
  tool({ name: 'upi_summary', description: 'UPI payments this period: total sent and received, top payees, which apps, and recent UPI transactions.', schema: z.object({}), run: (c) => {
    const fm = f(c); const u = upiSummary(c);
    return { currency: c.base, sent: fm(u.sent.total), sent_count: u.sent.count, received: fm(u.received.total), received_count: u.received.count, top_payees: u.top_payees.map((p: any) => ({ payee: p.name, total: fm(p.total), count: p.n })), recent: u.recent.slice(0, 6).map((t: any) => ({ date: t.posted_date, to: t.merchant ?? t.description, amount: formatMoney(t.amount, t.currency) })) };
  } }),
  tool({ name: 'credit_report', description: 'The latest saved credit report and score (sample data in the sandbox): score, band, factors, accounts and enquiries.', schema: z.object({}), run: (c) => {
    const o = creditOverview(c); if (!o.latest) return { available: false, note: 'No credit report has been fetched yet. Open Credit score to fetch one.' }; const r = o.latest;
    return { available: true, sample_data: r.sample, score: r.score.value, band: r.score.band, fetched_at: r.fetched_at, score_note: r.score.model, factors: r.factors.map((x: any) => ({ factor: x.name, value: x.value, status: x.status, tip: x.tip })), summary: { active_accounts: r.summary.active, card_utilization: `${Math.round(r.summary.utilization * 100)}%`, enquiries_6m: r.summary.enquiries_6m, overdue_amount: fmt0(r.summary.overdue_amount, c.base) }, history: o.history.map((h: any) => ({ date: h.fetched_at, score: h.score })) };
  } }),
  tool({ name: 'goal_schedules', description: 'Scheduled automatic contributions to goals: amount, cadence, next date, and the result of recent runs.', schema: z.object({}), run: (c) => {
    const fm = f(c); const rows = all('SELECT s.*, g.name goal, a.name from_name FROM goal_schedules s JOIN goals g ON g.id=s.goal_id JOIN accounts a ON a.id=s.from_account_id WHERE s.workspace_id=?', c.wid);
    return { currency: c.base, schedules: rows.map((s) => ({ goal: s.goal, amount: fm(s.amount), repeats: s.cadence, next_run: s.next_run, from: s.from_name, active: !!s.active, last_status: s.last_status })) };
  } }),
  tool({ name: 'linked_banks', description: 'Banks linked through the Account Aggregator: status, last sync, and accounts.', schema: z.object({}), run: (c) => ({ links: all('SELECT id,aa_handle,status,last_sync_at,expires_at FROM bank_links WHERE workspace_id=?', c.wid).map((l) => ({ aggregator: l.aa_handle, status: l.status, last_sync: l.last_sync_at, accounts: all('SELECT fip_name,masked_acc FROM linked_accounts WHERE link_id=?', l.id).map((a) => `${a.fip_name} ${a.masked_acc}`) })) }) }),
  tool({ name: 'offers_for_me', description: 'Personalised offers matched to the user\'s transaction history, with the reason each matched and estimated yearly benefit. Sample catalogue, not real products.', schema: z.object({}), run: (c) => {
    const fm = f(c); const o = offersFor(c);
    return { note: 'Sample catalogue; estimates are illustrative.', total_potential_yearly: fm(o.total_potential), offers: o.eligible.map((x) => ({ title: x.title, partner: x.partner, summary: x.blurb, why: x.why, estimated_yearly_benefit: x.annual_benefit != null ? fm(x.annual_benefit) : null, status: x.status })) };
  } }),
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));
export function runTool(c: Ctx, name: string, input: unknown): { ok: boolean; result: unknown } {
  const t = byName.get(name); if (!t) return { ok: false, result: { error: `Unknown tool ${name}` } };
  const p = t.schema.safeParse(input ?? {}); if (!p.success) return { ok: false, result: { error: 'Invalid arguments', details: p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) } };
  try { return { ok: true, result: t.run(c, p.data) }; } catch (e) { console.error('[chat-tool]', name, e); return { ok: false, result: { error: 'Tool failed' } }; }
}
/** JSON-Schema definitions for the Messages API. */
export const toolDefs = () => TOOLS.map((t) => { const js = z.toJSONSchema(t.schema) as Record<string, unknown>; delete js.$schema; return { name: t.name, description: t.description, input_schema: js as { type: 'object' } }; });
