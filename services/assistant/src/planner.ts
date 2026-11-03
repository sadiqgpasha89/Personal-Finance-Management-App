import { addDays, addMonths, categoriesIn, eom, nameIn, parseRange } from '../../../packages/shared/src/nlp.ts';
import type { Entities } from './core.ts';

/**
 * A 1B-parameter model is good at "which of these 18 things is the user asking about" and at pulling short phrases out of a sentence,
 * and unreliable at everything else (dates, JSON of arbitrary tools, arithmetic). So the model only picks an intent and copies phrases;
 * code turns those phrases into real dates, real category names and validated tool arguments.
 */
export const INTENTS = ['spending', 'transactions', 'income', 'subscriptions', 'bills', 'balances', 'budget', 'safe_to_spend', 'goals', 'auto_save', 'debts', 'health', 'trend', 'cards', 'upi', 'credit_score', 'offers', 'linked_banks', 'help'] as const;
export type Intent = (typeof INTENTS)[number];
export interface Plan { from?: string; to?: string; intent: Intent; category: string; merchant: string; period: string; sort: 'newest' | 'largest' | 'oldest' | ''; count: number; follow_up: boolean }
export const PLAN_SCHEMA = { type: 'object', properties: { intent: { enum: [...INTENTS] }, category: { type: 'string' }, merchant: { type: 'string' }, period: { type: 'string' }, sort: { enum: ['newest', 'largest', 'oldest', ''] }, count: { type: 'integer' }, follow_up: { type: 'boolean' } }, required: ['intent', 'category', 'merchant', 'period', 'sort', 'count', 'follow_up'] };

export const PLAN_SYSTEM = `You read one question from a personal finance app and fill in a JSON form. Choose exactly one intent and copy short phrases from the question; leave a field empty ("" or 0) when the question does not mention it.

Intents:
spending = how much was spent, in total or on a category or at a merchant, in some period
transactions = list or find individual transactions, biggest or latest purchases
income = money received, salary
subscriptions = recurring charges, memberships, what am I paying for every month
bills = bills due, upcoming payments
balances = account balances, net worth, how much money do I have
budget = budget progress, am I over budget
safe_to_spend = how much can I spend, can I afford something
goals = savings goals progress
auto_save = scheduled automatic goal contributions
debts = loans, EMIs, credit card dues, what do I owe
health = financial health score, insights, tips
trend = month by month comparison over time
cards = my debit or credit cards, utilization, limits, card due dates
upi = UPI payments, GPay, PhonePe, payees
credit_score = credit score, CIBIL, credit report
offers = deals, cashback, offers for me
linked_banks = linked bank accounts, account aggregator, sync
help = greetings, thanks, anything else

Fields: category = a spending category word if mentioned (dining, groceries, fuel, rent); merchant = a shop or person's name if mentioned; period = the time words copied from the question ("last month", "in october", "last 3 weeks"); sort = "largest" for biggest/largest/most expensive, "oldest", else "newest" or ""; count = the number if the question asks for a number of items; follow_up = true only if the question needs the previous question to make sense ("and last month?", "what about uber?").

Examples:
Q: How much did I spend on eating out last month?
{"intent":"spending","category":"eating out","merchant":"","period":"last month","sort":"","count":0,"follow_up":false}
Q: show my 5 biggest purchases this month
{"intent":"transactions","category":"","merchant":"","period":"this month","sort":"largest","count":5,"follow_up":false}
Q: what am I paying for every month?
{"intent":"subscriptions","category":"","merchant":"","period":"","sort":"","count":0,"follow_up":false}
Q: and the month before?
{"intent":"spending","category":"","merchant":"","period":"the month before","sort":"","count":0,"follow_up":true}
Q: what is my cibil score
{"intent":"credit_score","category":"","merchant":"","period":"","sort":"","count":0,"follow_up":false}
Q: how much did I send through UPI in october
{"intent":"upi","category":"","merchant":"","period":"october","sort":"","count":0,"follow_up":false}
Q: what about swiggy?
{"intent":"spending","category":"","merchant":"swiggy","period":"","sort":"","count":0,"follow_up":true}
Q: show me my zomato orders in august
{"intent":"transactions","category":"","merchant":"zomato","period":"august","sort":"","count":0,"follow_up":false}
Q: what is my priciest purchase
{"intent":"transactions","category":"","merchant":"","period":"","sort":"largest","count":1,"follow_up":false}
Q: how much of my credit limit am I using
{"intent":"cards","category":"","merchant":"","period":"","sort":"","count":0,"follow_up":false}
Q: who won the cricket match
{"intent":"help","category":"","merchant":"","period":"","sort":"","count":0,"follow_up":false}
Q: thanks!
{"intent":"help","category":"","merchant":"","period":"","sort":"","count":0,"follow_up":false}`;

export const planPrompt = (q: string, prev: Plan | null, prevQ: string | null) => (prev && prevQ ? `Previous question: ${prevQ.slice(0, 160)}\nPrevious form: ${JSON.stringify(prev)}\n\nQ: ${q.slice(0, 300)}` : `Q: ${q.slice(0, 300)}`);

/** Cheap, unambiguous cues override a wrong guess by a small model. Only cues that cannot mean anything else. */
const GUARDS: [RegExp, Intent][] = [[/\bcibil\b|credit (score|report)/i, 'credit_score'], [/utili[sz]ation|credit limit|\bmy cards?\b/i, 'cards'], [/subscription|membership|recurring charge/i, 'subscriptions'], [/safe to spend|can i afford/i, 'safe_to_spend'], [/\boffers?\b|cashback|\bdeals?\b/i, 'offers'],
  [/\bupi\b|gpay|google pay|phonepe|paytm|\bvpa\b/i, 'upi'], [/linked bank|account aggregator|sync (my )?bank|connected bank/i, 'linked_banks'], [/auto-?save|scheduled (saving|contribution)/i, 'auto_save'], [/net worth/i, 'balances'], [/\b(received?|earn(ed|ings)?|salary|income|credited|got paid)\b/i, 'income']];
export function guard(q: string, intent: Intent): { intent: Intent; guarded: boolean } {
  for (const [re, i] of GUARDS) if (re.test(q) && intent !== i) { if (i === 'upi' && /\bbill\b/i.test(q)) continue; return { intent: i, guarded: true }; }
  return { intent, guarded: false };
}
export const normalizePlan = (raw: any): Plan | null => {
  if (!raw || typeof raw !== 'object' || !INTENTS.includes(raw.intent)) return null;
  const s = (v: unknown, n = 60) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  return { intent: raw.intent, category: s(raw.category), merchant: s(raw.merchant), period: s(raw.period), sort: ['newest', 'largest', 'oldest'].includes(raw.sort) ? raw.sort : '', count: Number.isInteger(raw.count) && raw.count > 0 && raw.count <= 25 ? raw.count : 0, follow_up: raw.follow_up === true };
};
/** Applies follow-up inheritance and turns the form into concrete tool calls. */
export function toCalls(q: string, plan: Plan, prev: Plan | null, ent: Entities): { plan: Plan; calls: { name: string; input: Record<string, unknown> }[] } {
  let p = { ...plan };
  // the model sometimes misses a follow-up; short or "and/what about" questions after another question are treated as one
  if (prev && !p.follow_up && (/^(and|also|then|what about|how about)\b/i.test(q.trim()) || (q.trim().split(/\s+/).length <= 3 && plan.intent !== 'help'))) p.follow_up = true;
  if (p.follow_up && prev) p = { ...p, intent: p.intent === 'help' ? prev.intent : p.intent, category: p.category || (p.merchant ? '' : prev.category), merchant: p.merchant || (p.category ? '' : prev.merchant), period: p.period || prev.period, sort: p.sort || prev.sort, count: p.count || prev.count };
  const cat = categoriesIn(`${p.category} ${/\b(eating out|food|fuel|petrol|rent|groceries|dining)\b/i.test(q) ? q : ''}`.trim(), ent.categories)[0] ?? (p.category ? categoriesIn(q, ent.categories)[0] : undefined);
  const merchant = nameIn(p.merchant || '', ent.merchants) ?? nameIn(q, ent.merchants);
  let range = parseRange(p.period || q, ent.today);
  // "and the month before?" steps back from the previous question's period
  const back = /\b(?:the )?(month|week|year) before\b|\bbefore that\b|\bprevious (month|week)\b(?! of)/i.exec(plan.period || q);
  if (back && prev && p.follow_up && !plan.period.match(/last month|this month/i)) { const base = prev.from && prev.to ? { from: prev.from, to: prev.to, label: '' } : parseRange(prev.period || 'this month', ent.today); const unit = (back[1] || back[2] || 'month').toLowerCase();
    range = unit === 'week' ? { ...base, from: addDays(base.from, -7), to: addDays(base.to, -7) } : unit === 'year' ? { ...base, from: addMonths(base.from, -12), to: addMonths(base.to, -12) } : (() => { const f = addMonths(base.from.slice(0, 7) + '-01', -1); return { ...base, from: f, to: base.to.slice(0, 7) === base.from.slice(0, 7) && base.to.slice(8) >= '28' || base.to === eom(base.to) ? eom(f) : addMonths(base.to, -1) }; })(); } const hasPeriod = !!p.period || /\b(last|this|past|yesterday|today|ytd|in (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|20\d\d)/i.test(q);
  // a follow-up without new time words keeps the period the previous answer used
  if (p.follow_up && prev?.from && prev.to && !back && !plan.period) range = { from: prev.from, to: prev.to, label: range.label };
  p = { ...p, from: range.from, to: range.to };
  const out = (name: string, input: Record<string, unknown> = {}) => ({ plan: p, calls: [{ name, input }] });
  switch (p.intent) {
    case 'spending': return out('spending_summary', { from: range.from, to: range.to, ...(cat ? { category: cat } : {}), ...(merchant ? { merchant } : {}), ...(!cat && !merchant ? { group_by: 'category' } : {}) });
    case 'income': return out('spending_summary', { from: range.from, to: range.to });
    case 'transactions': return out('search_transactions', { ...(merchant || p.merchant ? { text: merchant ?? p.merchant } : {}), ...(cat ? { category: cat } : {}), ...(hasPeriod || (p.follow_up && prev?.from) ? { from: range.from, to: range.to } : {}), sort: p.sort || 'newest', limit: p.count || 8, kind: /\b(income|salary|deposit|credited|received?)\b/i.test(q) ? 'income' : 'expense' });
    case 'subscriptions': return out('list_subscriptions'); case 'bills': return out('upcoming_bills', { days: 30 }); case 'balances': return out('account_balances'); case 'budget': return out('budget_status'); case 'safe_to_spend': return out('safe_to_spend');
    case 'goals': return out('goals'); case 'auto_save': return out('goal_schedules'); case 'debts': return out('debts'); case 'health': return out('financial_health'); case 'trend': return out('monthly_trend', { months: 6 });
    case 'cards': return out('cards_overview'); case 'upi': return out('upi_summary'); case 'credit_score': return out('credit_report'); case 'offers': return out('offers_for_me'); case 'linked_banks': return out('linked_banks');
    default: return { plan: p, calls: [] };
  }
}
export const periodLabel = (q: string, plan: Plan, today: string) => parseRange(plan.period || q, today).label;
