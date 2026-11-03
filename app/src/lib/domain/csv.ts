import { parseMoney } from './money';
import { isDate, fmt, pad } from './dates';

/** RFC-4180-ish CSV parser (quotes, escaped quotes, CRLF, auto-detect delimiter). */
export function parseCSV(text: string): string[][] {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const delim = [',', ';', '\t', '|'].map((d) => [d, first.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = []; let row: string[] = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}
export function toCSV(rows: (string | number | null | undefined)[][]): string {
  const esc = (v: unknown) => { let s = v == null ? '' : String(v); if (/^[=+\-@]/.test(s) && isNaN(Number(s))) s = "'" + s; /* formula-injection guard */ return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return rows.map((r) => r.map(esc).join(',')).join('\n');
}

export interface Mapping { date: number; description: number; amount?: number; debit?: number; credit?: number; dateFormat?: 'ymd' | 'mdy' | 'dmy'; invert?: boolean }
/** Guess a mapping from header names. */
export function guessMapping(header: string[]): Mapping | null {
  const h = header.map((x) => x.toLowerCase().trim());
  const find = (...names: string[]) => h.findIndex((x) => names.some((n) => x.includes(n)));
  const date = find('date', 'posted'), description = find('description', 'memo', 'payee', 'narration', 'details', 'name');
  const amount = h.findIndex((x) => x === 'amount' || x.includes('amount') && !x.includes('debit') && !x.includes('credit'));
  const debit = find('debit', 'withdrawal'), credit = find('credit', 'deposit');
  if (date < 0 || description < 0 || (amount < 0 && debit < 0 && credit < 0)) return null;
  return { date, description, amount: amount >= 0 ? amount : undefined, debit: debit >= 0 ? debit : undefined, credit: credit >= 0 ? credit : undefined };
}
export function parseDate(s: string, f: Mapping['dateFormat'] = 'ymd'): string | null {
  s = s.trim().replace(/T.*$/, '').replace(/\s.*$/, '');
  const m = s.match(/^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})$/); if (!m) return null;
  let [a, b, c] = m.slice(1).map(Number); let y: number, mo: number, d: number;
  if (m[1].length === 4) { y = a; mo = b; d = c; } else if (f === 'dmy') { d = a; mo = b; y = c; } else { mo = a; d = b; y = c; }
  if (y < 100) y += 2000;
  const out = fmt(y, mo, d); return isDate(out) ? out : null;
}
export interface ParsedRow { line: number; date: string; description: string; amount: number }
export function applyMapping(rows: string[][], map: Mapping, currency = 'USD', hasHeader = true) {
  const ok: ParsedRow[] = [], errors: { line: number; reason: string }[] = [];
  rows.slice(hasHeader ? 1 : 0).forEach((r, i) => {
    const line = i + (hasHeader ? 2 : 1);
    const date = parseDate(r[map.date] ?? '', map.dateFormat);
    if (!date) return void errors.push({ line, reason: 'Invalid date' });
    let amt: number | null = null;
    if (map.amount != null) amt = parseMoney(r[map.amount] ?? '', currency);
    else {
      const d = map.debit != null ? parseMoney(r[map.debit] ?? '', currency) : null, c = map.credit != null ? parseMoney(r[map.credit] ?? '', currency) : null;
      if (d || c) amt = (c ? Math.abs(c) : 0) - (d ? Math.abs(d) : 0);
    }
    if (amt == null) return void errors.push({ line, reason: 'Invalid amount' });
    if (map.invert) amt = -amt;
    ok.push({ line, date, description: (r[map.description] ?? '').trim(), amount: amt });
  });
  return { rows: ok, errors };
}
export const dupKey = (accountId: number, date: string, amount: number, desc: string) =>
  `${accountId}|${date}|${amount}|${desc.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24)}`;
export { pad };
