/**
 * Bank statement parsing (pure, no I/O): PDF text lines, OFX/QFX and QIF into one normalized row shape,
 * plus a balance reconciliation check that tells you whether the parse can be trusted.
 * Amounts are minor units (2 decimals), negative = money out of the account, regardless of how the bank prints it.
 */
import { isDate, fmt, today, addDays } from './dates';
import { toCSV } from './csv';

export interface Word { s: string; x0: number; x1: number }
export interface Line { words: Word[]; page: number }
export interface StmtRow { date: string; description: string; amount: number; line: number; balance?: number; flags?: string[] }
export interface StmtResult {
  format: 'pdf' | 'ofx' | 'qif' | 'ai';
  rows: StmtRow[]; period: { start: string; end: string } | null; opening: number | null; closing: number | null;
  /** True when opening + sum(rows) = closing (or the credit-card equivalent); null when balances are not on the statement. */
  reconciled: boolean | null; difference: number | null; creditCard: boolean;
  confidence: 'high' | 'medium' | 'low'; warnings: string[]; unparsedDateLines: number; currency?: string;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
/** 1-12 for an English month name or 3-letter abbreviation (optionally with a trailing dot or comma), else 0. */
const monthNum = (w: string) => { const k = w.toLowerCase().replace(/[.,]$/, ''); const i = MONTHS.findIndex((m) => k === m || k === m.slice(0, 3) || (m === 'september' && k === 'sept')); return i + 1; };

export const linesFromText = (text: string): Line[] => text.split(/\r?\n/).map((l) => ({ page: 1, words: [...l.matchAll(/\S+/g)].map((m) => ({ s: m[0], x0: m.index!, x1: m.index! + m[0].length })) }));

// ---------------- amounts ----------------
interface Amt { v: number; neg: boolean; cr: boolean; dr: boolean }
const US = /^([(+-])?[$€£]?(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})\)?(-|CR|DR|Cr|Dr|cr|dr)?$/;
const EU = /^([(+-])?[$€£]?(\d{1,3}(?:\.\d{3})+|\d+),(\d{2})\)?(-|CR|DR|Cr|Dr|cr|dr)?$/;
export function parseAmount(tok: string, comma: boolean): Amt | null {
  const m = (comma ? EU : US).exec(tok); if (!m) return null;
  const whole = m[2].replace(/[.,]/g, ''); const v = Number(whole) * 100 + Number(m[3]); const suf = (m[4] ?? '').toUpperCase();
  if (!Number.isSafeInteger(v)) return null;
  return { v, neg: m[1] === '-' || m[1] === '(' || suf === '-' || suf === 'DR' || tok.startsWith('-$') , cr: suf === 'CR', dr: suf === 'DR' };
}
const signed = (a: Amt) => (a.neg ? -a.v : a.v);

// ---------------- dates ----------------
interface DateParts { y: number | null; m: number; d: number; n: number; numeric: boolean; a?: number; b?: number; sep?: string }
function dateAt(w: Word[], i: number, order: 'mdy' | 'dmy'): DateParts | null {
  const t = w[i]?.s; if (!t) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t); if (m) return ok({ y: +m[1], m: +m[2], d: +m[3], n: 1, numeric: true });
  m = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4}|\d{2})$/.exec(t);
  if (m) { const a = +m[1], b = +m[3]; let y = +m[4]; if (m[4].length === 2) y += 2000; const dmy = order === 'dmy'; return ok({ y, m: dmy ? b : a, d: dmy ? a : b, n: 1, numeric: true, a, b, sep: m[2] }); }
  m = /^(\d{1,2})\/(\d{1,2})$/.exec(t);
  if (m) { const a = +m[1], b = +m[2]; const dmy = order === 'dmy'; return ok({ y: null, m: dmy ? b : a, d: dmy ? a : b, n: 1, numeric: true, a, b, sep: '/' }); }
  const mo = monthNum(t);
  if (mo && w[i + 1] && /^\d{1,2},?$/.test(w[i + 1].s)) { const d = parseInt(w[i + 1].s, 10); const y = w[i + 2] && /^(20)\d{2}$/.test(w[i + 2].s) ? +w[i + 2].s : null; return ok({ y, m: mo, d, n: y ? 3 : 2, numeric: false }); }
  if (/^\d{1,2}$/.test(t) && w[i + 1] && monthNum(w[i + 1].s)) { const y = w[i + 2] && /^(20)\d{2}$/.test(w[i + 2].s) ? +w[i + 2].s : null; return ok({ y, m: monthNum(w[i + 1].s), d: +t, n: y ? 3 : 2, numeric: false }); }
  return null;
}
function ok(p: DateParts): DateParts | null { return p.m >= 1 && p.m <= 12 && p.d >= 1 && p.d <= 31 ? p : null; }

function detectOrder(lines: Line[], comma: boolean): 'mdy' | 'dmy' {
  let first = false, second = false, dots = 0, slashes = 0;
  for (const l of lines) { const t = l.words[0]?.s ?? ''; const m = /^(\d{1,2})([/.-])(\d{1,2})(?:\2\d{2,4})?$/.exec(t); if (!m) continue; if (+m[1] > 12) first = true; if (+m[3] > 12) second = true; if (m[2] === '.') dots++; else slashes++; }
  if (first && !second) return 'dmy'; if (second && !first) return 'mdy'; return comma || dots > slashes ? 'dmy' : 'mdy';
}

// ---------------- statement-level facts ----------------
const KIND: [RegExp, 'debit' | 'credit' | 'amount' | 'balance'][] = [[/^(withdrawals?|debits?|charges|purchases|money-?out|paid-?out|ausgang)$/i, 'debit'], [/^(deposits?|credits?|money-?in|paid-?in|eingang)$/i, 'credit'], [/^(amount|betrag)$/i, 'amount'], [/^(balance|saldo)$/i, 'balance']];
const OPEN_RE = /\b(beginning|opening|previous|prior|starting)\s+balance\b|\bbalance\s+(brought|forward|b\/f)\b|\balter saldo\b|\banfangssaldo\b/i;
const CLOSE_RE = /\b(ending|closing|new|final|statement)\s+balance\b|\bneuer saldo\b|\bendsaldo\b|\bbalance\s+c\/f\b/i;
const SKIP_RE = /^(total|subtotal|sum|totals|page\b|continued|summary|interest charge calculation|transactions?$|date$)/i;
const FOOTER_RE = /\b(page \d|www\.|call|questions|member|fdic|statement|customer service|address|please|www|@)\b/i;
const CC_RE = /\b(minimum payment|credit limit|payment due date|new balance|credit card)\b/i;

export function parseStatementLines(lines: Line[], opts: { today?: string } = {}): StmtResult {
  const now = opts.today ?? today(); const warnings: string[] = [];
  const all = lines.filter((l) => l.words.length);
  const text = all.map((l) => l.words.map((w) => w.s).join(' ')).join('\n');
  // decimal style
  let us = 0, eu = 0; for (const l of all) for (const w of l.words) { if (US.test(w.s)) us++; else if (EU.test(w.s)) eu++; }
  const comma = eu > us;
  const order = detectOrder(all, comma);
  const maxX = Math.max(1, ...all.flatMap((l) => l.words.map((w) => w.x1)));
  const creditCard = CC_RE.test(text) && !/\b(withdrawals?|deposits?)\b/i.test(text);

  // period
  let period: StmtResult['period'] = null;
  for (const l of all.slice(0, 60)) {
    if (!/(period|statement|from|through|billing|kontoauszug|to)\b/i.test(l.words.map((w) => w.s).join(' '))) continue;
    const ds: string[] = [];
    for (let i = 0; i < l.words.length; i++) { const d = dateAt(l.words, i, order); if (d?.y) { const s = fmt(d.y, d.m, d.d); if (isDate(s)) { ds.push(s); i += d.n - 1; } } }
    if (ds.length >= 2) { ds.sort(); period = { start: ds[0], end: ds[ds.length - 1] }; break; }
  }
  const yearHits = [...text.matchAll(/\b(20\d{2})\b/g)].map((m) => +m[1]); const guessYear = yearHits.length ? yearHits.sort((a, b) => yearHits.filter((v) => v === b).length - yearHits.filter((v) => v === a).length)[0] : +now.slice(0, 4);
  const resolve = (p: DateParts): string | null => {
    if (p.y) { const s = fmt(p.y, p.m, p.d); return isDate(s) ? s : null; }
    const ys = period ? [...new Set([+period.start.slice(0, 4), +period.end.slice(0, 4)])] : [guessYear];
    let best: string | null = null;
    for (const y of ys) { const s = fmt(y, p.m, p.d); if (!isDate(s)) continue; if (!period) return s; if (s >= addDays(period.start, -31) && s <= addDays(period.end, 31)) { if (!best || (s >= period.start && s <= period.end)) best = s; } }
    return best;
  };

  let cols: { kind: 'debit' | 'credit' | 'amount' | 'balance'; x0: number; x1: number }[] = [];
  let opening: number | null = null, closing: number | null = null, unparsedDateLines = 0;
  interface Raw { row: StmtRow; tokens: { w: Word; a: Amt; kind?: string }[]; descX0: number; page: number }
  const raws: Raw[] = []; let last: Raw | null = null; let lastIdx = -10;

  all.forEach((l, idx) => {
    const w = l.words; const joined = w.map((x) => x.s).join(' ');
    const toks = (from: number) => { const out: { w: Word; a: Amt }[] = []; for (let j = w.length - 1; j >= from; j--) { const a = parseAmount(w[j].s, comma); if (!a) break; out.unshift({ w: w[j], a }); } return out; };
    // header row: >=2 column keywords and no amounts
    const kws: { x: Word; k: 'debit' | 'credit' | 'amount' | 'balance' }[] = []; const clean = (z: string) => z.replace(/[^\w-]/g, '');
    for (let j = 0; j < w.length; j++) {
      const two = w[j + 1] ? KIND.find(([re]) => re.test(`${clean(w[j].s)}-${clean(w[j + 1].s)}`))?.[1] : undefined;
      if (two) { kws.push({ x: { s: `${w[j].s} ${w[j + 1].s}`, x0: w[j].x0, x1: w[j + 1].x1 }, k: two }); j++; continue; }
      const one = KIND.find(([re]) => re.test(clean(w[j].s)))?.[1]; if (one) kws.push({ x: w[j], k: one });
    }
    if (kws.length >= 2 && !toks(0).length && !dateAt(w, 0, order)) { cols = kws.map(({ x, k }) => ({ kind: k, x0: x.x0, x1: x.x1 })); last = null; return; }
    // balance lines (with or without a leading date)
    const di0 = dateAt(w, 0, order); const afterDate = di0 ? di0.n : 0; const bodyText = w.slice(afterDate).map((x) => x.s).join(' ');
    if (OPEN_RE.test(bodyText) || CLOSE_RE.test(bodyText)) { const t = toks(0); if (t.length) { const v = signed(t[t.length - 1].a); if (OPEN_RE.test(bodyText) && opening == null) opening = v; else if (CLOSE_RE.test(bodyText)) closing = v; } last = null; return; }
    if (di0) {
      let i = afterDate; const second = dateAt(w, i, order); if (second) i += second.n;
      const t = toks(i);
      const descEnd = w.length - t.length; const desc = w.slice(i, descEnd).map((x) => x.s).join(' ').trim();
      if (!t.length || !desc) { if (!t.length && desc) unparsedDateLines++; last = null; return; }
      if (SKIP_RE.test(desc)) { last = null; return; }
      const date = resolve(di0); if (!date) { unparsedDateLines++; last = null; return; }
      const r: Raw = { row: { date, description: desc.replace(/\s+/g, ' '), amount: 0, line: idx + 1 }, tokens: t.map((x) => ({ w: x.w, a: x.a })), descX0: w[i].x0, page: l.page };
      raws.push(r); last = r; lastIdx = idx; return;
    }
    // continuation of a wrapped description
    if (last && idx === lastIdx + 1 && l.page === last.page && !toks(0).length && Math.abs(w[0].x0 - last.descX0) <= Math.max(2, maxX * 0.015) && joined.length <= 60 && !FOOTER_RE.test(joined) && !last.row.flags?.includes('wrapped')) {
      last.row.description += ' ' + joined; (last.row.flags ??= []).push('wrapped'); lastIdx = idx; return;
    }
    last = null;
  });

  // ---- assign signs ----
  const tol = maxX * 0.09; const nearest = (t: Word) => { let best: (typeof cols)[number] | null = null, bd = Infinity; for (const c of cols) { const d = Math.min(Math.abs(c.x1 - t.x1), Math.abs((c.x0 + c.x1) / 2 - (t.x0 + t.x1) / 2)); if (d < bd) { bd = d; best = c; } } return bd <= tol ? best : null; };
  const rowsWithBal = raws.filter((r) => r.tokens.length >= 2);
  // running balance consistency test (needs balance as last token)
  let rbOk = false;
  if (rowsWithBal.length >= 3) { let hit = 0, n = 0; for (let i = 1; i < raws.length; i++) { const a = raws[i - 1].tokens, b = raws[i].tokens; if (a.length < 2 || b.length < 2) continue; n++; if (Math.abs(Math.abs(b[b.length - 1].a.v - a[a.length - 1].a.v) - b[b.length - 2].a.v) <= 1 || Math.abs(Math.abs(b[b.length - 1].a.v - a[a.length - 1].a.v) - b[0].a.v) <= 1) hit++; } rbOk = n >= 2 && hit / n >= 0.8; }
  const useCols = cols.length > 0; let prevBal: number | null = opening; let colHits = 0, colMiss = 0;
  for (const r of raws) {
    const t = r.tokens; let amt: number | null = null; let bal: number | undefined;
    if (useCols) {
      const mapped = t.map((x) => ({ ...x, kind: nearest(x.w)?.kind }));
      const balT = mapped.find((x) => x.kind === 'balance'); if (balT) bal = signed(balT.a);
      const d = mapped.find((x) => x.kind === 'debit'), c = mapped.find((x) => x.kind === 'credit'), a = mapped.find((x) => x.kind === 'amount');
      if (d && !c) amt = -d.a.v; else if (c && !d) amt = c.a.v; else if (a) amt = amountFromPrinted(a.a, creditCard);
      if (amt != null) colHits++; else colMiss++;
    }
    if (amt == null) {
      if (t.length >= 2 && rbOk) {
        const balTok = t[t.length - 1], cand = t[t.length - 2]; bal = signed(balTok.a);
        if (prevBal != null) { const delta = bal - prevBal; amt = Math.abs(Math.abs(delta) - cand.a.v) <= 1 ? delta : amountFromPrinted(cand.a, creditCard); } else amt = amountFromPrinted(cand.a, creditCard);
      } else amt = amountFromPrinted(t[0].a, creditCard);
    }
    if (bal == null && t.length >= 2 && rbOk) bal = signed(t[t.length - 1].a);
    r.row.amount = amt; if (bal != null) { r.row.balance = bal; prevBal = bal; }
    if (!rbOk && !useCols && t.length >= 2) (r.row.flags ??= []).push('ambiguous-columns');
  }
  const rows = raws.map((r) => r.row);
  if (useCols && colMiss > 0) warnings.push(`${colMiss} row(s) could not be matched to a column; signs may be wrong.`);

  // ---- reconcile ----
  const sum = rows.reduce((a, r) => a + r.amount, 0);
  let reconciled: boolean | null = null, difference: number | null = null;
  if (opening != null && closing != null) {
    const d1 = opening + sum - closing, d2 = opening - sum - closing; difference = creditCard ? d2 : d1;
    reconciled = Math.abs(d1) <= 1 || (creditCard && Math.abs(d2) <= 1); if (reconciled) difference = 0;
    if (!reconciled) warnings.push(`Opening balance + transactions does not equal the closing balance (off by ${(Math.abs(difference) / 100).toFixed(2)}). Some rows may be missing or mis-signed; review before importing.`);
  } else warnings.push('No opening and closing balance found, so the parse could not be checked against the statement totals.');
  if (unparsedDateLines) warnings.push(`${unparsedDateLines} line(s) started with a date but could not be read as a transaction.`);
  if (!rows.length) warnings.push('No transactions found. If this is a scanned image, it needs OCR, which is not supported.');
  if (rows.some((r) => r.flags?.includes('ambiguous-columns'))) warnings.push('Some rows have several amounts and no recognizable balance column; the first amount was used.');
  const confidence: StmtResult['confidence'] = !rows.length ? 'low' : reconciled === true ? 'high' : reconciled === false ? 'low' : rows.length >= 3 && !unparsedDateLines ? 'medium' : 'low';
  return { format: 'pdf', rows, period, opening, closing, reconciled, difference, creditCard, confidence, warnings, unparsedDateLines };
}
function amountFromPrinted(a: Amt, creditCard: boolean): number {
  if (creditCard) return a.neg || a.cr ? a.v : -a.v;   // card statements print purchases as positive; payments and credits as negative or CR
  return a.cr ? a.v : signed(a);
}

// ---------------- OFX / QFX ----------------
export function parseOFX(text: string): StmtResult {
  const warnings: string[] = []; const rows: StmtRow[] = [];
  const tag = (blk: string, t: string) => { const m = new RegExp(`<${t}>\\s*([^<\\r\\n]*)`, 'i').exec(blk); return m ? m[1].trim() : null; };
  const blocks = text.split(/<STMTTRN>/i).slice(1);
  blocks.forEach((raw, i) => {
    const blk = raw.split(/<\/STMTTRN>|<\/BANKTRANLIST>|<\/CCSTMTRS>|<\/STMTRS>/i)[0];
    const d = tag(blk, 'DTPOSTED'); const amtS = tag(blk, 'TRNAMT'); if (!d || !amtS) { warnings.push(`Transaction ${i + 1} is missing a date or amount.`); return; }
    const date = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`; const n = Number(amtS.replace(/,(\d{1,2})$/, '.$1').replace(/,/g, ''));
    if (!isDate(date) || !Number.isFinite(n)) { warnings.push(`Transaction ${i + 1} has an invalid date or amount.`); return; }
    const name = tag(blk, 'NAME') ?? tag(blk, 'PAYEE') ?? '', memo = tag(blk, 'MEMO') ?? '';
    const desc = (name && memo && !memo.toLowerCase().includes(name.toLowerCase()) ? `${name} ${memo}` : name || memo).trim();
    rows.push({ date, description: decodeEntities(desc) || tag(blk, 'TRNTYPE') || 'Transaction', amount: Math.round(n * 100), line: i + 1 });
  });
  const bal = tag(text, 'BALAMT'); const start = tag(text, 'DTSTART'), end = tag(text, 'DTEND'); const cur = tag(text, 'CURDEF') ?? undefined;
  const iso = (s: string | null) => (s && s.length >= 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null);
  if (!rows.length) warnings.push('No transactions found in this OFX/QFX file.');
  return { format: 'ofx', rows, period: iso(start) && iso(end) ? { start: iso(start)!, end: iso(end)! } : null, opening: null, closing: bal != null && Number.isFinite(Number(bal)) ? Math.round(Number(bal) * 100) : null, reconciled: null, difference: null, creditCard: /<CCSTMTRS>/i.test(text), confidence: rows.length ? 'high' : 'low', warnings, unparsedDateLines: 0, currency: cur };
}
const decodeEntities = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");

// ---------------- QIF ----------------
export function parseQIF(text: string): StmtResult {
  const warnings: string[] = []; const recs: Record<string, string>[] = []; let cur: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) { const l = raw.trimEnd(); if (!l || l.startsWith('!')) continue; if (l === '^') { if (Object.keys(cur).length) recs.push(cur); cur = {}; continue; } cur[l[0]] = l.slice(1).trim(); }
  if (Object.keys(cur).length) recs.push(cur);
  const dts = recs.map((r) => /^(\d{1,2})[/.-]\s*(\d{1,2})(?:['/.-]\s*(\d{2,4}))?$/.exec(r.D ?? '')).filter(Boolean) as RegExpExecArray[];
  const dmy = dts.some((m) => +m[1] > 12) && !dts.some((m) => +m[2] > 12);
  if (!dts.some((m) => +m[1] > 12 || +m[2] > 12)) warnings.push('Day/month order is ambiguous in this QIF file; assumed month/day. Check the preview dates.');
  const rows: StmtRow[] = [];
  recs.forEach((r, i) => {
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.test(r.D ?? '') ? r.D : (() => { const m = /^(\d{1,2})[/.-]\s*(\d{1,2})(?:['/.-]\s*(\d{2,4}))?$/.exec(r.D ?? ''); if (!m) return null; let y = m[3] ? +m[3] : +today().slice(0, 4); if (y < 100) y += 2000; return fmt(y, dmy ? +m[2] : +m[1], dmy ? +m[1] : +m[2]); })();
    const n = Number((r.T ?? r.U ?? '').replace(/,/g, '')); if (!iso || !isDate(iso) || !Number.isFinite(n) || (r.T ?? r.U) == null) { warnings.push(`Record ${i + 1} skipped: invalid date or amount.`); return; }
    rows.push({ date: iso, description: [r.P, r.M].filter(Boolean).join(' ').trim() || 'Transaction', amount: Math.round(n * 100), line: i + 1 });
  });
  if (!rows.length) warnings.push('No transactions found in this QIF file.');
  return { format: 'qif', rows, period: null, opening: null, closing: null, reconciled: null, difference: null, creditCard: /!Type:CCard/i.test(text), confidence: rows.length ? 'medium' : 'low', warnings, unparsedDateLines: 0 };
}

// ---------------- output ----------------
/** Normalized CSV the existing import pipeline understands (Date,Description,Amount; ISO dates; signed decimals). */
export const toNormalizedCSV = (rows: StmtRow[]) => toCSV([['Date', 'Description', 'Amount'], ...rows.map((r) => [r.date, r.description, (r.amount / 100).toFixed(2)])]);

/** Finalize a result for rows produced by another extractor (e.g. the AI fallback): reconcile against known balances. */
export function finalizeRows(rows: StmtRow[], base: Pick<StmtResult, 'opening' | 'closing' | 'creditCard' | 'period'>, format: StmtResult['format']): StmtResult {
  const warnings: string[] = []; const sum = rows.reduce((a, r) => a + r.amount, 0); let reconciled: boolean | null = null, difference: number | null = null;
  if (base.opening != null && base.closing != null) { const d1 = base.opening + sum - base.closing, d2 = base.opening - sum - base.closing; reconciled = Math.abs(d1) <= 1 || (base.creditCard && Math.abs(d2) <= 1); difference = reconciled ? 0 : base.creditCard ? d2 : d1; if (!reconciled) warnings.push(`Totals do not reconcile (off by ${(Math.abs(difference) / 100).toFixed(2)}).`); }
  else warnings.push('No opening and closing balance available to check the result.');
  return { format, rows, period: base.period, opening: base.opening, closing: base.closing, reconciled, difference, creditCard: base.creditCard, confidence: !rows.length ? 'low' : reconciled === true ? 'high' : 'low', warnings, unparsedDateLines: 0 };
}
