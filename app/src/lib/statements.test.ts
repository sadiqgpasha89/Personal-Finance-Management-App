import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { extractPdfLines, sniff, redact, extractWithClaude } from './statements';
import { parseStatementLines, parseOFX, parseQIF, parseAmount, linesFromText, toNormalizedCSV } from './domain/statements';
import { parseCSV, guessMapping, applyMapping } from './domain/csv';

const dir = path.join(__dirname, '../../samples/statements');
const truth = (n: string) => JSON.parse(fs.readFileSync(path.join(dir, n + '.expected.json'), 'utf8'));
const readPdf = async (n: string) => { const { lines } = await extractPdfLines(new Uint8Array(fs.readFileSync(path.join(dir, n + '.pdf')))); return parseStatementLines(lines, { today: '2026-02-10' }); };

describe('amount parsing', () => {
  it('handles the ways banks print negatives and credits', () => {
    const p = (s: string, c = false) => parseAmount(s, c)!;
    expect(p('1,234.56')).toMatchObject({ v: 123456, neg: false }); expect(p('(45.67)').neg).toBe(true); expect(p('45.67-').neg).toBe(true); expect(p('-$45.67').neg).toBe(true);
    expect(p('45.67CR').cr).toBe(true); expect(p('45.67DR').neg).toBe(true); expect(p('1.234,56', true)).toMatchObject({ v: 123456 }); expect(p('45,67-', true)).toMatchObject({ v: 4567, neg: true });
    expect(parseAmount('2026', false)).toBeNull(); expect(parseAmount('45.6', false)).toBeNull(); expect(parseAmount('1-800-555-0100', false)).toBeNull();
  });
});

describe.each(['sample-checking', 'sample-creditcard', 'sample-currentaccount', 'sample-european'])('PDF statement %s', (name) => {
  it('extracts every transaction with the right date, sign and amount, and reconciles', async () => {
    const r = await readPdf(name), t = truth(name);
    expect(r.rows.map((x) => [x.date, x.amount])).toEqual(t.rows.map((x: any) => [x.date, x.amount]));
    r.rows.forEach((x, i) => expect(x.description.startsWith(t.rows[i].description)).toBe(true));
    expect(r.opening).toBe(t.opening); expect(r.closing).toBe(t.closing);
    expect(r.reconciled).toBe(true); expect(r.confidence).toBe('high'); expect(r.creditCard).toBe(!!t.credit_card);
  });
});

describe('PDF edge cases', () => {
  it('joins wrapped description lines but not page footers', async () => {
    const r = await readPdf('sample-checking'); const d = r.rows.find((x) => x.description.startsWith('DELTA'))!;
    expect(d.description).toContain('CONFIRMATION'); expect(r.rows.some((x) => /Questions|FDIC/.test(x.description))).toBe(false);
  });
  it('resolves year-less dates across a year boundary from the statement period', async () => {
    const r = await readPdf('sample-creditcard'); expect(r.period).toEqual({ start: '2025-12-26', end: '2026-01-25' }); expect(r.rows[0].date).toBe('2025-12-28'); expect(r.rows[3].date).toBe('2026-01-03');
  });
  it('flags a parse that does not reconcile instead of hiding it', () => {
    const txt = `Statement period 01/01/2026 - 01/31/2026\nBeginning balance 100.00\nDate Description Withdrawals Deposits Balance\n01/02 SHOP A 10.00 90.00\n01/03 SHOP B 20.00 70.00\n01/04 SHOP C 5.00 65.00\nEnding balance 40.00`;
    const r = parseStatementLines(linesFromText(txt)); expect(r.reconciled).toBe(false); expect(r.confidence).toBe('low'); expect(r.warnings.join(' ')).toMatch(/does not equal/);
  });
  it('text with no transactions says so', () => { const r = parseStatementLines(linesFromText('Hello world\nNothing here')); expect(r.rows).toHaveLength(0); expect(r.warnings.join(' ')).toMatch(/No transactions/); });
  it('rejects a PDF without a text layer and non-PDF bytes', async () => {
    const blank = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
    await expect(extractPdfLines(new Uint8Array(blank))).rejects.toThrow(); await expect(extractPdfLines(new Uint8Array(Buffer.from('not a pdf')))).rejects.toThrow();
  });
});

describe('password-protected PDFs', () => {
  const locked = () => new Uint8Array(fs.readFileSync(path.join(dir, 'sample-locked.pdf')));
  it('asks for the password, rejects a wrong one, and reads with the right one', async () => {
    await expect(extractPdfLines(locked())).rejects.toMatchObject({ code: 'password_required' });
    await expect(extractPdfLines(locked(), 'nope')).rejects.toMatchObject({ code: 'password_incorrect' });
    const { lines } = await extractPdfLines(locked(), 'secret1'); expect(parseStatementLines(lines).rows).toHaveLength(12);
  });
});

describe('layout variations (text fixtures)', () => {
  it('uses column position when there is no balance column', () => {
    const t = ['Statement period 03/01/2026 - 03/31/2026', 'Opening balance                                      1,000.00', 'Date   Description                 Money out    Money in',
      '03/02  GROCERY MART                      45.10', '03/05  SALARY                                       2,000.00', '03/09  GAS & GO 12.50 PROMO              30.00', 'Closing balance                                      2,924.90'].join('\n');
    const r = parseStatementLines(linesFromText(t)); expect(r.rows.map((x) => x.amount)).toEqual([-4510, 200000, -3000]); expect(r.rows[2].description).toBe('GAS & GO 12.50 PROMO'); expect(r.reconciled).toBe(true);
  });
  it('reads one signed amount column with CR/DR and trailing minus, ignoring phone numbers and years in text', () => {
    const t = ['Statement period 05/01/2026 - 05/31/2026', 'Previous balance 500.00', 'Date Description Amount', '05/03 PAYROLL 1,200.00CR', '05/04 ELECTRIC 1-800-555-0100 85.20DR', '05/06 REFUND STORE 2026 15.00-'].join('\n');
    const r = parseStatementLines(linesFromText(t)); expect(r.rows.map((x) => x.amount)).toEqual([120000, -8520, -1500]); expect(r.rows[1].description).toContain('1-800-555-0100');
  });
  it('does not turn summary lines into transactions', () => {
    const t = ['Statement period 02/01/2026 - 02/28/2026', 'Date Description Amount Balance', '02/01 Beginning balance 100.00', '02/02 SHOP 10.00 90.00', '02/03 Total fees 0.00 90.00', '02/28 Ending balance 90.00'].join('\n');
    const r = parseStatementLines(linesFromText(t)); expect(r.rows).toHaveLength(1);
  });
});

describe('OFX and QIF', () => {
  it('parses SGML OFX with signed amounts, names and memos', () => {
    const r = parseOFX(fs.readFileSync(path.join(dir, 'sample.ofx'), 'utf8')), t = truth('sample-ofx');
    expect(r.rows.map((x) => [x.date, x.amount, x.description])).toEqual(t.rows.map((x: any) => [x.date, x.amount, x.description])); expect(r.closing).toBe(315616); expect(r.currency).toBe('USD'); expect(r.period).toEqual({ start: '2026-01-01', end: '2026-01-31' });
  });
  it('parses XML-style OFX', () => { const r = parseOFX('<OFX><STMTTRN><DTPOSTED>20260105</DTPOSTED><TRNAMT>-12.50</TRNAMT><NAME>A &amp; B</NAME></STMTTRN></OFX>'); expect(r.rows[0]).toMatchObject({ date: '2026-01-05', amount: -1250, description: 'A & B' }); });
  it('parses QIF and warns when day/month order is ambiguous', () => {
    const r = parseQIF(fs.readFileSync(path.join(dir, 'sample.qif'), 'utf8')); expect(r.rows).toHaveLength(4); expect(r.rows[0]).toMatchObject({ date: '2026-01-05', amount: -6575 }); expect(r.rows[1].amount).toBe(285000); expect(r.warnings.join(' ')).toMatch(/ambiguous/);
    expect(parseQIF("!Type:Bank\nD25/12/2025\nT-5.00\nPX\n^\n").rows[0].date).toBe('2025-12-25');
  });
});

describe('integration with the CSV pipeline and helpers', () => {
  it('normalized CSV round-trips through the existing mapper', async () => {
    const r = await readPdf('sample-checking'); const rows = parseCSV(toNormalizedCSV(r.rows)); const m = guessMapping(rows[0])!;
    const out = applyMapping(rows, m, 'USD'); expect(out.errors).toHaveLength(0); expect(out.rows.map((x) => x.amount)).toEqual(r.rows.map((x) => x.amount));
  });
  it('sniffs formats', () => { expect(sniff('a.pdf', '%PDF-1.7')).toBe('pdf'); expect(sniff('x.qfx', '')).toBe('ofx'); expect(sniff('x.txt', 'OFXHEADER:100')).toBe('ofx'); expect(sniff('x.txt', '!Type:Bank')).toBe('qif'); expect(sniff('x.csv', 'Date,Amount')).toBe('csv'); });
  it('redacts account numbers before anything leaves the server', () => { expect(redact('Acct 123456789012 card 4111 1111 1111 1234')).toBe('Acct ••••••••9012 card •••• •••• •••• 1234'); });
});

describe('AI extraction (stubbed client)', () => {
  const base = { opening: 10000, closing: 7000, creditCard: false, period: null } as any;
  const fake = (input: any, stop = 'tool_use') => ({ messages: { stream: () => ({ finalMessage: async () => ({ stop_reason: stop, content: [{ type: 'tool_use', id: 't', name: 'submit_transactions', input }] }) }) } }) as any;
  const lines = linesFromText('some statement text 123456789012');
  it('validates, converts to minor units, and reconciles', async () => {
    const r = await extractWithClaude(lines, base, fake({ opening_balance: 100, closing_balance: 70, is_credit_card: false, transactions: [{ date: '2026-01-02', description: 'A', amount: -10 }, { date: '2026-01-03', description: 'B', amount: -20 }, { date: 'bad', description: 'C', amount: 1 }] }));
    expect(r.rows.map((x) => x.amount)).toEqual([-1000, -2000]); expect(r.reconciled).toBe(true); expect(r.format).toBe('ai'); expect(r.warnings.join(' ')).toMatch(/discarded/);
  });
  it('rejects malformed model output and truncation', async () => {
    await expect(extractWithClaude(lines, base, fake({ nope: 1 }))).rejects.toThrow(/could not read/); await expect(extractWithClaude(lines, base, fake({}, 'max_tokens'))).rejects.toThrow(/too large/);
  });
  it('never sends raw long digit runs', async () => {
    let sent = ''; const c = { messages: { stream: (req: any) => { sent = JSON.stringify(req.messages); return { finalMessage: async () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'submit_transactions', input: { opening_balance: null, closing_balance: null, is_credit_card: false, transactions: [] } }] }) }; } } } as any;
    await extractWithClaude(lines, base, c); expect(sent).not.toContain('123456789012'); expect(sent).toContain('9012');
  });
});
