// Civil dates ("YYYY-MM-DD") are handled as strings; no timezone shifting.
export const pad = (n: number) => String(n).padStart(2, '0');
export const parts = (d: string) => { const [y, m, dd] = d.split('-').map(Number); return { y, m, d: dd }; };
export const fmt = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
export const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const toUTC = (d: string) => { const p = parts(d); return Date.UTC(p.y, p.m - 1, p.d); };
export const fromUTC = (t: number) => { const x = new Date(t); return fmt(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate()); };
export const addDays = (d: string, n: number) => fromUTC(toUTC(d) + n * 86400000);
export const diffDays = (a: string, b: string) => Math.round((toUTC(a) - toUTC(b)) / 86400000);
/** Add months with month-end clamping (Jan 31 + 1m = Feb 28/29). */
export function addMonths(d: string, n: number, anchorDay?: number): string {
  const p = parts(d); const total = p.y * 12 + (p.m - 1) + n;
  const y = Math.floor(total / 12), m = (total % 12) + 1;
  return fmt(y, m, Math.min(anchorDay ?? p.d, daysInMonth(y, m)));
}
export const monthKey = (d: string) => d.slice(0, 7);
export const today = () => { const x = new Date(); return fmt(x.getFullYear(), x.getMonth() + 1, x.getDate()); };
export const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(toUTC(s)) && fromUTC(toUTC(s)) === s;

/** Budget period containing `date` given a start day (e.g. payday = 25). Returns [start, endInclusive]. */
export function budgetPeriod(date: string, startDay = 1): { start: string; end: string; key: string } {
  const p = parts(date);
  let y = p.y, m = p.m;
  const eff = (yy: number, mm: number) => Math.min(startDay, daysInMonth(yy, mm));
  if (p.d < eff(y, m)) { m -= 1; if (m === 0) { m = 12; y -= 1; } }
  const start = fmt(y, m, eff(y, m));
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  const end = addDays(fmt(ny, nm, eff(ny, nm)), -1);
  return { start, end, key: start };
}
export const shiftPeriod = (start: string, n: number, startDay = 1) => budgetPeriod(addMonths(start, n, startDay), startDay);
