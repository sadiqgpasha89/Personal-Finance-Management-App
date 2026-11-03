// Money is always integer minor units (cents). Never floats.
export const CURRENCIES: Record<string, { decimals: number; symbol: string }> = {
  USD: { decimals: 2, symbol: '$' }, EUR: { decimals: 2, symbol: '€' }, GBP: { decimals: 2, symbol: '£' },
  INR: { decimals: 2, symbol: '₹' }, CAD: { decimals: 2, symbol: 'C$' }, AUD: { decimals: 2, symbol: 'A$' },
  JPY: { decimals: 0, symbol: '¥' },
};
export const decimals = (c: string) => CURRENCIES[c]?.decimals ?? 2;

export function formatMoney(minor: number, currency = 'USD', opts: { sign?: boolean; mask?: boolean } = {}): string {
  if (opts.mask) return '••••';
  const d = decimals(currency);
  const abs = Math.abs(minor) / 10 ** d;
  const s = new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: d, maximumFractionDigits: d }).format(abs);
  if (minor < 0) return '-' + s;
  return opts.sign && minor > 0 ? '+' + s : s;
}

/** Parse "1,234.56", "(12.30)", "-$5", "12,5" (EU) into minor units. Returns null if unparseable. */
export function parseMoney(input: string | number, currency = 'USD'): number | null {
  if (typeof input === 'number') return Number.isFinite(input) ? Math.round(input * 10 ** decimals(currency)) : null;
  let s = String(input).trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/^-|-$/.test(s)) { neg = true; s = s.replace(/^-|-$/g, ''); }
  s = s.replace(/[^\d.,]/g, '');
  if (!s) return null;
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? '.' : ',';
    s = dec === '.' ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
  } else if (lastComma >= 0) {
    const after = s.length - lastComma - 1;
    s = after === 3 && s.split(',').length > 1 && decimals(currency) !== 3 && s.indexOf(',') === lastComma && /^\d{1,3},\d{3}$/.test(s) ? s.replace(',', '') : s.replace(',', '.');
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  const v = roundHalfEven(n * 10 ** decimals(currency));
  return neg ? -v : v;
}

export function roundHalfEven(x: number): number {
  const f = Math.floor(x), diff = x - f;
  const eps = 1e-9;
  if (Math.abs(diff - 0.5) < eps) return f % 2 === 0 ? f : f + 1;
  return Math.round(x);
}

/** Convert minor units between currencies using a rate (quote per 1 base), rounding half-even. */
export function convert(minor: number, rate: number, fromCur: string, toCur: string): number {
  const major = minor / 10 ** decimals(fromCur);
  return roundHalfEven(major * rate * 10 ** decimals(toCur));
}

/** Split an amount into n parts that sum exactly (largest remainder). */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map(Math.trunc);
  let rem = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.trunc(r), i] as const).sort((a, b) => Math.abs(b[0]) - Math.abs(a[0]));
  for (let k = 0; rem !== 0 && k < order.length * 2; k++) { out[order[k % order.length][1]] += Math.sign(rem); rem -= Math.sign(rem); }
  return out;
}
