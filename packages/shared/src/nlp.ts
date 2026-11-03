/**
 * Language helpers shared by the offline assistant (core) and the Llama assistant service: relative-date parsing and category synonyms.
 * Dates are civil YYYY-MM-DD strings, so there is no timezone drift.
 */
const pad = (n: number) => String(n).padStart(2, '0');
const parts = (d: string) => { const [y, m, dd] = d.split('-').map(Number); return { y, m, d: dd }; };
const fmt = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const toUTC = (d: string) => { const p = parts(d); return Date.UTC(p.y, p.m - 1, p.d); };
const fromUTC = (t: number) => { const x = new Date(t); return fmt(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate()); };
export const addDays = (d: string, n: number) => fromUTC(toUTC(d) + n * 86400000);
export const addMonths = (d: string, n: number) => { const p = parts(d); const t = p.y * 12 + (p.m - 1) + n; const y = Math.floor(t / 12), m = (t % 12) + 1; return fmt(y, m, Math.min(p.d, daysInMonth(y, m))); };
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
export const SYN: Record<string, string[]> = {
  Dining: ['dining', 'restaurant', 'eating out', 'takeout', 'take out', 'delivery', 'coffee', 'cafe', 'lunch', 'dinner', 'food'],
  Groceries: ['grocery', 'groceries', 'supermarket', 'food'], Transport: ['transport', 'fuel', 'petrol', 'gas ', 'taxi', 'commute', 'rideshare', 'uber', 'lyft', 'transit'],
  Housing: ['rent', 'housing', 'mortgage'], Utilities: ['utilities', 'utility', 'electric', 'internet', 'bills'], Subscriptions: ['subscription'], Health: ['health', 'gym', 'medical', 'doctor', 'pharmacy', 'fitness'],
  Shopping: ['shopping', 'amazon', 'clothes'], Entertainment: ['entertainment', 'movies', 'games'], Travel: ['travel', 'flight', 'hotel', 'airbnb', 'vacation', 'trip'], Insurance: ['insurance'], Education: ['education', 'course', 'tuition'],
};
const has = (q: string, ...w: string[]) => w.some((x) => q.includes(x));
export const eom = (d: string) => { const p = parts(d); return fmt(p.y, p.m, daysInMonth(p.y, p.m)); };

export function parseRange(q: string, now: string): { from: string; to: string; label: string } {
  const y = parts(now).y; const mk = (from: string, to: string, label: string) => ({ from, to, label });
  const mon = MONTHS.findIndex((n) => (n === 'may' ? /\b(in|during|of|for) may\b/ : new RegExp(`\\b(${n}|${n.slice(0, 3)})\\b`)).test(q));
  if (mon >= 0) { const yr = /\b(20\d\d)\b/.exec(q)?.[1]; let yy = yr ? +yr : y; if (!yr && fmt(yy, mon + 1, 1) > now) yy--; const s = fmt(yy, mon + 1, 1); return mk(s, eom(s), `in ${MONTHS[mon][0].toUpperCase()}${MONTHS[mon].slice(1)} ${yy}`); }
  const n = /last (\d+) (day|week|month)s?/.exec(q);
  if (n) { const k = +n[1]; return mk(n[2] === 'day' ? addDays(now, -k) : n[2] === 'week' ? addDays(now, -7 * k) : addMonths(now, -k), now, `over the last ${k} ${n[2]}${k > 1 ? 's' : ''}`); }
  if (has(q, 'yesterday')) return mk(addDays(now, -1), addDays(now, -1), 'yesterday');
  if (has(q, 'today')) return mk(now, now, 'today');
  if (has(q, 'last week')) return mk(addDays(now, -14), addDays(now, -7), 'last week');
  if (has(q, 'this week', 'past week')) return mk(addDays(now, -7), now, 'over the past 7 days');
  if (has(q, 'last month', 'previous month')) { const s = addMonths(now.slice(0, 7) + '-01', -1); return mk(s, eom(s), 'last month'); }
  if (has(q, 'last year')) return mk(fmt(y - 1, 1, 1), fmt(y - 1, 12, 31), `in ${y - 1}`);
  if (has(q, 'this year', 'year to date', 'ytd', 'so far this year')) return mk(fmt(y, 1, 1), now, 'this year');
  if (has(q, 'recent', 'lately', '30 days')) return mk(addDays(now, -30), now, 'over the last 30 days');
  return mk(now.slice(0, 7) + '-01', now, 'this month');
}

/** Categories (by name) a phrase refers to: exact names plus everyday synonyms such as "eating out" or "petrol". */
export function categoriesIn(q: string, names: string[]): string[] {
  const s = ` ${q.toLowerCase()} `; const found = new Set<string>(); const have = new Set(names.map((n) => n.toLowerCase()));
  for (const [cat, words] of Object.entries(SYN)) if (words.some((w) => s.includes(w)) && (have.has(cat.toLowerCase()) || !names.length)) found.add(cat);
  for (const n of names) if (s.includes(n.toLowerCase())) found.add(n);
  return [...found];
}
/** The longest known name (3+ chars) that appears in the text, or undefined. */
export const nameIn = (q: string, names: string[]) => names.filter((x) => x.length >= 3 && q.toLowerCase().includes(x.toLowerCase())).sort((a, b) => b.length - a.length)[0];
