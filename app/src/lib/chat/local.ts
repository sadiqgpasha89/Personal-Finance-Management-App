import { all } from '../db';
import { Ctx } from '../auth';
import { today } from '../domain/dates';
import { runTool } from './tools';
import type { ChatResult } from './agent';

/**
 * Offline assistant used when no model API key is configured, the user has not enabled the AI assistant,
 * or the model call fails. Understands intent, dates, categories (with synonyms) and merchants, then answers
 * from the same tools the Claude agent uses.
 */
import { SYN, parseRange as parseRangeAt } from '../../../../packages/shared/src/nlp';
const has = (q: string, ...w: string[]) => w.some((x) => q.includes(x));
export const parseRange = (q: string, now = today()) => parseRangeAt(q, now);
const cats = (q: string): string[] => {
  const found = new Set<string>();
  for (const [cat, words] of Object.entries(SYN)) if (words.some((w) => q.includes(w))) found.add(cat);
  for (const r of all('SELECT name FROM categories')) if (q.includes(String(r.name).toLowerCase())) found.add(r.name);
  return [...found];
};
const merchantIn = (c: Ctx, q: string) => (all(`SELECT DISTINCT merchant FROM transactions WHERE workspace_id=? AND merchant IS NOT NULL AND deleted_at IS NULL`, c.wid)
  .map((r) => String(r.merchant)).filter((x) => x.length >= 3 && q.includes(x.toLowerCase())).sort((a, b) => b.length - a.length)[0]);

type R = Record<string, any>;
const bullet = (xs: string[]) => xs.map((x) => `- ${x}`).join('\n');

export function localAnswer(c: Ctx, text: string): ChatResult {
  const q = ` ${text.toLowerCase()} `; const used: string[] = [];
  const call = (name: string, input: unknown = {}): R => { used.push(name); return runTool(c, name, input).result as R; };
  const done = (reply: string): ChatResult => ({ reply, engine: 'ledgerly-local', tools_used: used });
  const range = parseRange(q); const cs = cats(q); const mer = merchantIn(c, q);

  if (has(q, 'subscription', 'recurring charge', 'membership')) {
    const r = call('list_subscriptions'); if (!r.count) return done('I could not detect any subscriptions yet. They appear once a charge repeats at least three times.');
    const hike = r.subscriptions.filter((s: R) => s.price_increase);
    return done(`I found **${r.count} subscriptions** costing about **${r.monthly_cost_of_subscriptions}/month**:\n${bullet(r.subscriptions.map((s: R) => `${s.merchant}: ${s.amount} ${s.cadence}, next charge ${s.next_charge}${s.price_increase ? ` (price went up: ${s.price_increase})` : ''}`))}${hike.length ? `\n\n${hike.length} recently increased in price, so those are worth a look.` : ''}`);
  }
  if (has(q, 'offer', 'deal', 'cashback', 'discount', 'reward', 'perk')) {
    const r = call('offers_for_me'); if (!r.offers.length) return done('No offers match your history yet. Add more transactions or complete your profile and check again.');
    return done(`You have **${r.offers.length} offers** that fit your spending, worth about **${r.total_potential_yearly}** a year in total (illustrative estimates from a sample catalogue):\n${bullet(r.offers.slice(0, 5).map((o: R) => `${o.title}${o.estimated_yearly_benefit ? ` (about ${o.estimated_yearly_benefit}/yr)` : ''}: ${o.why[0]}`))}\n\nOpen the Offers page for details.`);
  }
  if (has(q, 'bill', 'due', 'upcoming', 'coming up', 'owe next')) {
    const r = call('upcoming_bills', { days: 30 }); const bills = r.items.filter((b: R) => b.type === 'expense');
    return done(bills.length ? `You have **${bills.length} upcoming bills** in the next 30 days:\n${bullet(bills.slice(0, 8).map((b: R) => `${b.name}: ${b.amount} due ${b.due}${b.overdue ? ' (overdue)' : ''}`))}` : 'No unpaid bills are due in the next 30 days.');
  }
  if (has(q, 'net worth', 'balance', 'how much do i have', 'how much money', 'accounts')) {
    const r = call('account_balances');
    return done(`Your net worth is **${r.net_worth}** (assets ${r.assets}, liabilities ${r.liabilities}).\n${bullet(r.accounts.map((a: R) => `${a.name}: ${a.balance}`))}`);
  }
  if (has(q, 'safe to spend', 'can i afford', 'left to spend', 'spendable', 'free to spend')) {
    const r = call('safe_to_spend'); const v = r.value;
    return done(`Right now you can safely spend about **${v}** until your next income${r.until ? ` on ${r.until}` : ''}, after upcoming bills and savings set-asides. The dashboard shows the full working.`);
  }
  if (has(q, 'budget')) {
    const r = call('budget_status'); const over = r.categories.filter((x: R) => x.over_budget);
    return done(`This period you have spent **${r.totals.spent}** of **${r.totals.budgeted}** budgeted (${r.totals.left} left).\n${over.length ? `Over budget: ${over.map((o: R) => `${o.category} (${o.used})`).join(', ')}.` : 'No category is over budget.'}\n${bullet(r.categories.slice(0, 6).map((x: R) => `${x.category}: ${x.spent} of ${x.budgeted} (${x.used})`))}`);
  }
  if (has(q, 'goal', 'saving for', 'target')) {
    const r = call('goals'); return done(r.goals.length ? `Your goals:\n${bullet(r.goals.map((g: R) => `${g.name}: ${g.saved} of ${g.target} (${g.progress})${g.target_date ? `, by ${g.target_date}` : ''}`))}` : 'You have no goals yet. Create one on the Goals page.');
  }
  if (has(q, 'debt', 'loan', 'credit card', 'apr', 'owe')) {
    const r = call('debts'); return done(r.debts.length ? `You have **${r.debts.length} debts**:\n${bullet(r.debts.map((d: R) => `${d.name}: ${d.balance} at ${d.apr} APR, minimum ${d.minimum_payment}${d.utilization ? `, ${d.utilization} utilised` : ''}`))}\n\nThe Debt page compares avalanche and snowball payoff plans.` : 'You have no outstanding debts.');
  }
  if (has(q, 'health', 'score', 'insight')) {
    const r = call('financial_health'); const h = r.health;
    return done(`Your financial health score is **${h.score ?? h.total ?? '–'}/100**.\n${bullet((h.factors ?? []).map((x: R) => `${x.name}: ${x.note}`).slice(0, 5))}${r.insights.length ? `\n\nWorth knowing:\n${bullet(r.insights.slice(0, 3).map((i: R) => i.title))}` : ''}`);
  }
  if (has(q, 'trend', 'month by month', 'over time', 'each month')) {
    const r = call('monthly_trend', { months: 6 }); return done(`Last months at a glance:\n${bullet(r.months.map((x: R) => `${x.month}: income ${x.income}, spending ${x.spending}, net ${x.net}`))}`);
  }
  const wantsList = has(q, 'list', 'show', 'recent transactions', 'latest', 'last transaction', 'biggest', 'largest', 'top transaction', 'most expensive', 'find');
  if (wantsList || (mer && !has(q, 'how much'))) {
    const r = call('search_transactions', { text: mer ?? undefined, category: cs.length === 1 && !mer ? cs[0] : undefined, from: wantsList && !has(q, 'recent', 'latest', 'last transaction') && !/this month|last month|\d{4}|week|year|day/.test(q) ? undefined : range.from, to: range.to, sort: has(q, 'biggest', 'largest', 'most expensive') ? 'largest' : 'newest', kind: has(q, 'income', 'salary', 'deposit', 'payroll') ? 'income' : has(q, 'transfer') ? 'transfer' : 'expense', limit: Math.min(25, +(/\b(\d{1,2})\s+(?:biggest|largest|top|most|latest|recent|last)/.exec(q)?.[1] ?? 8)) });
    if (r.error) return done(r.error); if (!r.matches) return done('I did not find any matching transactions.');
    return done(`Found **${r.matches} transactions** totalling ${r.total_of_all_matches}. ${r.shown < r.matches ? `Showing ${r.shown}:` : ''}\n${bullet(r.transactions.map((t: R) => `${t.date}: ${t.merchant ?? t.description}, ${t.amount}${t.category ? ` (${t.category})` : ''}`))}`);
  }
  if (has(q, 'income', 'earn', 'salary', 'paid me', 'got paid', 'revenue')) {
    const r = call('spending_summary', { from: range.from, to: range.to }); return done(`Your income ${range.label} was **${r.income}** against **${r.spent}** spent.`);
  }
  if (has(q, 'spend', 'spent', 'cost', 'paid', 'how much', 'where', 'top categor', 'biggest expense', 'breakdown')) {
    if (cs.length || mer) {
      const parts_ = (cs.length ? cs : [undefined]).map((cat) => call('spending_summary', { from: range.from, to: range.to, category: cat, merchant: mer }));
      const bad = parts_.find((p) => p.error); if (bad) return done(bad.error);
      if (parts_.length === 1) return done(`You spent **${parts_[0].spent}** on ${mer ?? cs[0]} ${range.label} across ${parts_[0].transactions} transactions.`);
      return done(`Spending by category ${range.label}:\n${bullet(parts_.map((p, i) => `${cs[i]}: ${p.spent}`))}`);
    }
    const r = call('spending_summary', { from: range.from, to: range.to, group_by: has(q, 'merchant', 'store', 'shop') ? 'merchant' : 'category' });
    return done(`You spent **${r.spent}** ${range.label}${r.income ? ` against ${r.income} income` : ''}. Biggest ${has(q, 'merchant', 'store', 'shop') ? 'merchants' : 'categories'}:\n${bullet(r.groups.slice(0, 6).map((g: R) => `${g.name}: ${g.amount} (${g.share})`))}`);
  }
  return done(`I can answer questions about your money. Try:\n${bullet(['How much did I spend on dining last month?', 'What subscriptions am I paying for?', 'Show my 5 biggest purchases this month', 'Which bills are due soon?', 'How am I doing against my budget?', 'What offers fit my spending?'])}`);
}
