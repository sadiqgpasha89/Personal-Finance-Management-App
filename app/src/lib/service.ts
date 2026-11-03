import { all, get, run, tx, Row } from './db';
import { Ctx, ApiError, audit } from './auth';
import { convert, formatMoney } from './domain/money';
import { addDays, addMonths, budgetPeriod, diffDays, monthKey, shiftPeriod, today, parts } from './domain/dates';
import { categorize, normalizeMerchant, Rule, AUTO_APPLY_THRESHOLD } from './domain/categorize';
import { parseUpiNarration } from './domain/upi';
import { available, Rollover, monthlyRequired } from './domain/budget';
import { Txn, detectSubscriptions, forecast, safeToSpend, insights, healthScore, statementCycle } from './domain/analytics';
import { occurrences, nextOccurrence, Cadence, monthlyEquivalent } from './domain/recurrence';
import { schedule, monthlyPayment } from './domain/amortization';

// ---------- FX ----------
export function rate(from: string, to: string): number {
  if (from === to) return 1;
  const r = (q: string) => (get('SELECT rate FROM fx_rates WHERE quote=?', q)?.rate as number | undefined) ?? 1;
  return r(to) / r(from);
}
export const toBase = (c: Ctx, amount: number, cur: string, rt?: number) => convert(amount, rt ?? rate(cur, c.base), cur, c.base);

// ---------- Lookups ----------
export const catByName = (wid: number, name: string) => get('SELECT * FROM categories WHERE workspace_id=? AND name=? COLLATE NOCASE', wid, name) as Row | undefined;
export function ensureCategory(wid: number, name: string, kind = 'expense'): number {
  const c = catByName(wid, name); if (c) return c.id;
  return Number(run('INSERT INTO categories(workspace_id,name,kind) VALUES(?,?,?)', wid, name, kind).lastInsertRowid);
}
export function account(c: Ctx, id: number): Row {
  const a = get('SELECT * FROM accounts WHERE id=? AND workspace_id=?', id, c.wid); if (!a) throw new ApiError(404, 'Account not found'); return a;
}
export const loadRules = (wid: number): Rule[] => all('SELECT * FROM rules WHERE workspace_id=?', wid).map((r) => ({ id: r.id, priority: r.priority, active: !!r.active, conditions: JSON.parse(r.conditions_json), actions: JSON.parse(r.actions_json) }));
export function loadMemory(wid: number): Record<string, string> {
  const m: Record<string, string> = {};
  for (const r of all('SELECT mm.merchant,c.name FROM merchant_memory mm JOIN categories c ON c.id=mm.category_id WHERE mm.workspace_id=?', wid)) m[r.merchant] = r.name;
  return m;
}

// ---------- Balances ----------
export function accountsWithBalance(c: Ctx): Row[] {
  return all(`SELECT a.*, a.opening_balance + COALESCE((SELECT SUM(amount) FROM transactions t WHERE t.account_id=a.id AND t.deleted_at IS NULL),0) AS balance,
    (SELECT COUNT(*) FROM transactions t WHERE t.account_id=a.id AND t.deleted_at IS NULL) AS txn_count FROM accounts a WHERE a.workspace_id=? ORDER BY a.is_archived, a.sort_order, a.id`, c.wid)
    .map((a): Row => ({ ...a, balance_base: toBase(c, a.balance, a.currency) }));
}
export const isLiability = (type: string) => type === 'credit_card' || type === 'loan';

// ---------- Transactions ----------
export interface TxnInput {
  account_id: number; posted_date: string; amount: number; kind?: 'income' | 'expense'; description?: string; merchant?: string | null; category_id?: number | null;
  notes?: string | null; tags?: string[]; status?: 'pending' | 'posted'; external_id?: string | null; import_batch_id?: number | null; recurring_id?: number | null;
  fx_rate?: number; reimbursable?: boolean; refund_of_id?: number | null; skipAuto?: boolean;
  card_id?: number | null; payment_method?: string | null; upi_vpa?: string | null; upi_ref?: string | null;
}
export function insertTxn(c: Ctx, i: TxnInput, rules?: Rule[], mem?: Record<string, string>): number {
  const acct = account(c, i.account_id);
  const kind = i.kind ?? (i.amount >= 0 ? 'income' : 'expense');
  // UPI and card details found in the narration (e.g. bank statements, Account Aggregator data)
  let { card_id = null, payment_method = null, upi_vpa = null, upi_ref = null } = i;
  const upi = payment_method && payment_method !== 'upi' ? null : parseUpiNarration(i.description ?? '');
  if (upi) {
    payment_method = 'upi'; upi_vpa = upi_vpa ?? upi.vpa; upi_ref = upi_ref ?? upi.ref;
    const known = upi_vpa ? get('SELECT name, category_id FROM upi_payees WHERE workspace_id=? AND vpa=? COLLATE NOCASE', c.wid, upi_vpa) : undefined;
    if (!i.merchant && (known?.name || upi.payee)) i = { ...i, merchant: known?.name ?? upi.payee };
    if (i.category_id == null && known?.category_id) i = { ...i, category_id: known.category_id };
  }
  if (!card_id && !upi) {
    const last4 = /(?:card|xx+|x{2,}|\*{2,}|ending)\s*(?:no\.?)?\s*(\d{4})\b/i.exec(i.description ?? '')?.[1];
    if (last4) { const k = get("SELECT id FROM cards WHERE workspace_id=? AND last4=? AND status='active' AND (account_id IS NULL OR account_id=?)", c.wid, last4, i.account_id); if (k) { card_id = k.id; payment_method = payment_method ?? 'card'; } }
  }
  let category = i.category_id ?? null, merchant = i.merchant ?? null, tags = i.tags ?? [], auto = 0;
  if (!i.skipAuto && (kind !== 'income' || category == null)) {
    const r = categorize({ description: i.description ?? '', merchant, amount: i.amount, accountId: i.account_id }, rules ?? loadRules(c.wid), mem ?? loadMemory(c.wid));
    merchant = merchant ?? r.merchant;
    if (r.tag) tags = [...tags, r.tag];
    if (category == null && r.category && (r.source === 'rule' || r.confidence >= AUTO_APPLY_THRESHOLD)) { category = ensureCategory(c.wid, r.category, kind === 'income' ? 'income' : 'expense'); auto = 1; }
  } else if (!merchant && i.description) merchant = normalizeMerchant(i.description);
  const rt = i.fx_rate ?? rate(acct.currency, c.base);
  const res = run(`INSERT INTO transactions(workspace_id,account_id,posted_date,amount,currency,base_amount,fx_rate,fx_overridden,kind,status,description,merchant,category_id,notes,tags,reimbursable,refund_of_id,external_id,import_batch_id,recurring_id,auto_categorized,card_id,payment_method,upi_vpa,upi_ref)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, c.wid, i.account_id, i.posted_date, i.amount, acct.currency, toBase(c, i.amount, acct.currency, rt), rt, i.fx_rate ? 1 : 0,
    kind, i.status ?? 'posted', i.description ?? '', merchant, category, i.notes ?? null, JSON.stringify(tags), i.reimbursable ? 1 : 0, i.refund_of_id ?? null, i.external_id ?? null, i.import_batch_id ?? null, i.recurring_id ?? null, auto, card_id, payment_method, upi_vpa, upi_ref);
  return Number(res.lastInsertRowid);
}
export function insertTransfer(c: Ctx, from: number, to: number, amount: number, date: string, notes?: string | null) {
  if (from === to) throw new ApiError(400, 'Choose two different accounts', 'validation', { to_account: 'Must differ from source' });
  const a = account(c, from), b = account(c, to);
  if (amount <= 0) throw new ApiError(400, 'Amount must be positive', 'validation', { amount: 'Must be positive' });
  return tx(() => {
    const out = insertTxn(c, { account_id: from, posted_date: date, amount: -amount, kind: 'transfer' as any, description: `Transfer to ${b.name}`, notes, skipAuto: true });
    const inAmt = a.currency === b.currency ? amount : convert(amount, rate(a.currency, b.currency), a.currency, b.currency);
    const inn = insertTxn(c, { account_id: to, posted_date: date, amount: inAmt, kind: 'transfer' as any, description: `Transfer from ${a.name}`, notes, skipAuto: true });
    run('UPDATE transactions SET transfer_pair_id=? WHERE id=?', inn, out); run('UPDATE transactions SET transfer_pair_id=? WHERE id=?', out, inn);
    audit(c, 'transfer', out, 'create', { from, to, amount });
    return out;
  });
}
export interface Filters { q?: string; account_id?: number; category_id?: number; kind?: string; from?: string; to?: string; min?: number; max?: number; tag?: string; merchant?: string; uncategorized?: boolean; status?: string; deleted?: boolean; limit?: number; cursor?: string; sort?: string }
export function listTxns(c: Ctx, f: Filters) {
  const w: string[] = ['t.workspace_id=?']; const p: any[] = [c.wid];
  w.push(f.deleted ? 't.deleted_at IS NOT NULL' : 't.deleted_at IS NULL');
  if (f.q) { w.push('(t.description LIKE ? OR t.merchant LIKE ? OR t.notes LIKE ?)'); const q = `%${f.q.replace(/[%_]/g, '')}%`; p.push(q, q, q); }
  if (f.account_id) { w.push('t.account_id=?'); p.push(f.account_id); }
  if (f.category_id) { w.push('(t.category_id=? OR EXISTS(SELECT 1 FROM transaction_splits s WHERE s.transaction_id=t.id AND s.category_id=?))'); p.push(f.category_id, f.category_id); }
  if (f.uncategorized) w.push("t.category_id IS NULL AND t.kind!='transfer' AND NOT EXISTS(SELECT 1 FROM transaction_splits s WHERE s.transaction_id=t.id)");
  if (f.kind) { w.push('t.kind=?'); p.push(f.kind); }
  if (f.status) { w.push('t.status=?'); p.push(f.status); }
  if (f.from) { w.push('t.posted_date>=?'); p.push(f.from); } if (f.to) { w.push('t.posted_date<=?'); p.push(f.to); }
  if (f.min != null) { w.push('ABS(t.amount)>=?'); p.push(f.min); } if (f.max != null) { w.push('ABS(t.amount)<=?'); p.push(f.max); }
  if (f.tag) { w.push('t.tags LIKE ?'); p.push(`%"${f.tag.replace(/["%_]/g, '')}"%`); }
  if (f.merchant) { w.push('t.merchant=?'); p.push(f.merchant); }
  const lim = Math.min(f.limit ?? 50, 500);
  const order = f.sort === 'amount' ? 'ABS(t.amount) DESC, t.id DESC' : f.sort === 'date_asc' ? 't.posted_date ASC, t.id ASC' : 't.posted_date DESC, t.id DESC';
  const off = f.cursor ? Math.max(0, parseInt(f.cursor, 10) || 0) : 0;
  const rows = all(`SELECT t.*, c.name category, a.name account_name, (SELECT COUNT(*) FROM transaction_splits s WHERE s.transaction_id=t.id) split_count
    FROM transactions t LEFT JOIN categories c ON c.id=t.category_id JOIN accounts a ON a.id=t.account_id WHERE ${w.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`, ...p, lim + 1, off);
  const total = (get(`SELECT COUNT(*) n, COALESCE(SUM(base_amount),0) s FROM transactions t WHERE ${w.join(' AND ')}`, ...p) as Row);
  return { items: rows.slice(0, lim).map((r) => ({ ...r, tags: JSON.parse(r.tags || '[]') })), next: rows.length > lim ? String(off + lim) : null, total: total.n, sum_base: total.s };
}
export function getTxn(c: Ctx, id: number): Row {
  const t = get('SELECT * FROM transactions WHERE id=? AND workspace_id=?', id, c.wid); if (!t) throw new ApiError(404, 'Transaction not found'); return t;
}
export function updateTxn(c: Ctx, id: number, patch: Record<string, any>) {
  const t = getTxn(c, id);
  return tx(() => {
    const sets: string[] = [], p: any[] = [];
    const set = (col: string, v: any) => { sets.push(`${col}=?`); p.push(v); };
    for (const k of ['description', 'merchant', 'notes', 'status', 'posted_date', 'category_id', 'reimbursable', 'reimbursed_amount', 'reconciled', 'refund_of_id', 'card_id', 'payment_method', 'upi_vpa', 'upi_ref'] as const)
      if (k in patch) set(k, typeof patch[k] === 'boolean' ? +patch[k] : patch[k]);
    if ('tags' in patch) set('tags', JSON.stringify(patch.tags));
    if ('amount' in patch || 'account_id' in patch || 'fx_rate' in patch || 'posted_date' in patch) {
      const acctId = patch.account_id ?? t.account_id; const a = account(c, acctId); const amt = patch.amount ?? t.amount;
      const rt = patch.fx_rate ?? (a.currency === t.currency && !('account_id' in patch) ? t.fx_rate : rate(a.currency, c.base));
      set('amount', amt); set('account_id', acctId); set('currency', a.currency); set('fx_rate', rt); set('base_amount', toBase(c, amt, a.currency, rt)); if (patch.fx_rate) set('fx_overridden', 1);
      if (patch.amount != null && t.kind !== 'transfer') set('kind', patch.amount >= 0 ? 'income' : 'expense');
    }
    if ('category_id' in patch) set('auto_categorized', 0);
    if (!sets.length) return;
    run(`UPDATE transactions SET ${sets.join(',')}, row_version=row_version+1 WHERE id=?`, ...p, id);
    // linked transfer leg follows date edits
    if (t.transfer_pair_id && 'posted_date' in patch) run('UPDATE transactions SET posted_date=? WHERE id=?', patch.posted_date, t.transfer_pair_id);
    // merchant memory: learn from user-chosen categories
    if (patch.category_id && t.kind !== 'transfer') { const m = patch.merchant ?? t.merchant; if (m) run('INSERT INTO merchant_memory(workspace_id,merchant,category_id) VALUES(?,?,?) ON CONFLICT(workspace_id,merchant) DO UPDATE SET category_id=excluded.category_id', c.wid, m, patch.category_id); }
    audit(c, 'transaction', id, 'update', patch);
  });
}
export function deleteTxn(c: Ctx, id: number, restore = false) {
  const t = getTxn(c, id);
  tx(() => {
    const ids = [id, t.transfer_pair_id].filter(Boolean);
    for (const i of ids) run(restore ? 'UPDATE transactions SET deleted_at=NULL WHERE id=? AND workspace_id=?' : "UPDATE transactions SET deleted_at=datetime('now') WHERE id=? AND workspace_id=?", i, c.wid);
    audit(c, 'transaction', id, restore ? 'restore' : 'delete');
  });
}
export function purgeOldDeleted() { run("DELETE FROM transactions WHERE deleted_at IS NOT NULL AND deleted_at < datetime('now','-30 days')"); }
export function setSplits(c: Ctx, id: number, splits: { category_id: number | null; amount: number; notes?: string }[]) {
  const t = getTxn(c, id);
  if (splits.length && splits.reduce((a, s) => a + s.amount, 0) !== t.amount) throw new ApiError(400, 'Splits must add up to the transaction amount', 'validation', { splits: `Off by ${formatMoney(t.amount - splits.reduce((a, s) => a + s.amount, 0), t.currency)}` });
  tx(() => { run('DELETE FROM transaction_splits WHERE transaction_id=?', id); for (const s of splits) run('INSERT INTO transaction_splits(transaction_id,category_id,amount,notes) VALUES(?,?,?,?)', id, s.category_id, s.amount, s.notes ?? null); });
}

// ---------- Spending aggregation (base currency, splits-aware, refunds net, reimbursements excluded) ----------
export interface SpendRow { id: number; date: string; cid: number | null; cname: string | null; spend: number; merchant: string | null; kind: string }
export function spendRows(c: Ctx, start: string, end: string): SpendRow[] {
  const rows = all(`SELECT t.id,t.posted_date date,t.base_amount,t.amount,t.fx_rate,t.reimbursed_amount,t.merchant,t.kind,t.category_id cid,c.name cname FROM transactions t LEFT JOIN categories c ON c.id=t.category_id
    WHERE t.workspace_id=? AND t.deleted_at IS NULL AND t.kind='expense' AND t.posted_date BETWEEN ? AND ?`, c.wid, start, end);
  const splits = new Map<number, Row[]>();
  if (rows.length) for (const s of all(`SELECT s.*, c.name cname FROM transaction_splits s LEFT JOIN categories c ON c.id=s.category_id WHERE s.transaction_id IN (SELECT id FROM transactions WHERE workspace_id=? AND posted_date BETWEEN ? AND ?)`, c.wid, start, end)) (splits.get(s.transaction_id) ?? splits.set(s.transaction_id, []).get(s.transaction_id)!).push(s);
  const out: SpendRow[] = [];
  for (const r of rows) {
    const sp = splits.get(r.id); const reimb = Math.round(r.reimbursed_amount * r.fx_rate);
    if (sp?.length) for (const s of sp) out.push({ id: r.id, date: r.date, cid: s.category_id, cname: s.cname, spend: -Math.round(s.amount * r.fx_rate), merchant: r.merchant, kind: r.kind });
    else out.push({ id: r.id, date: r.date, cid: r.cid, cname: r.cname, spend: -r.base_amount - reimb, merchant: r.merchant, kind: r.kind });
  }
  return out;
}
export const incomeTotal = (c: Ctx, start: string, end: string) => (get(`SELECT COALESCE(SUM(base_amount),0) s FROM transactions WHERE workspace_id=? AND deleted_at IS NULL AND kind='income' AND posted_date BETWEEN ? AND ?`, c.wid, start, end)?.s as number) ?? 0;
const sumBy = (rows: SpendRow[], key: (r: SpendRow) => string) => { const m = new Map<string, number>(); for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + r.spend); return m; };

// ---------- Budgets ----------
export function budgetSummary(c: Ctx, periodStart?: string) {
  const per = budgetPeriod(periodStart ?? today(), c.startDay);
  const items = all(`SELECT b.*, c.name category, c.group_name FROM budgets b JOIN categories c ON c.id=b.category_id WHERE b.workspace_id=? ORDER BY c.group_name, c.name`, c.wid);
  const spent = sumBy(spendRows(c, per.start, per.end), (r) => String(r.cid));
  // rollover: walk back up to 12 periods
  const hist: Map<string, number>[] = []; const periods = [per];
  for (let i = 1; i <= 12; i++) periods.unshift(shiftPeriod(per.start, -i, c.startDay));
  const firstTxn = get('SELECT MIN(posted_date) d FROM transactions WHERE workspace_id=? AND deleted_at IS NULL', c.wid)?.d as string | undefined;
  const lines = items.map((b) => {
    let leftover = 0;
    if (b.rollover !== 'none' && b.rollover !== 'reset') {
      for (const p of periods.slice(0, -1)) {
        if (firstTxn && p.end < firstTxn) continue;
        const key = p.start; if (!hist.find((h) => (h as any).key === key)) { const m: any = sumBy(spendRows(c, p.start, p.end), (r) => String(r.cid)); m.key = key; hist.push(m); }
        const s = (hist.find((h) => (h as any).key === key)!.get(String(b.category_id)) ?? 0);
        leftover = available(b.amount, s, leftover, b.rollover as Rollover).left;
      }
    }
    const s = spent.get(String(b.category_id)) ?? 0; const a = available(b.amount, s, leftover, b.rollover as Rollover);
    return { id: b.id, category_id: b.category_id, category: b.category, group: b.group_name, rollover: b.rollover, budgeted: b.amount, carry: a.carry, available: a.available, spent: s, left: a.left, pct: a.available > 0 ? s / a.available : s > 0 ? 2 : 0 };
  });
  const unbudgeted = [...spent.entries()].filter(([k]) => !items.some((b) => String(b.category_id) === k) && k !== 'null' || k === 'null').map(([k, v]) => ({ category_id: k === 'null' ? null : +k, spent: v }));
  const income = incomeTotal(c, per.start, per.end);
  return { period: per, lines, totals: { budgeted: lines.reduce((a, l) => a + l.budgeted, 0), spent: lines.reduce((a, l) => a + l.spent, 0), left: lines.reduce((a, l) => a + l.left, 0), income }, unbudgeted };
}

// ---------- Recurring / bills ----------
export function upcomingBills(c: Ctx, from: string, to: string) {
  const items = all('SELECT r.*, a.name account_name, a.currency, cat.name category FROM recurring_items r LEFT JOIN accounts a ON a.id=r.account_id LEFT JOIN categories cat ON cat.id=r.category_id WHERE r.workspace_id=? AND r.active=1', c.wid);
  const out: any[] = [];
  for (const r of items) for (const d of occurrences(r.next_due, r.cadence as Cadence, from, to, r.end_date)) {
    const paid = get('SELECT * FROM bill_payments WHERE recurring_id=? AND due_date=?', r.id, d);
    out.push({ recurring_id: r.id, name: r.name, kind: r.kind, amount: r.amount, due: d, paid: !!paid?.paid_date, paid_date: paid?.paid_date ?? null, account_id: r.account_id, account_name: r.account_name, category: r.category, is_bill: !!r.is_bill, cadence: r.cadence, overdue: !paid?.paid_date && diffDays(d, today()) < 0 });
  }
  return out.sort((a, b) => a.due.localeCompare(b.due));
}
/** Advance next_due past dates that have been paid or are older than `lookback` and unpaid (they stay visible as overdue for 31 days). */
export function markBillPaid(c: Ctx, recurringId: number, due: string, accountId?: number, paidDate = today(), amount?: number) {
  const r = get('SELECT * FROM recurring_items WHERE id=? AND workspace_id=?', recurringId, c.wid); if (!r) throw new ApiError(404, 'Bill not found');
  return tx(() => {
    if (get('SELECT 1 FROM bill_payments WHERE recurring_id=? AND due_date=? AND paid_date IS NOT NULL', recurringId, due)) throw new ApiError(409, 'Already marked as paid', 'conflict');
    const acct = accountId ?? r.account_id; let tid: number | null = null;
    if (acct) tid = insertTxn(c, { account_id: acct, posted_date: paidDate, amount: r.kind === 'income' ? Math.abs(amount ?? r.amount) : -Math.abs(amount ?? r.amount), description: r.name, merchant: r.name, category_id: r.category_id, recurring_id: r.id });
    run('INSERT INTO bill_payments(recurring_id,due_date,paid_date,transaction_id) VALUES(?,?,?,?) ON CONFLICT(recurring_id,due_date) DO UPDATE SET paid_date=excluded.paid_date, transaction_id=excluded.transaction_id', recurringId, due, paidDate, tid);
    return tid;
  });
}
/** Roll next_due forward past occurrences that are paid, so lists stay small. */
export function rollRecurring(c: Ctx) {
  for (const r of all('SELECT * FROM recurring_items WHERE workspace_id=? AND active=1', c.wid)) {
    let d = r.next_due as string; const anchor = parts(r.next_due).d; let moved = false;
    while (diffDays(d, today()) < -31 || get('SELECT 1 FROM bill_payments WHERE recurring_id=? AND due_date=? AND paid_date IS NOT NULL', r.id, d)) {
      const n = nextOccurrence(d, r.cadence, anchor); if (n === d) break; d = n; moved = true; if (diffDays(d, today()) > 400) break;
    }
    if (moved) run('UPDATE recurring_items SET next_due=? WHERE id=?', d, r.id);
  }
}

// ---------- Net worth ----------
export function netWorth(c: Ctx) {
  const accts = accountsWithBalance(c).filter((a) => !a.is_archived);
  let assets = 0, liabilities = 0;
  const lines: { name: string; kind: string; value: number; liability: boolean }[] = [];
  for (const a of accts) { const v = a.balance_base; if (isLiability(a.type)) { const l = Math.min(0, v); liabilities += -l; assets += Math.max(0, v); lines.push({ name: a.name, kind: a.type, value: v, liability: true }); } else { if (v >= 0) assets += v; else liabilities += -v; lines.push({ name: a.name, kind: a.type, value: v, liability: false }); } }
  for (const m of all('SELECT * FROM manual_assets WHERE workspace_id=?', c.wid)) { const v = toBase(c, m.value, m.currency); if (m.is_liability) { liabilities += v; lines.push({ name: m.name, kind: m.kind, value: -v, liability: true }); } else { assets += v; lines.push({ name: m.name, kind: m.kind, value: v, liability: false }); } }
  for (const h of all('SELECT * FROM holdings WHERE workspace_id=?', c.wid)) { const v = Math.round(h.quantity * h.price); assets += v; lines.push({ name: h.symbol, kind: h.asset_class, value: v, liability: false }); }
  return { assets, liabilities, net_worth: assets - liabilities, lines };
}
export function snapshotNetWorth(c: Ctx) {
  const n = netWorth(c); run('INSERT INTO net_worth_snapshots(workspace_id,date,assets,liabilities,net_worth) VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,date) DO UPDATE SET assets=excluded.assets,liabilities=excluded.liabilities,net_worth=excluded.net_worth', c.wid, today(), n.assets, n.liabilities, n.net_worth); return n;
}

// ---------- Debts ----------
export function debts(c: Ctx) {
  return accountsWithBalance(c).filter((a) => isLiability(a.type) && !a.is_archived && a.balance < 0).map((a) => {
    const info: any = { id: a.id, name: a.name, type: a.type, balance: -a.balance, currency: a.currency, aprPct: a.apr ?? 0, minPayment: a.min_payment ?? Math.max(2500, Math.round(-a.balance * 0.02)), due_day: a.payment_due_day, limit: a.credit_limit };
    if (a.type === 'credit_card' && a.credit_limit) info.utilization = -a.balance / a.credit_limit;
    if (a.type === 'credit_card' && a.statement_close_day && a.payment_due_day) {
      const cyc = statementCycle(today(), a.statement_close_day, a.payment_due_day);
      const stmt = get(`SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE account_id=? AND deleted_at IS NULL AND posted_date<=?`, a.id, cyc.lastClose)!.s + a.opening_balance;
      info.cycle = { ...cyc, statement_balance: Math.max(0, -stmt), utilization_at_statement: a.credit_limit ? Math.max(0, -stmt) / a.credit_limit : null };
    }
    if (a.type === 'loan' && a.loan_principal && a.loan_term_months && a.apr != null) {
      const pay = a.min_payment ?? monthlyPayment(a.loan_principal, a.apr, a.loan_term_months);
      info.minPayment = pay; info.amortization = schedule({ principal: -a.balance, aprPct: a.apr, payment: pay, startDate: today() });
    }
    return info;
  });
}

// ---------- Forecast & safe-to-spend ----------
export function cashflowForecast(c: Ctx, days = 90) {
  const spendable = accountsWithBalance(c).filter((a) => !a.is_archived && ['checking', 'cash', 'wallet'].includes(a.type));
  const balance = spendable.reduce((s, a) => s + a.balance_base, 0);
  const recs = all('SELECT * FROM recurring_items WHERE workspace_id=? AND active=1', c.wid);
  const recurringIds = new Set(recs.map((r) => r.id));
  const t0 = addDays(today(), -90);
  const rows = all(`SELECT base_amount,recurring_id,kind FROM transactions WHERE workspace_id=? AND deleted_at IS NULL AND kind='expense' AND posted_date BETWEEN ? AND ?`, c.wid, t0, today());
  const variable = rows.filter((r) => !r.recurring_id || !recurringIds.has(r.recurring_id)).reduce((s, r) => s + -r.base_amount, 0);
  const daily = Math.max(0, Math.round(variable / 90));
  const sched = recs.map((r) => ({ name: r.name, amount: r.kind === 'income' ? Math.abs(r.amount) : -Math.abs(r.amount), cadence: r.cadence as Cadence, nextDue: r.next_due, endDate: r.end_date }));
  return { ...forecast({ balance, today: today(), days, scheduled: sched, variableDailySpend: daily }), balance, daily_variable: daily };
}
export function safeToSpendNow(c: Ctx) {
  const t = today(); const per = budgetPeriod(t, c.startDay);
  const spendable = accountsWithBalance(c).filter((a) => !a.is_archived && (a.spending || ['checking', 'cash', 'wallet'].includes(a.type))).reduce((s, a) => s + a.balance_base, 0);
  const incomes = upcomingBills(c, t, addDays(t, 45)).filter((b) => b.kind === 'income' && !b.paid);
  const nextIncome = incomes[0]?.due ?? addDays(per.end, 1);
  const bills = upcomingBills(c, t, addDays(nextIncome, -1)).filter((b) => b.kind === 'expense' && !b.paid).reduce((s, b) => s + b.amount, 0);
  const sinking = all('SELECT * FROM sinking_funds WHERE workspace_id=?', c.wid).reduce((s, f) => s + monthlyRequired(f.target_amount, f.balance, Math.max(1, Math.round(diffDays(f.due_date, t) / 30.4))), 0);
  const bud = budgetSummary(c);
  const essentialIds = new Set(all('SELECT id FROM categories WHERE workspace_id=? AND essential=1', c.wid).map((r) => r.id));
  const recurringCats = new Set(all('SELECT category_id FROM recurring_items WHERE workspace_id=? AND active=1 AND category_id IS NOT NULL', c.wid).map((r) => r.category_id));
  const essentials = bud.lines.filter((l) => essentialIds.has(l.category_id) && !recurringCats.has(l.category_id)).reduce((s, l) => s + Math.max(0, l.left), 0);
  return { ...safeToSpend({ spendable, upcomingBills: bills, sinkingSetAside: sinking, essentialsRemaining: essentials }), next_income: nextIncome, until: nextIncome };
}

// ---------- Subscriptions ----------
export function txnsForAnalysis(c: Ctx, months = 12): Txn[] {
  return all(`SELECT t.id,t.posted_date date,t.base_amount amount,t.merchant,c.name category,t.kind,t.description FROM transactions t LEFT JOIN categories c ON c.id=t.category_id
    WHERE t.workspace_id=? AND t.deleted_at IS NULL AND t.posted_date>=? ORDER BY t.posted_date`, c.wid, addMonths(today(), -months)) as unknown as Txn[];
}
export const subscriptions = (c: Ctx) => detectSubscriptions(txnsForAnalysis(c));
/** Recurring charges that are essential living costs, not discretionary services you could switch or cancel. */
const FIXED_CATEGORIES = new Set(['Housing', 'Debt Payment', 'Utilities', 'Insurance', 'Savings', 'Groceries', 'Transport', 'Fees & Interest']);
/** Detected recurring charges tagged with their usual category and whether they are a discretionary subscription. */
export function subscriptionsClassified(c: Ctx) {
  const txns = txnsForAnalysis(c); const votes = new Map<string, Map<string, number>>();
  for (const t of txns) if (t.kind === 'expense' && t.merchant) { const m = votes.get(t.merchant) ?? votes.set(t.merchant, new Map()).get(t.merchant)!; const k = t.category ?? 'Uncategorized'; m.set(k, (m.get(k) ?? 0) + 1); }
  return detectSubscriptions(txns).map((s) => { const v = [...(votes.get(s.merchant) ?? [])].sort((a, b) => b[1] - a[1])[0]; const category = v?.[0] ?? 'Uncategorized'; return { ...s, category, discretionary: !FIXED_CATEGORIES.has(category) }; });
}

// ---------- Reports ----------
export function monthlySeries(c: Ctx, months = 6) {
  const out: { month: string; income: number; expense: number; net: number }[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = addMonths(today(), -i); const s = d.slice(0, 7) + '-01', e = d.slice(0, 7) + '-31';
    const inc = incomeTotal(c, s, e); const exp = spendRows(c, s, e).reduce((a, r) => a + r.spend, 0);
    out.push({ month: d.slice(0, 7), income: inc, expense: exp, net: inc - exp });
  }
  return out;
}
export function categoryReport(c: Ctx, start: string, end: string) {
  const rows = spendRows(c, start, end); const total = rows.reduce((a, r) => a + r.spend, 0);
  const by = [...sumBy(rows, (r) => r.cname ?? 'Uncategorized').entries()].map(([name, amount]) => ({ name, amount, pct: total ? amount / total : 0 })).filter((x) => x.amount !== 0).sort((a, b) => b.amount - a.amount);
  const merchants = [...sumBy(rows, (r) => r.merchant ?? 'Unknown').entries()].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount).slice(0, 10);
  return { total, categories: by, merchants };
}
export function categoryTrend(c: Ctx, months = 6) {
  const cats = new Set<string>(); const data: Record<string, any>[] = [];
  for (let i = months - 1; i >= 0; i--) { const d = addMonths(today(), -i); const m = sumBy(spendRows(c, d.slice(0, 7) + '-01', d.slice(0, 7) + '-31'), (r) => r.cname ?? 'Uncategorized'); const row: any = { month: d.slice(0, 7) }; for (const [k, v] of m) { row[k] = v; cats.add(k); } data.push(row); }
  return { months: data, categories: [...cats] };
}

// ---------- Health ----------
export function health(c: Ctx) {
  const t = today(); const s = addMonths(t, -3);
  const inc = incomeTotal(c, s, t), exp = spendRows(c, s, t).reduce((a, r) => a + r.spend, 0);
  const liquid = accountsWithBalance(c).filter((a) => ['checking', 'savings', 'cash'].includes(a.type) && !a.is_archived).reduce((x, a) => x + a.balance_base, 0);
  const monthlyExp = exp / 3;
  const dp = debts(c).reduce((a, d) => a + d.minPayment, 0);
  const b = budgetSummary(c); const ok = b.lines.filter((l) => l.pct <= 1).length;
  const paid = all(`SELECT paid_date,due_date FROM bill_payments bp JOIN recurring_items r ON r.id=bp.recurring_id WHERE r.workspace_id=? AND bp.paid_date IS NOT NULL`, c.wid);
  return healthScore({
    savingsRate: inc > 0 ? Math.max(0, (inc - exp) / inc) : null, emergencyMonths: monthlyExp > 0 ? Math.max(0, liquid) / monthlyExp : null,
    debtToIncome: inc > 0 ? dp / (inc / 3) : null, budgetAdherence: b.lines.length ? ok / b.lines.length : null,
    billsOnTime: paid.length ? paid.filter((p) => diffDays(p.paid_date, p.due_date) <= 0).length / paid.length : null,
  });
}
export function currentInsights(c: Ctx) {
  const now = today(); const tm = monthKey(now), lm = monthKey(addMonths(now, -1));
  return insights({ txns: txnsForAnalysis(c, 4), thisMonth: tm, lastMonth: lm, subs: subscriptions(c), fmt: (n) => formatMoney(n, c.base) });
}

// ---------- Dashboard ----------
export function dashboard(c: Ctx) {
  rollRecurring(c);
  const per = budgetPeriod(today(), c.startDay); const rows = spendRows(c, per.start, per.end);
  const spent = rows.reduce((a, r) => a + r.spend, 0); const income = incomeTotal(c, per.start, per.end);
  const nw = netWorth(c);
  const hist = all('SELECT date,net_worth FROM net_worth_snapshots WHERE workspace_id=? ORDER BY date DESC LIMIT 90', c.wid).reverse();
  return {
    base: c.base, period: per, income, spent, net: income - spent, net_worth: nw, nw_history: hist,
    categories: categoryReport(c, per.start, per.end), months: monthlySeries(c, 6), upcoming: upcomingBills(c, today(), addDays(today(), 14)).filter((b) => !b.paid).slice(0, 8),
    safe: safeToSpendNow(c), insights: currentInsights(c).slice(0, 5), health: health(c),
    uncategorized: (get(`SELECT COUNT(*) n FROM transactions WHERE workspace_id=? AND deleted_at IS NULL AND category_id IS NULL AND kind!='transfer'`, c.wid) as Row).n,
    accounts: accountsWithBalance(c).filter((a) => !a.is_archived).length,
  };
}

// ---------- Notifications (deduped, quiet-by-default policy) ----------
export function generateNotifications(c: Ctx) {
  const push = (type: string, title: string, body: string, key: string) => run('INSERT OR IGNORE INTO notifications(workspace_id,type,title,body,dedupe_key) VALUES(?,?,?,?,?)', c.wid, type, title, body, key);
  for (const b of upcomingBills(c, addDays(today(), -7), addDays(today(), 3)).filter((x) => !x.paid && x.kind === 'expense')) {
    const d = diffDays(b.due, today());
    push('bill', d < 0 ? `${b.name} is overdue` : d === 0 ? `${b.name} is due today` : `${b.name} due in ${d} day${d > 1 ? 's' : ''}`, formatMoney(b.amount, c.base), `bill:${b.recurring_id}:${b.due}:${d < 0 ? 'over' : 'soon'}`);
  }
  const per = budgetPeriod(today(), c.startDay);
  for (const l of budgetSummary(c).lines) { const lvl = l.pct >= 1 ? 100 : l.pct >= 0.8 ? 80 : 0; if (lvl) push('budget', `${l.category} budget at ${lvl}%`, `${formatMoney(l.spent, c.base)} of ${formatMoney(l.available, c.base)} used. ${l.left < 0 ? `Over by ${formatMoney(-l.left, c.base)}, consider moving funds from another category.` : ''}`, `budget:${l.category_id}:${per.start}:${lvl}`); }
  for (const d of debts(c)) if (d.cycle && d.cycle.daysToDue >= 0 && d.cycle.daysToDue <= 3 && d.cycle.statement_balance > 0) push('card', `Pay ${d.name} statement balance`, `${formatMoney(d.cycle.statement_balance, c.base)} due ${d.cycle.due}`, `card:${d.id}:${d.cycle.due}`);
}
