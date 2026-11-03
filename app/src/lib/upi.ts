import QRCode from 'qrcode';
import { z } from 'zod';
import { all, get, run, tx, Row } from './db';
import { ApiError, Ctx, audit } from './auth';
import * as S from './service';
import { budgetPeriod, today } from './domain/dates';
import { appOf, buildUpiLink, handleOf, isVpa, parseUpiLink, parseUpiNarration, UPI_DEFAULT_LIMIT } from './domain/upi';
import { rate } from './service';

const vpa = z.string().trim().refine(isVpa, 'Enter a valid UPI ID like name@bank');
export const payeeSchema = z.object({ name: z.string().trim().min(1).max(60), vpa, category_id: z.number().int().nullish(), recurring_id: z.number().int().nullish(), note: z.string().max(100).nullish() });
export const ownIdSchema = z.object({ vpa, account_id: z.number().int().nullish(), app: z.string().max(40).nullish() });

export function upiSummary(c: Ctx) {
  const per = budgetPeriod(today(), c.startDay); const base = `FROM transactions WHERE workspace_id=? AND deleted_at IS NULL AND payment_method='upi'`;
  const out = get(`SELECT COALESCE(SUM(-base_amount),0) s, COUNT(*) n ${base} AND kind='expense' AND posted_date BETWEEN ? AND ?`, c.wid, per.start, per.end) as Row;
  const inn = get(`SELECT COALESCE(SUM(base_amount),0) s, COUNT(*) n ${base} AND kind='income' AND posted_date BETWEEN ? AND ?`, c.wid, per.start, per.end) as Row;
  const todayRows = all(`SELECT -amount a, currency ${base} AND kind='expense' AND posted_date=?`, c.wid, today());
  const inrToday = todayRows.reduce((a, r) => a + (r.currency === 'INR' ? r.a : Math.round(r.a * rate(r.currency, 'INR'))), 0) / 100;
  const top = all(`SELECT COALESCE(merchant, upi_vpa, 'Unknown') name, upi_vpa vpa, COUNT(*) n, SUM(-base_amount) total ${base} AND kind='expense' AND posted_date BETWEEN ? AND ? GROUP BY COALESCE(upi_vpa, merchant) ORDER BY total DESC LIMIT 8`, c.wid, per.start, per.end);
  const byApp = new Map<string, number>(); for (const r of all(`SELECT upi_vpa, -base_amount a ${base} AND kind='expense' AND upi_vpa IS NOT NULL AND posted_date BETWEEN ? AND ?`, c.wid, per.start, per.end)) { const k = appOf(r.upi_vpa) ?? handleOf(r.upi_vpa); byApp.set(k, (byApp.get(k) ?? 0) + r.a); }
  const recent = all(`SELECT t.id,t.posted_date,t.description,t.merchant,t.amount,t.currency,t.upi_vpa,t.upi_ref,t.kind,a.name account_name ${base.replace('FROM transactions', 'FROM transactions t JOIN accounts a ON a.id=t.account_id').replace(/workspace_id/, 't.workspace_id').replace('deleted_at', 't.deleted_at').replace('payment_method', 't.payment_method')} ORDER BY t.posted_date DESC, t.id DESC LIMIT 15`, c.wid);
  return { base: c.base, period: per, sent: { total: out.s, count: out.n }, received: { total: inn.s, count: inn.n }, today_inr: inrToday, daily_limit_inr: UPI_DEFAULT_LIMIT, top_payees: top, by_app: [...byApp].map(([name, total]) => ({ name, total })).sort((a, b) => b.total - a.total), recent };
}

export async function makeLink(c: Ctx, b: { payee_id?: number; vpa?: string; name?: string; amount?: number; note?: string }) {
  let v = b.vpa, name = b.name;
  if (b.payee_id) { const p = get('SELECT * FROM upi_payees WHERE id=? AND workspace_id=?', b.payee_id, c.wid); if (!p) throw new ApiError(404, 'Payee not found'); v = p.vpa; name = name ?? p.name; }
  if (!v) throw new ApiError(400, 'Choose a payee or enter a UPI ID', 'validation', { vpa: 'Required' });
  let link: string; try { link = buildUpiLink({ vpa: v, name, amount: b.amount, note: b.note }); } catch (e) { throw new ApiError(400, (e as Error).message, 'validation', { vpa: isVpa(v) ? '' : 'Invalid UPI ID', amount: 'Check the amount' }); }
  const svg = await QRCode.toString(link, { type: 'svg', margin: 1, width: 220, errorCorrectionLevel: 'M' });
  return { link, qr_svg: svg, vpa: v, name: name ?? null, app: appOf(v!), warnings: b.amount && b.amount > UPI_DEFAULT_LIMIT ? [`Above ₹${UPI_DEFAULT_LIMIT.toLocaleString('en-IN')}: many UPI apps and banks will decline this. Check your limit.`] : [] };
}
export const parseAny = (text: string) => { const l = parseUpiLink(text); if (l) return { type: 'link', ...l }; const n = parseUpiNarration(text); return n ? { type: 'narration', ...n } : { type: 'unknown' }; };

/** Records a UPI payment the user made in their UPI app. Optionally settles a bill. */
export function recordPayment(c: Ctx, b: { account_id: number; vpa: string; name?: string | null; amount: number; date: string; ref?: string | null; note?: string | null; payee_id?: number | null; bill?: { recurring_id: number; due: string } | null }) {
  if (b.ref && !/^\d{12}$/.test(b.ref)) throw new ApiError(400, 'A UPI reference (UTR/RRN) has 12 digits', 'validation', { ref: '12 digits' });
  if (b.ref && get('SELECT 1 FROM transactions WHERE workspace_id=? AND upi_ref=? AND deleted_at IS NULL', c.wid, b.ref)) throw new ApiError(409, 'A payment with this UPI reference is already recorded', 'duplicate', { ref: 'Already recorded' });
  const payee = b.payee_id ? get('SELECT * FROM upi_payees WHERE id=? AND workspace_id=?', b.payee_id, c.wid) : get('SELECT * FROM upi_payees WHERE workspace_id=? AND vpa=? COLLATE NOCASE', c.wid, b.vpa);
  return tx(() => {
    let id: number;
    if (b.bill) { id = S.markBillPaid(c, b.bill.recurring_id, b.bill.due, b.account_id, b.date, b.amount) as number; run("UPDATE transactions SET payment_method='upi', upi_vpa=?, upi_ref=?, merchant=COALESCE(?,merchant) WHERE id=? AND workspace_id=?", b.vpa, b.ref ?? null, b.name ?? payee?.name ?? null, id, c.wid); }
    else id = S.insertTxn(c, { account_id: b.account_id, posted_date: b.date, amount: -Math.abs(b.amount), description: `UPI to ${b.name ?? payee?.name ?? b.vpa}${b.note ? ' - ' + b.note : ''}`, merchant: b.name ?? payee?.name ?? null, category_id: payee?.category_id ?? undefined, payment_method: 'upi', upi_vpa: b.vpa, upi_ref: b.ref ?? null });
    audit(c, 'upi_payment', id, 'record', { vpa: b.vpa }); return id;
  });
}
