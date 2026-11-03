// Categorization stage 0 (plan 10.4): user rules -> merchant memory -> curated dictionary/keywords.
export interface RuleCond { field: 'description' | 'merchant' | 'amount' | 'account'; op: 'contains' | 'equals' | 'startsWith' | 'regex' | 'gt' | 'lt'; value: string | number }
export interface Rule { id?: number; priority: number; conditions: RuleCond[]; actions: { category?: string; merchant?: string; tag?: string }; active?: boolean }
export interface TxnLike { description: string; merchant?: string | null; amount: number; accountId?: number }

export function normalizeMerchant(raw: string): string {
  let s = raw.toUpperCase().replace(/[#*]\s*\w+/g, ' ').replace(/\b(POS|DEBIT|PURCHASE|CARD|PAYMENT|ACH|WWW|HTTPS?|COM|INC|LLC|LTD)\b/g, ' ')
    .replace(/\d{3,}/g, ' ').replace(/[^A-Z&' ]/g, ' ').replace(/\s+/g, ' ').trim();
  const known = DICTIONARY.find((d) => d.match.some((m) => s.includes(m)));
  if (known) return known.name;
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 40) || raw.trim();
}

export const DICTIONARY: { name: string; category: string; match: string[] }[] = [
  { name: 'Amazon', category: 'Shopping', match: ['AMZN', 'AMAZON'] },
  { name: 'Walmart', category: 'Groceries', match: ['WALMART', 'WAL-MART', 'WAL MART'] },
  { name: 'Target', category: 'Shopping', match: ['TARGET'] },
  { name: 'Costco', category: 'Groceries', match: ['COSTCO'] },
  { name: 'Whole Foods', category: 'Groceries', match: ['WHOLE FOODS', 'WHOLEFDS'] },
  { name: 'Trader Joes', category: 'Groceries', match: ['TRADER JOE'] },
  { name: 'Kroger', category: 'Groceries', match: ['KROGER'] },
  { name: 'Starbucks', category: 'Dining', match: ['STARBUCKS'] },
  { name: 'McDonalds', category: 'Dining', match: ["MCDONALD"] },
  { name: 'Chipotle', category: 'Dining', match: ['CHIPOTLE'] },
  { name: 'Uber Eats', category: 'Dining', match: ['UBER EATS', 'UBEREATS'] },
  { name: 'DoorDash', category: 'Dining', match: ['DOORDASH'] },
  { name: 'Swiggy', category: 'Dining', match: ['SWIGGY'] },
  { name: 'Zomato', category: 'Dining', match: ['ZOMATO'] },
  { name: 'Uber', category: 'Transport', match: ['UBER'] },
  { name: 'Lyft', category: 'Transport', match: ['LYFT'] },
  { name: 'Shell', category: 'Transport', match: ['SHELL OIL', 'SHELL'] },
  { name: 'Chevron', category: 'Transport', match: ['CHEVRON'] },
  { name: 'Netflix', category: 'Subscriptions', match: ['NETFLIX'] },
  { name: 'Spotify', category: 'Subscriptions', match: ['SPOTIFY'] },
  { name: 'Disney Plus', category: 'Subscriptions', match: ['DISNEY'] },
  { name: 'YouTube Premium', category: 'Subscriptions', match: ['YOUTUBE'] },
  { name: 'Apple', category: 'Subscriptions', match: ['APPLE.COM', 'APPLE COM', 'ITUNES'] },
  { name: 'Adobe', category: 'Subscriptions', match: ['ADOBE'] },
  { name: 'Comcast', category: 'Utilities', match: ['COMCAST', 'XFINITY'] },
  { name: 'Verizon', category: 'Utilities', match: ['VERIZON'] },
  { name: 'AT&T', category: 'Utilities', match: ['AT&T', 'ATT '] },
  { name: 'Electric Co', category: 'Utilities', match: ['ELECTRIC', 'POWER CO', 'ENERGY'] },
  { name: 'Water Utility', category: 'Utilities', match: ['WATER'] },
  { name: 'CVS', category: 'Health', match: ['CVS'] },
  { name: 'Walgreens', category: 'Health', match: ['WALGREENS'] },
  { name: 'Gym', category: 'Health', match: ['PLANET FITNESS', 'GYM', 'FITNESS'] },
  { name: 'Payroll', category: 'Salary', match: ['PAYROLL', 'DIRECT DEP', 'SALARY'] },
  { name: 'Rent', category: 'Housing', match: ['RENT', 'LANDLORD', 'PROPERTY MGMT'] },
  { name: 'Airbnb', category: 'Travel', match: ['AIRBNB'] },
  { name: 'Delta Air Lines', category: 'Travel', match: ['DELTA AIR'] },
  { name: 'Booking', category: 'Travel', match: ['BOOKING.COM', 'EXPEDIA'] },
];
const KEYWORDS: [RegExp, string][] = [
  [/restaurant|cafe|coffee|pizza|burger|diner|bakery/i, 'Dining'], [/grocer|market|supermarket/i, 'Groceries'],
  [/pharmacy|clinic|hospital|dental|doctor/i, 'Health'], [/fuel|gas station|parking|metro|transit|toll/i, 'Transport'],
  [/insurance/i, 'Insurance'], [/tuition|school|course|udemy/i, 'Education'], [/cinema|movie|concert|theatre/i, 'Entertainment'],
];

function test(c: RuleCond, t: TxnLike): boolean {
  const sv = c.field === 'description' ? t.description : c.field === 'merchant' ? t.merchant ?? '' : '';
  switch (c.op) {
    case 'contains': return sv.toLowerCase().includes(String(c.value).toLowerCase());
    case 'equals': return c.field === 'amount' ? Math.abs(t.amount) === Number(c.value) : c.field === 'account' ? t.accountId === Number(c.value) : sv.toLowerCase() === String(c.value).toLowerCase();
    case 'startsWith': return sv.toLowerCase().startsWith(String(c.value).toLowerCase());
    case 'regex': try { return new RegExp(String(c.value), 'i').test(sv); } catch { return false; }
    case 'gt': return Math.abs(t.amount) > Number(c.value);
    case 'lt': return Math.abs(t.amount) < Number(c.value);
  }
}
export type CatSource = 'rule' | 'memory' | 'dictionary' | 'keyword';
export interface CatResult { category: string | null; merchant: string; source: CatSource | null; confidence: number; ruleId?: number; tag?: string }

export function categorize(t: TxnLike, rules: Rule[], memory: Record<string, string>): CatResult {
  const merchant = normalizeMerchant(t.merchant || t.description);
  const sorted = [...rules].filter((r) => r.active !== false).sort((a, b) => a.priority - b.priority);
  for (const r of sorted) if (r.conditions.length && r.conditions.every((c) => test(c, { ...t, merchant: t.merchant ?? merchant })))
    return { category: r.actions.category ?? memory[merchant] ?? null, merchant: r.actions.merchant ?? merchant, source: 'rule', confidence: 1, ruleId: r.id, tag: r.actions.tag };
  if (memory[merchant]) return { category: memory[merchant], merchant, source: 'memory', confidence: 0.95 };
  const d = DICTIONARY.find((x) => x.name === merchant);
  if (d) return { category: d.category, merchant, source: 'dictionary', confidence: 0.9 };
  for (const [re, cat] of KEYWORDS) if (re.test(t.description)) return { category: cat, merchant, source: 'keyword', confidence: 0.6 };
  return { category: null, merchant, source: null, confidence: 0 };
}
export const AUTO_APPLY_THRESHOLD = 0.9;
