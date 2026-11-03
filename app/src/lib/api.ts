import { z, ZodError } from 'zod';
import { all, get, run, tx, Row } from './db';
import { ApiError, Ctx, audit, createUser, endSession, getCtx, passwordProblem, rateLimit, requireCtx, startSession, verifyPassword } from './auth';
import * as S from './service';
import { isDate, today, addDays, addMonths, diffDays } from './domain/dates';
import { applyMapping, dupKey, guessMapping, parseCSV, toCSV, Mapping } from './domain/csv';
import { payoffPlan } from './domain/debt';
import { monthlyRequired } from './domain/budget';
import { CADENCES } from './domain/recurrence';
import { CURRENCIES, decimals } from './domain/money';
import { seedDemo } from './seed';
import { isVpa } from './domain/upi';
import { containsCardNumber } from './domain/cards';
import { completeness, getProfile, profileSchema, saveProfile, EMPLOYMENT, INCOME_RANGES, RISK, GOALS } from './profile';
import { offersFor, setOfferStatus } from './offers';
import { answer, chatStatus, conversations } from './chat';
import { ServiceError } from './integrations/services';
import { cardSchema, cardTransactions, listCards } from './cards';
import { makeLink, ownIdSchema, parseAny, payeeSchema, recordPayment, upiSummary } from './upi';
import { handleInternal } from './internal';
import { listLinks, providers, startLink, syncLink, syncStaleLinks, unlink } from './connections';
import { CONSENT_TEXT, creditOverview, deleteReports, fetchReport, providerInfo } from './credit';
import { deleteSchedule, getSchedule, runDueGoalSchedules, saveSchedule, scheduleSchema } from './goalsched';
import { llmConfigured } from './chat/agent';
import { StatementKind, extractWithClaude, parseStatement } from './statements';
import { toNormalizedCSV } from './domain/statements';

type Handler = (c: Ctx, a: { params: string[]; query: URLSearchParams; body: any; req: Request }) => any | Promise<any>;
const routes: { method: string; re: RegExp; h: Handler; auth: boolean }[] = [];
const route = (method: string, path: string, h: Handler, auth = true) =>
  routes.push({ method, re: new RegExp('^' + path.replace(/:\w+/g, '([^/]+)') + '$'), h, auth });

const date = z.string().refine(isDate, 'Use YYYY-MM-DD');
const vpa = z.string().trim().refine(isVpa, 'Enter a valid UPI ID like name@bank');
const minor = z.number().int().safe();
const id = (s: string) => { const n = Number(s); if (!Number.isInteger(n)) throw new ApiError(404, 'Not found'); return n; };
const parse = <T extends z.ZodTypeAny>(s: T, v: unknown): z.infer<T> => s.parse(v);
const num = (q: URLSearchParams, k: string) => (q.has(k) && q.get(k) !== '' ? Number(q.get(k)) : undefined);
const owned = (c: Ctx, table: string, rid: number) => { const r = get(`SELECT * FROM ${table} WHERE id=? AND workspace_id=?`, rid, c.wid); if (!r) throw new ApiError(404, 'Not found'); return r; };
const notViewer = (c: Ctx) => { if (c.role === 'viewer') throw new ApiError(403, 'Read-only access', 'forbidden'); };

// ---------------- auth ----------------
route('POST', '/auth/register', async (_c, { body, req }) => {
  const b = parse(z.object({ email: z.string().email().max(200), name: z.string().trim().min(1).max(80), password: z.string().max(200) }), body);
  rateLimit('reg:' + (req.headers.get('x-forwarded-for') ?? 'local'), 10, 3600e3);
  const pw = passwordProblem(b.password); if (pw) throw new ApiError(400, pw, 'validation', { password: pw });
  const email = b.email.toLowerCase();
  if (get('SELECT 1 FROM users WHERE email=?', email)) throw new ApiError(409, 'An account with this email already exists', 'validation', { email: 'Already registered' });
  const { uid } = createUser(email, b.name, b.password); await startSession(uid); return { ok: true };
}, false);
route('POST', '/auth/login', async (_c, { body, req }) => {
  const b = parse(z.object({ email: z.string().email(), password: z.string() }), body); const email = b.email.toLowerCase();
  rateLimit('login:' + email, 8, 15 * 60e3); rateLimit('loginip:' + (req.headers.get('x-forwarded-for') ?? 'local'), 40, 15 * 60e3);
  const u = get('SELECT * FROM users WHERE email=?', email);
  if (u && u.locked_until > Date.now()) throw new ApiError(429, 'Account temporarily locked. Try again later.', 'locked');
  if (!u || !verifyPassword(b.password, u.pw_hash)) {
    if (u) run('UPDATE users SET failed_logins=failed_logins+1, locked_until=CASE WHEN failed_logins+1>=10 THEN ? ELSE 0 END WHERE id=?', Date.now() + 15 * 60e3, u.id);
    throw new ApiError(401, 'Incorrect email or password', 'invalid_credentials');
  }
  run('UPDATE users SET failed_logins=0 WHERE id=?', u.id); await startSession(u.id); return { ok: true };
}, false);
route('POST', '/auth/logout', async () => { await endSession(); return { ok: true }; }, false);
route('GET', '/me', async () => {
  const c = await getCtx(); if (!c) return { user: null };
  const w = get('SELECT * FROM workspaces WHERE id=?', c.wid)!;
  return { user: { email: c.email, name: c.name }, workspace: { id: w.id, name: w.name, base_currency: w.base_currency, month_start_day: w.month_start_day, privacy_mode: !!w.privacy_mode, onboarded: !!w.onboarded }, role: c.role, currencies: Object.keys(CURRENCIES) };
}, false);
route('PATCH', '/settings', (c, { body }) => {
  const b = parse(z.object({ name: z.string().min(1).max(80).optional(), base_currency: z.string().refine((x) => x in CURRENCIES).optional(), month_start_day: z.number().int().min(1).max(31).optional(), privacy_mode: z.boolean().optional(), onboarded: z.boolean().optional() }), body);
  if (b.base_currency && b.base_currency !== c.base) {
    tx(() => { run('UPDATE workspaces SET base_currency=? WHERE id=?', b.base_currency, c.wid); const nc = { ...c, base: b.base_currency! };
      for (const t of all('SELECT id,amount,currency FROM transactions WHERE workspace_id=?', c.wid)) { const r = S.rate(t.currency, nc.base); run('UPDATE transactions SET fx_rate=?, base_amount=? WHERE id=? AND fx_overridden=0', r, S.toBase(nc, t.amount, t.currency, r), t.id); } });
  }
  if (b.name) run('UPDATE workspaces SET name=? WHERE id=?', b.name, c.wid);
  if (b.month_start_day) run('UPDATE workspaces SET month_start_day=? WHERE id=?', b.month_start_day, c.wid);
  if (b.privacy_mode != null) run('UPDATE workspaces SET privacy_mode=? WHERE id=?', +b.privacy_mode, c.wid);
  if (b.onboarded != null) run('UPDATE workspaces SET onboarded=? WHERE id=?', +b.onboarded, c.wid);
  return { ok: true };
});
route('POST', '/me/delete', async (c, { body }) => {
  const b = parse(z.object({ password: z.string(), confirm: z.literal('DELETE') }), body);
  const u = get('SELECT * FROM users WHERE id=?', c.userId)!; if (!verifyPassword(b.password, u.pw_hash)) throw new ApiError(403, 'Password is incorrect', 'invalid_credentials', { password: 'Incorrect' });
  await conversations.removeAll(c);
  tx(() => { run('DELETE FROM workspaces WHERE owner_id=?', c.userId); run('DELETE FROM users WHERE id=?', c.userId); });
  await endSession(); return { ok: true };
});
route('POST', '/demo', (c) => { notViewer(c); if (get('SELECT 1 FROM accounts WHERE workspace_id=?', c.wid)) throw new ApiError(409, 'Demo data can only be loaded into an empty workspace', 'conflict'); seedDemo(c); return { ok: true }; });

// ---------------- accounts ----------------
const ACCT_TYPES = ['checking', 'savings', 'cash', 'credit_card', 'loan', 'wallet', 'investment'] as const;
const acctSchema = z.object({
  name: z.string().trim().min(1).max(60), type: z.enum(ACCT_TYPES), currency: z.string().refine((x) => x in CURRENCIES).optional(), opening_balance: minor.optional(), spending: z.boolean().optional(),
  color: z.string().max(20).nullish(), statement_close_day: z.number().int().min(1).max(31).nullish(), payment_due_day: z.number().int().min(1).max(31).nullish(), credit_limit: minor.nullish(),
  apr: z.number().min(0).max(100).nullish(), min_payment: minor.nullish(), loan_principal: minor.nullish(), loan_term_months: z.number().int().min(1).max(600).nullish(), loan_start: date.nullish(), is_archived: z.boolean().optional(), sort_order: z.number().int().optional(),
});
route('GET', '/accounts', (c) => S.accountsWithBalance(c));
route('POST', '/accounts', (c, { body }) => {
  notViewer(c); const b = parse(acctSchema, body);
  const r = run(`INSERT INTO accounts(workspace_id,name,type,currency,opening_balance,spending,color,statement_close_day,payment_due_day,credit_limit,apr,min_payment,loan_principal,loan_term_months,loan_start) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    c.wid, b.name, b.type, b.currency ?? c.base, b.opening_balance ?? 0, +(b.spending ?? ['checking', 'cash', 'wallet'].includes(b.type)), b.color ?? null, b.statement_close_day ?? null, b.payment_due_day ?? null, b.credit_limit ?? null, b.apr ?? null, b.min_payment ?? null, b.loan_principal ?? null, b.loan_term_months ?? null, b.loan_start ?? null);
  audit(c, 'account', Number(r.lastInsertRowid), 'create'); return { id: Number(r.lastInsertRowid) };
});
route('PATCH', '/accounts/:id', (c, { params, body }) => {
  notViewer(c); const aid = id(params[0]); S.account(c, aid); const b = parse(acctSchema.partial(), body);
  const sets: string[] = [], p: any[] = []; for (const [k, v] of Object.entries(b)) { sets.push(`${k}=?`); p.push(typeof v === 'boolean' ? +v : v ?? null); }
  if (sets.length) run(`UPDATE accounts SET ${sets.join(',')} WHERE id=?`, ...p, aid); return { ok: true };
});
route('DELETE', '/accounts/:id', (c, { params }) => { notViewer(c); const a = S.account(c, id(params[0])); audit(c, 'account', a.id, 'delete', { name: a.name }); run('DELETE FROM accounts WHERE id=?', a.id); return { ok: true }; });
route('POST', '/accounts/:id/reconcile', (c, { params, body }) => {
  const aid = id(params[0]); S.account(c, aid); const b = parse(z.object({ statement_balance: minor, up_to: date }), body);
  const cleared = get('SELECT a.opening_balance + COALESCE((SELECT SUM(amount) FROM transactions WHERE account_id=a.id AND deleted_at IS NULL AND posted_date<=?),0) bal FROM accounts a WHERE a.id=?', b.up_to, aid)!.bal as number;
  const diff = b.statement_balance - cleared;
  if (diff === 0) run('UPDATE transactions SET reconciled=1 WHERE account_id=? AND deleted_at IS NULL AND posted_date<=?', aid, b.up_to);
  return { difference: diff, reconciled: diff === 0, ledger_balance: cleared };
});

// ---------------- categories ----------------
route('GET', '/categories', (c) => all('SELECT * FROM categories WHERE workspace_id=? ORDER BY kind DESC, group_name, name', c.wid));
route('POST', '/categories', (c, { body }) => {
  const b = parse(z.object({ name: z.string().trim().min(1).max(40), kind: z.enum(['income', 'expense']).default('expense'), group_name: z.string().max(30).nullish(), essential: z.boolean().optional() }), body);
  if (S.catByName(c.wid, b.name)) throw new ApiError(409, 'Category already exists', 'validation', { name: 'Already exists' });
  return { id: Number(run('INSERT INTO categories(workspace_id,name,kind,group_name,essential) VALUES(?,?,?,?,?)', c.wid, b.name, b.kind, b.group_name ?? null, +(b.essential ?? false)).lastInsertRowid) };
});
route('PATCH', '/categories/:id', (c, { params, body }) => {
  const cid = id(params[0]); owned(c, 'categories', cid); const b = parse(z.object({ name: z.string().trim().min(1).max(40), group_name: z.string().max(30).nullish(), essential: z.boolean() }).partial(), body);
  if (b.name !== undefined) run('UPDATE categories SET name=? WHERE id=?', b.name, cid); if (b.group_name !== undefined) run('UPDATE categories SET group_name=? WHERE id=?', b.group_name, cid); if (b.essential !== undefined) run('UPDATE categories SET essential=? WHERE id=?', +b.essential, cid); return { ok: true };
});
route('DELETE', '/categories/:id', (c, { params }) => { const cid = id(params[0]); owned(c, 'categories', cid); run('DELETE FROM categories WHERE id=?', cid); return { ok: true }; });

// ---------------- transactions ----------------
const txBody = z.object({
  account_id: z.number().int(), posted_date: date, amount: minor.refine((x) => x !== 0, 'Amount cannot be zero'), description: z.string().max(300).optional(), merchant: z.string().max(100).nullish(), category_id: z.number().int().nullish(),
  notes: z.string().max(1000).nullish(), tags: z.array(z.string().max(30)).max(10).optional(), status: z.enum(['pending', 'posted']).optional(), fx_rate: z.number().positive().optional(), reimbursable: z.boolean().optional(), refund_of_id: z.number().int().nullish(),
  card_id: z.number().int().nullish(), payment_method: z.enum(['upi', 'card', 'cash', 'netbanking', 'other']).nullish(), upi_vpa: z.string().max(100).nullish(), upi_ref: z.string().max(40).nullish(),
});
route('GET', '/transactions', (c, { query }) => S.listTxns(c, {
  q: query.get('q') || undefined, account_id: num(query, 'account_id'), category_id: num(query, 'category_id'), kind: query.get('kind') || undefined, from: query.get('from') || undefined, to: query.get('to') || undefined,
  min: num(query, 'min'), max: num(query, 'max'), tag: query.get('tag') || undefined, merchant: query.get('merchant') || undefined, uncategorized: query.get('uncategorized') === '1', status: query.get('status') || undefined,
  deleted: query.get('deleted') === '1', limit: num(query, 'limit'), cursor: query.get('cursor') || undefined, sort: query.get('sort') || undefined,
}));
route('POST', '/transactions', (c, { body }) => {
  notViewer(c); const b = parse(txBody, body);
  const dup = get(`SELECT id FROM transactions WHERE account_id=? AND amount=? AND deleted_at IS NULL AND ABS(julianday(posted_date)-julianday(?))<=1 AND LOWER(description)=LOWER(?)`, b.account_id, b.amount, b.posted_date, b.description ?? '');
  const tid = S.insertTxn(c, { ...b, kind: b.amount > 0 ? 'income' : 'expense' }); audit(c, 'transaction', tid, 'create');
  return { id: tid, possible_duplicate_of: dup?.id ?? null };
});
route('POST', '/transactions/transfer', (c, { body }) => {
  notViewer(c); const b = parse(z.object({ from_account: z.number().int(), to_account: z.number().int(), amount: minor, date, notes: z.string().max(500).nullish() }), body);
  return { id: S.insertTransfer(c, b.from_account, b.to_account, b.amount, b.date, b.notes) };
});
route('POST', '/transactions/bulk', (c, { body }) => {
  notViewer(c); const b = parse(z.object({ ids: z.array(z.number().int()).min(1).max(500), action: z.enum(['categorize', 'tag', 'delete', 'reconcile']), category_id: z.number().int().nullish(), tag: z.string().max(30).optional() }), body);
  tx(() => { for (const tid of b.ids) {
    if (b.action === 'delete') S.deleteTxn(c, tid); else if (b.action === 'categorize') S.updateTxn(c, tid, { category_id: b.category_id ?? null });
    else if (b.action === 'reconcile') S.updateTxn(c, tid, { reconciled: true });
    else if (b.action === 'tag' && b.tag) { const t = S.getTxn(c, tid); const tags = new Set<string>(JSON.parse(t.tags || '[]')); tags.add(b.tag); S.updateTxn(c, tid, { tags: [...tags] }); } } });
  return { ok: true, count: b.ids.length };
});
route('GET', '/transactions/:id', (c, { params }) => { const t = S.getTxn(c, id(params[0])); return { ...t, tags: JSON.parse(t.tags || '[]'), splits: all('SELECT * FROM transaction_splits WHERE transaction_id=?', t.id) }; });
route('PATCH', '/transactions/:id', (c, { params, body }) => {
  notViewer(c);
  const b = parse(z.object({ account_id: z.number().int(), posted_date: date, amount: minor, description: z.string().max(300), merchant: z.string().max(100).nullable(), category_id: z.number().int().nullable(), notes: z.string().max(1000).nullable(), tags: z.array(z.string().max(30)).max(10),
    status: z.enum(['pending', 'posted']), reimbursable: z.boolean(), reimbursed_amount: minor, reconciled: z.boolean(), fx_rate: z.number().positive(), refund_of_id: z.number().int().nullable(), card_id: z.number().int().nullable(), payment_method: z.enum(['upi', 'card', 'cash', 'netbanking', 'other']).nullable(), upi_vpa: z.string().max(100).nullable(), upi_ref: z.string().max(40).nullable() }).partial(), body);
  S.updateTxn(c, id(params[0]), b); return { ok: true };
});
route('DELETE', '/transactions/:id', (c, { params }) => { notViewer(c); S.deleteTxn(c, id(params[0])); return { ok: true }; });
route('POST', '/transactions/:id/restore', (c, { params }) => { S.deleteTxn(c, id(params[0]), true); return { ok: true }; });
route('PUT', '/transactions/:id/splits', (c, { params, body }) => { S.setSplits(c, id(params[0]), parse(z.object({ splits: z.array(z.object({ category_id: z.number().int().nullable(), amount: minor, notes: z.string().max(200).optional() })).max(20) }), body).splits); return { ok: true }; });
route('GET', '/transactions/:id/links', (c, { params }) => {
  // suggestions: transfer counterpart or original purchase for a refund
  const t = S.getTxn(c, id(params[0]));
  if (t.kind === 'transfer' || t.transfer_pair_id) return { transfer: [], refund: [] };
  const transfer = all(`SELECT id,posted_date,amount,description,account_id FROM transactions WHERE workspace_id=? AND deleted_at IS NULL AND account_id!=? AND amount=? AND transfer_pair_id IS NULL AND ABS(julianday(posted_date)-julianday(?))<=3 LIMIT 5`, c.wid, t.account_id, -t.amount, t.posted_date);
  const refund = t.amount > 0 ? all(`SELECT id,posted_date,amount,description FROM transactions WHERE workspace_id=? AND deleted_at IS NULL AND merchant=? AND amount<0 AND -amount>=? AND posted_date<=? AND posted_date>=? LIMIT 5`, c.wid, t.merchant, t.amount, t.posted_date, addDays(t.posted_date, -90)) : [];
  return { transfer, refund };
});
route('POST', '/transactions/:id/link-transfer', (c, { params, body }) => {
  const a = S.getTxn(c, id(params[0])); const b = S.getTxn(c, parse(z.object({ other_id: z.number().int() }), body).other_id);
  if (a.amount !== -b.amount || a.account_id === b.account_id) throw new ApiError(400, 'Amounts must be opposite and in different accounts', 'validation');
  tx(() => { run("UPDATE transactions SET kind='transfer', category_id=NULL, transfer_pair_id=? WHERE id=?", b.id, a.id); run("UPDATE transactions SET kind='transfer', category_id=NULL, transfer_pair_id=? WHERE id=?", a.id, b.id); }); return { ok: true };
});

// ---------------- import / export ----------------
function importPlan(c: Ctx, b: { csv: string; account_id: number; mapping?: Mapping; has_header?: boolean }) {
  const acct = S.account(c, b.account_id); const rows = parseCSV(b.csv);
  if (rows.length < 2) throw new ApiError(400, 'The file has no data rows', 'validation', { csv: 'Empty file' });
  if (rows.length > 20000) throw new ApiError(400, 'File too large (max 20,000 rows)', 'validation');
  const header = rows[0]; const sig = header.map((h) => h.toLowerCase().trim()).join('|');
  const saved = get('SELECT mapping_json FROM import_mappings WHERE workspace_id=? AND header_sig=?', c.wid, sig);
  const mapping: Mapping | null = b.mapping ?? (saved ? JSON.parse(saved.mapping_json) : guessMapping(header));
  if (!mapping) return { header, rows: rows.slice(1, 6), mapping: null, parsed: [], errors: [], needs_mapping: true, sig, acct };
  const { rows: parsed, errors } = applyMapping(rows, mapping, acct.currency, b.has_header ?? true);
  const existing = all('SELECT posted_date,amount,description FROM transactions WHERE account_id=? AND deleted_at IS NULL AND posted_date BETWEEN ? AND ?', acct.id, addDays(parsed.reduce((m, r) => (r.date < m ? r.date : m), '9999-12-31'), -1), addDays(parsed.reduce((m, r) => (r.date > m ? r.date : m), '0000-01-01'), 1));
  const keys = new Set(existing.flatMap((e) => [-1, 0, 1].map((o) => dupKey(acct.id, addDays(e.posted_date, o), e.amount, e.description))));
  const seen = new Set<string>();
  const out = parsed.map((r) => { const k = dupKey(acct.id, r.date, r.amount, r.description); const inFile = seen.has(k); seen.add(k); return { ...r, duplicate: keys.has(k), repeated_in_file: inFile }; });
  return { header, rows: rows.slice(1, 6), mapping, parsed: out, errors, needs_mapping: false, sig, acct };
}
route('POST', '/import/preview', (c, { body }) => {
  const b = parse(z.object({ csv: z.string().max(8e6), account_id: z.number().int(), mapping: z.any().optional(), has_header: z.boolean().optional() }), body);
  const p = importPlan(c, b); return { header: p.header, sample: p.rows, mapping: p.mapping, needs_mapping: p.needs_mapping, rows: p.parsed.slice(0, 200), total: p.parsed.length, duplicates: p.parsed.filter((r) => r.duplicate).length, errors: p.errors.slice(0, 50), error_count: p.errors.length };
});
route('POST', '/import/statement', async (c, { body }) => {
  notViewer(c); rateLimit('stmt:' + c.userId, 20, 60e3);
  const b = parse(z.object({ filename: z.string().max(200), kind: z.enum(['pdf', 'ofx', 'qif']), data: z.string().min(1).max(16e6), account_id: z.number().int(), password: z.string().max(200).optional(), use_ai: z.boolean().optional() }), body);
  const acct = S.account(c, b.account_id); if (decimals(acct.currency) !== 2) throw new ApiError(400, 'Statement import supports two-decimal currencies; use CSV for this account', 'validation');
  const aiOk = llmConfigured() && getProfile(c.userId).ai_assistant;
  if (b.use_ai && !aiOk) throw new ApiError(403, 'Turn on the AI assistant in your profile (and set the server key) to use AI extraction', 'forbidden');
  const parsed = await parseStatement(b.kind as StatementKind, b.data, { password: b.password });
  let r = parsed.result, parser = r.format === 'pdf' ? 'pdf-text' : r.format; let aiError: string | undefined;
  if (b.use_ai && b.kind === 'pdf' && parsed.lines) {
    try { r = await extractWithClaude(parsed.lines, parsed.result); parser = 'ai'; } catch (e) { aiError = e instanceof ApiError ? e.message : 'The AI model was unavailable'; console.error('[statement-ai]', (e as Error).message); }
  }
  if (!r.rows.length) throw new ApiError(422, r.warnings[0] ?? 'No transactions found in this file', 'no_rows');
  audit(c, 'import_statement', null, 'parse', { kind: b.kind, parser, rows: r.rows.length, reconciled: r.reconciled });
  return {
    kind: b.kind, parser, pages: parsed.pages ?? null, confidence: r.confidence, reconciled: r.reconciled, difference: r.difference, opening: r.opening, closing: r.closing, period: r.period, credit_card: r.creditCard,
    warnings: [...r.warnings, ...(aiError ? [`AI extraction failed (${aiError}); showing the standard parse.`] : [])], row_count: r.rows.length,
    total_in: r.rows.filter((x) => x.amount > 0).reduce((a, x) => a + x.amount, 0), total_out: r.rows.filter((x) => x.amount < 0).reduce((a, x) => a + x.amount, 0),
    ai_available: aiOk && b.kind === 'pdf', csv: toNormalizedCSV(r.rows),
  };
});
route('POST', '/import/commit', (c, { body }) => {
  notViewer(c);
  const b = parse(z.object({ csv: z.string().max(8e6), account_id: z.number().int(), mapping: z.any(), has_header: z.boolean().optional(), skip_duplicates: z.boolean().default(true), save_mapping: z.boolean().default(true), source: z.string().max(40).optional() }), body);
  const p = importPlan(c, b); if (p.needs_mapping) throw new ApiError(400, 'Map the columns first', 'validation');
  return tx(() => {
    const todo = p.parsed.filter((r) => !(b.skip_duplicates && (r.duplicate || r.repeated_in_file && false)));
    const batch = Number(run('INSERT INTO import_batches(workspace_id,account_id,source,row_count,skipped) VALUES(?,?,?,?,?)', c.wid, b.account_id, b.source ?? 'csv', todo.length, p.parsed.length - todo.length).lastInsertRowid);
    const rules = S.loadRules(c.wid), mem = S.loadMemory(c.wid); let cat = 0;
    for (const r of todo) { const t = S.insertTxn(c, { account_id: b.account_id, posted_date: r.date, amount: r.amount, description: r.description, import_batch_id: batch }, rules, mem); if (get('SELECT category_id FROM transactions WHERE id=?', t)?.category_id) cat++; }
    if (b.save_mapping) { run('DELETE FROM import_mappings WHERE workspace_id=? AND header_sig=?', c.wid, p.sig); run('INSERT INTO import_mappings(workspace_id,name,header_sig,mapping_json) VALUES(?,?,?,?)', c.wid, b.source ?? 'csv', p.sig, JSON.stringify(p.mapping)); }
    audit(c, 'import', batch, 'create', { rows: todo.length }); return { batch, imported: todo.length, skipped_duplicates: p.parsed.length - todo.length, errors: p.errors.length, auto_categorized: cat };
  });
});
route('POST', '/import/:id/undo', (c, { params }) => { const bid = id(params[0]); owned(c, 'import_batches', bid); run("UPDATE transactions SET deleted_at=datetime('now') WHERE import_batch_id=? AND workspace_id=? AND deleted_at IS NULL", bid, c.wid); return { ok: true }; });
route('GET', '/import/batches', (c) => all('SELECT * FROM import_batches WHERE workspace_id=? ORDER BY id DESC LIMIT 20', c.wid));
route('GET', '/export/csv', (c) => {
  const rows = S.listTxns(c, { limit: 500000 }).items;
  return { __raw: toCSV([['Date', 'Account', 'Description', 'Merchant', 'Category', 'Amount', 'Currency', 'Kind', 'Status', 'Tags', 'Notes'], ...rows.map((t: Row) => [t.posted_date, t.account_name, t.description, t.merchant, t.category, (t.amount / 100).toFixed(2), t.currency, t.kind, t.status, t.tags.join(';'), t.notes])]), type: 'text/csv', name: 'ledgerly-transactions.csv' };
});
route('GET', '/export/json', (c) => {
  const t = (n: string) => all(`SELECT * FROM ${n} WHERE workspace_id=?`, c.wid);
  return { __raw: JSON.stringify({ exported_at: new Date().toISOString(), workspace: get('SELECT * FROM workspaces WHERE id=?', c.wid), accounts: t('accounts'), categories: t('categories'), profile: getProfile(c.userId), transactions: t('transactions'), budgets: t('budgets'), goals: t('goals'), recurring_items: t('recurring_items'), rules: t('rules'), sinking_funds: t('sinking_funds'), manual_assets: t('manual_assets') }, null, 2), type: 'application/json', name: 'ledgerly-export.json' };
});

// ---------------- rules ----------------
route('GET', '/rules', (c) => S.loadRules(c.wid));
route('POST', '/rules', (c, { body }) => {
  const b = parse(z.object({ priority: z.number().int().default(100), conditions: z.array(z.object({ field: z.enum(['description', 'merchant', 'amount', 'account']), op: z.enum(['contains', 'equals', 'startsWith', 'regex', 'gt', 'lt']), value: z.union([z.string().max(200), z.number()]) })).min(1).max(5), actions: z.object({ category: z.string().max(40).optional(), merchant: z.string().max(100).optional(), tag: z.string().max(30).optional() }) }), body);
  for (const cd of b.conditions) if (cd.op === 'regex') { try { new RegExp(String(cd.value)); } catch { throw new ApiError(400, 'Invalid regular expression', 'validation'); } if (String(cd.value).length > 100) throw new ApiError(400, 'Pattern too long', 'validation'); }
  if (b.actions.category) S.ensureCategory(c.wid, b.actions.category);
  return { id: Number(run('INSERT INTO rules(workspace_id,priority,conditions_json,actions_json) VALUES(?,?,?,?)', c.wid, b.priority, JSON.stringify(b.conditions), JSON.stringify(b.actions)).lastInsertRowid) };
});
route('DELETE', '/rules/:id', (c, { params }) => { const rid = id(params[0]); owned(c, 'rules', rid); run('DELETE FROM rules WHERE id=?', rid); return { ok: true }; });
route('POST', '/rules/apply', (c) => {
  // re-run categorization on uncategorized, non-transfer transactions
  const rules = S.loadRules(c.wid), mem = S.loadMemory(c.wid); let n = 0;
  tx(() => { for (const t of all(`SELECT * FROM transactions WHERE workspace_id=? AND deleted_at IS NULL AND category_id IS NULL AND kind!='transfer' AND NOT EXISTS(SELECT 1 FROM transaction_splits s WHERE s.transaction_id=transactions.id)`, c.wid)) {
    const r = categorize2(t, rules, mem); if (r) { run('UPDATE transactions SET category_id=?, auto_categorized=1, merchant=COALESCE(merchant,?) WHERE id=?', S.ensureCategory(c.wid, r.category, t.kind === 'income' ? 'income' : 'expense'), r.merchant, t.id); n++; } } });
  return { categorized: n };
});
import { categorize, AUTO_APPLY_THRESHOLD } from './domain/categorize';
function categorize2(t: Row, rules: any, mem: any) { const r = categorize({ description: t.description, merchant: t.merchant, amount: t.amount, accountId: t.account_id }, rules, mem); return r.category && (r.source === 'rule' || r.confidence >= AUTO_APPLY_THRESHOLD) ? { category: r.category, merchant: r.merchant } : null; }

// ---------------- budgets ----------------
route('GET', '/budgets', (c, { query }) => S.budgetSummary(c, query.get('period') || undefined));
route('PUT', '/budgets', (c, { body }) => {
  const b = parse(z.object({ category_id: z.number().int(), amount: minor.min(0), rollover: z.enum(['none', 'surplus', 'both', 'reset']).default('none') }), body); owned(c, 'categories', b.category_id);
  run('INSERT INTO budgets(workspace_id,category_id,amount,rollover) VALUES(?,?,?,?) ON CONFLICT(workspace_id,category_id) DO UPDATE SET amount=excluded.amount, rollover=excluded.rollover', c.wid, b.category_id, b.amount, b.rollover); return { ok: true };
});
route('DELETE', '/budgets/:id', (c, { params }) => { run('DELETE FROM budgets WHERE id=? AND workspace_id=?', id(params[0]), c.wid); return { ok: true }; });
route('POST', '/budgets/template', (c, { body }) => {
  const b = parse(z.object({ template: z.enum(['50/30/20', 'average']), income: minor.optional() }), body);
  tx(() => {
    if (b.template === '50/30/20') {
      const income = b.income ?? 0; if (income <= 0) throw new ApiError(400, 'Enter your monthly income', 'validation', { income: 'Required' });
      const groups: Record<string, number> = { Needs: 0.5, Wants: 0.3, Savings: 0.2 };
      for (const [g, share] of Object.entries(groups)) { const cats = all("SELECT * FROM categories WHERE workspace_id=? AND group_name=? AND kind='expense'", c.wid, g); const each = Math.round((income * share) / cats.length);
        for (const k of cats) run('INSERT INTO budgets(workspace_id,category_id,amount,rollover) VALUES(?,?,?,?) ON CONFLICT(workspace_id,category_id) DO UPDATE SET amount=excluded.amount', c.wid, k.id, each, g === 'Savings' ? 'both' : 'none'); }
    } else {
      const rep = S.categoryReport(c, addMonths(today(), -3), today());
      for (const k of rep.categories) { const cat = S.catByName(c.wid, k.name); if (cat) run('INSERT INTO budgets(workspace_id,category_id,amount,rollover) VALUES(?,?,?,?) ON CONFLICT(workspace_id,category_id) DO UPDATE SET amount=excluded.amount', c.wid, cat.id, Math.round(k.amount / 3 / 500) * 500, 'none'); }
    }
  }); return { ok: true };
});

// ---------------- simple CRUD tables ----------------
function crud(name: string, table: string, schema: z.ZodObject<any>, extra?: (r: Row) => Row, order = 'id') {
  route('GET', `/${name}`, (c) => all(`SELECT * FROM ${table} WHERE workspace_id=? ORDER BY ${order}`, c.wid).map((r) => (extra ? extra(r) : r)));
  route('POST', `/${name}`, (c, { body }) => { notViewer(c); const b = parse(schema, body); const k = Object.keys(b);
    return { id: Number(run(`INSERT INTO ${table}(workspace_id,${k.join(',')}) VALUES(?,${k.map(() => '?').join(',')})`, c.wid, ...k.map((x) => (typeof b[x] === 'boolean' ? +b[x] : b[x] ?? null))).lastInsertRowid) }; });
  route('PATCH', `/${name}/:id`, (c, { params, body }) => { notViewer(c); const rid = id(params[0]); owned(c, table, rid); const b = parse(schema.partial(), body); const k = Object.keys(b);
    if (k.length) run(`UPDATE ${table} SET ${k.map((x) => x + '=?').join(',')} WHERE id=?`, ...k.map((x) => (typeof b[x] === 'boolean' ? +b[x] : b[x] ?? null)), rid); return { ok: true }; });
  route('DELETE', `/${name}/:id`, (c, { params }) => { notViewer(c); const rid = id(params[0]); owned(c, table, rid); run(`DELETE FROM ${table} WHERE id=?`, rid); return { ok: true }; });
}
crud('sinking-funds', 'sinking_funds', z.object({ name: z.string().trim().min(1).max(60), category_id: z.number().int().nullish(), target_amount: minor.positive(), due_date: date, balance: minor.min(0).optional() }),
  (r) => ({ ...r, monthly_required: monthlyRequired(r.target_amount, r.balance, Math.max(1, Math.round(diffDays(r.due_date, today()) / 30.4))) }), 'due_date');
crud('assets', 'manual_assets', z.object({ name: z.string().trim().min(1).max(60), kind: z.string().max(30), value: minor.min(0), currency: z.string().refine((x) => x in CURRENCIES).default('USD'), is_liability: z.boolean().default(false) }));
crud('holdings', 'holdings', z.object({ symbol: z.string().trim().min(1).max(12).toUpperCase(), asset_class: z.enum(['stock', 'fund', 'crypto', 'gold', 'deposit', 'other']).default('stock'), quantity: z.number().positive(), cost_basis: minor.min(0), price: minor.min(0) }),
  (r) => ({ ...r, value: Math.round(r.quantity * r.price), gain: Math.round(r.quantity * r.price) - r.cost_basis }));
crud('recurring', 'recurring_items', z.object({ name: z.string().trim().min(1).max(80), kind: z.enum(['income', 'expense']).default('expense'), amount: minor.positive(), account_id: z.number().int().nullish(), category_id: z.number().int().nullish(), cadence: z.enum(CADENCES as [string, ...string[]]), next_due: date, end_date: date.nullish(), is_bill: z.boolean().default(true), active: z.boolean().default(true) }), undefined, 'next_due');

// ---------------- cards ----------------
route('GET', '/cards', (c) => listCards(c));
route('POST', '/cards', (c, { body }) => {
  notViewer(c); const b = parse(cardSchema, body); if (b.account_id) owned(c, 'accounts', b.account_id);
  const k = Object.keys(b) as (keyof typeof b)[]; const r = run(`INSERT INTO cards(workspace_id,${k.join(',')}) VALUES(?,${k.map(() => '?').join(',')})`, c.wid, ...k.map((x) => b[x] ?? null)); audit(c, 'card', Number(r.lastInsertRowid), 'create'); return { id: Number(r.lastInsertRowid) };
});
route('PATCH', '/cards/:id', (c, { params, body }) => {
  notViewer(c); const cid = id(params[0]); owned(c, 'cards', cid);
  const b = parse(z.object({ nickname: z.string().trim().min(1).max(40), kind: z.enum(['debit', 'credit', 'prepaid', 'forex']), network: z.enum(['visa', 'mastercard', 'rupay', 'amex', 'diners', 'other']), issuer: z.string().max(60).nullable(), last4: z.string().regex(/^\d{4}$/), expiry_month: z.number().int().min(1).max(12).nullable(), expiry_year: z.number().int().min(2000).max(2100).nullable(), account_id: z.number().int().nullable(), credit_limit: minor.nullable(), statement_day: z.number().int().min(1).max(31).nullable(), due_day: z.number().int().min(1).max(31).nullable(), annual_fee: minor.nullable(), fee_waiver_spend: minor.nullable(), rewards: z.string().max(120).nullable(), daily_limit: minor.nullable(), status: z.enum(['active', 'blocked', 'expired']), color: z.string().max(20).nullable() }).partial(), body);
  for (const k of ['nickname', 'issuer', 'rewards'] as const) if (typeof b[k] === 'string' && containsCardNumber(b[k]!)) throw new ApiError(400, 'Do not enter a full card number. Ledgerly only needs the last 4 digits.', 'validation', { [k]: 'Looks like a card number' });
  if (b.account_id) owned(c, 'accounts', b.account_id);
  const ks = Object.keys(b); if (ks.length) run(`UPDATE cards SET ${ks.map((x) => x + '=?').join(',')} WHERE id=?`, ...ks.map((x) => (b as any)[x]), cid); return { ok: true };
});
route('DELETE', '/cards/:id', (c, { params }) => { notViewer(c); const cid = id(params[0]); owned(c, 'cards', cid); run('DELETE FROM cards WHERE id=?', cid); return { ok: true }; });
route('GET', '/cards/:id/transactions', (c, { params }) => { const cid = id(params[0]); owned(c, 'cards', cid); return cardTransactions(c, cid); });

// ---------------- UPI ----------------
route('GET', '/upi/summary', (c) => upiSummary(c));
route('GET', '/upi/payees', (c) => all('SELECT p.*, cat.name category, r.name bill_name FROM upi_payees p LEFT JOIN categories cat ON cat.id=p.category_id LEFT JOIN recurring_items r ON r.id=p.recurring_id WHERE p.workspace_id=? ORDER BY p.name', c.wid));
route('POST', '/upi/payees', (c, { body }) => {
  notViewer(c); const b = parse(payeeSchema, body); if (get('SELECT 1 FROM upi_payees WHERE workspace_id=? AND vpa=? COLLATE NOCASE', c.wid, b.vpa)) throw new ApiError(409, 'This UPI ID is already saved', 'duplicate', { vpa: 'Already saved' });
  return { id: Number(run('INSERT INTO upi_payees(workspace_id,name,vpa,category_id,recurring_id,note) VALUES(?,?,?,?,?,?)', c.wid, b.name, b.vpa, b.category_id ?? null, b.recurring_id ?? null, b.note ?? null).lastInsertRowid) };
});
route('PATCH', '/upi/payees/:id', (c, { params, body }) => { notViewer(c); const pid = id(params[0]); owned(c, 'upi_payees', pid); const b = parse(payeeSchema.partial(), body); for (const [k, v] of Object.entries(b)) run(`UPDATE upi_payees SET ${k}=? WHERE id=?`, v ?? null, pid); return { ok: true }; });
route('DELETE', '/upi/payees/:id', (c, { params }) => { notViewer(c); const pid = id(params[0]); owned(c, 'upi_payees', pid); run('DELETE FROM upi_payees WHERE id=?', pid); return { ok: true }; });
route('GET', '/upi/ids', (c) => all('SELECT u.*, a.name account_name FROM upi_ids u LEFT JOIN accounts a ON a.id=u.account_id WHERE u.workspace_id=? ORDER BY u.id', c.wid));
route('POST', '/upi/ids', (c, { body }) => { notViewer(c); const b = parse(ownIdSchema, body); if (b.account_id) owned(c, 'accounts', b.account_id); try { return { id: Number(run('INSERT INTO upi_ids(workspace_id,vpa,account_id,app) VALUES(?,?,?,?)', c.wid, b.vpa, b.account_id ?? null, b.app ?? null).lastInsertRowid) }; } catch { throw new ApiError(409, 'This UPI ID is already saved', 'duplicate', { vpa: 'Already saved' }); } });
route('DELETE', '/upi/ids/:id', (c, { params }) => { notViewer(c); const uid = id(params[0]); owned(c, 'upi_ids', uid); run('DELETE FROM upi_ids WHERE id=?', uid); return { ok: true }; });
route('POST', '/upi/link', (c, { body }) => makeLink(c, parse(z.object({ payee_id: z.number().int().optional(), vpa: z.string().max(100).optional(), name: z.string().max(60).optional(), amount: z.number().positive().optional(), note: z.string().max(50).optional() }), body)));
route('POST', '/upi/parse', (c, { body }) => parseAny(parse(z.object({ text: z.string().min(1).max(500) }), body).text));
route('POST', '/upi/payments', (c, { body }) => {
  notViewer(c); const b = parse(z.object({ account_id: z.number().int(), vpa, name: z.string().max(60).nullish(), amount: minor.positive(), date, ref: z.string().max(12).nullish(), note: z.string().max(50).nullish(), payee_id: z.number().int().nullish(), bill: z.object({ recurring_id: z.number().int(), due: date }).nullish() }), body);
  return { id: recordPayment(c, b) };
});

// ---------------- bank links (Account Aggregator) ----------------
route('GET', '/connections/providers', (c) => providers(c));
route('GET', '/connections', async (c) => ({ items: await listLinks(c) }));
route('POST', '/connections', async (c, { body }) => { notViewer(c); rateLimit('link:' + c.userId, 10, 3600e3); return startLink(c, parse(z.object({ mobile: z.string().regex(/^[6-9]\d{9}$/, 'Enter a 10-digit Indian mobile number'), aa_handle: z.string().max(30), months: z.number().int().min(1).max(24).optional() }), body)); });
route('POST', '/connections/:id/sync', async (c, { params }) => { notViewer(c); rateLimit('sync:' + c.userId, 20, 3600e3); return syncLink(c, id(params[0])); });
route('DELETE', '/connections/:id', async (c, { params }) => { notViewer(c); await unlink(c, id(params[0])); return { ok: true }; });

// ---------------- credit report (bureau) ----------------
route('GET', '/credit', async (c) => ({ ...creditOverview(c), provider: await providerInfo(c) }));
route('POST', '/credit/fetch', async (c, { body }) => {
  notViewer(c); rateLimit('credit:' + c.userId, 5, 3600e3);
  const b = parse(z.object({ name: z.string().trim().min(2).max(80), dob: date, pan: z.string().trim().toUpperCase().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Enter a valid PAN'), mobile: z.string().regex(/^[6-9]\d{9}$/, 'Enter a 10-digit mobile number'), consent: z.boolean() }), body);
  return { id: await fetchReport(c, b) };
});
route('DELETE', '/credit', (c) => { notViewer(c); deleteReports(c); return { ok: true }; });

// ---------------- goals ----------------
route('GET', '/goals', (c) => { runDueGoalSchedules(c); return all('SELECT * FROM goals WHERE workspace_id=? ORDER BY status, id', c.wid).map((g) => {
  const cur = g.linked_account_id ? (S.accountsWithBalance(c).find((a) => a.id === g.linked_account_id)?.balance ?? g.current_amount) : g.current_amount;
  const months = g.target_date ? Math.max(0, Math.round(diffDays(g.target_date, today()) / 30.4)) : null;
  return { ...g, current_amount: cur, pct: g.target_amount ? Math.min(1, cur / g.target_amount) : 0, months_left: months, monthly_required: months != null ? monthlyRequired(g.target_amount, cur, months) : null, contributions: all('SELECT * FROM goal_contributions WHERE goal_id=? ORDER BY date DESC LIMIT 10', g.id), schedule: getSchedule(c, g.id) };
}); });
route('PUT', '/goals/:id/schedule', (c, { params, body }) => { notViewer(c); const r = saveSchedule(c, id(params[0]), parse(scheduleSchema, body)); runDueGoalSchedules(c); return r; });
route('DELETE', '/goals/:id/schedule', (c, { params }) => { notViewer(c); deleteSchedule(c, id(params[0])); return { ok: true }; });
route('POST', '/goals/run-due', (c) => { notViewer(c); return runDueGoalSchedules(c); });
const goalSchema = z.object({ name: z.string().trim().min(1).max(60), type: z.enum(['emergency', 'vacation', 'down_payment', 'retirement', 'custom']).default('custom'), target_amount: minor.positive(), target_date: date.nullish(), linked_account_id: z.number().int().nullish(), current_amount: minor.min(0).optional(), status: z.enum(['active', 'done']).optional() });
route('POST', '/goals', (c, { body }) => { const b = parse(goalSchema, body); return { id: Number(run('INSERT INTO goals(workspace_id,name,type,target_amount,target_date,linked_account_id,current_amount) VALUES(?,?,?,?,?,?,?)', c.wid, b.name, b.type, b.target_amount, b.target_date ?? null, b.linked_account_id ?? null, b.current_amount ?? 0).lastInsertRowid) }; });
route('PATCH', '/goals/:id', (c, { params, body }) => { const gid = id(params[0]); owned(c, 'goals', gid); const b = parse(goalSchema.partial(), body); for (const [k, v] of Object.entries(b)) run(`UPDATE goals SET ${k}=? WHERE id=?`, v ?? null, gid); return { ok: true }; });
route('DELETE', '/goals/:id', (c, { params }) => { const gid = id(params[0]); owned(c, 'goals', gid); run('DELETE FROM goals WHERE id=?', gid); return { ok: true }; });
route('POST', '/goals/:id/contribute', (c, { params, body }) => {
  const gid = id(params[0]); const g = owned(c, 'goals', gid); const b = parse(z.object({ amount: minor.refine((x) => x !== 0), date: date.default(today()) }), body);
  tx(() => { run('INSERT INTO goal_contributions(goal_id,amount,date) VALUES(?,?,?)', gid, b.amount, b.date); run('UPDATE goals SET current_amount=MAX(0,current_amount+?), status=CASE WHEN current_amount+?>=target_amount THEN \'done\' ELSE \'active\' END WHERE id=?', b.amount, b.amount, gid); }); return { ok: true, name: g.name };
});

// ---------------- bills ----------------
route('GET', '/bills', (c, { query }) => { S.rollRecurring(c); return S.upcomingBills(c, query.get('from') || addDays(today(), -31), query.get('to') || addDays(today(), 60)); });
route('POST', '/bills/pay', (c, { body }) => { notViewer(c); const b = parse(z.object({ recurring_id: z.number().int(), due: date, account_id: z.number().int().optional(), paid_date: date.optional(), amount: minor.optional() }), body); return { transaction_id: S.markBillPaid(c, b.recurring_id, b.due, b.account_id, b.paid_date, b.amount) }; });
route('POST', '/bills/unpay', (c, { body }) => { const b = parse(z.object({ recurring_id: z.number().int(), due: date }), body); owned(c, 'recurring_items', b.recurring_id); const p = get('SELECT * FROM bill_payments WHERE recurring_id=? AND due_date=?', b.recurring_id, b.due); if (p?.transaction_id) S.deleteTxn(c, p.transaction_id); run('DELETE FROM bill_payments WHERE recurring_id=? AND due_date=?', b.recurring_id, b.due); return { ok: true }; });
route('GET', '/subscriptions', (c) => {
  const subs = S.subscriptions(c); const m = (x: any) => x.cadence === 'monthly' ? x.amount : x.cadence === 'yearly' ? x.amount / 12 : x.cadence === 'quarterly' ? x.amount / 3 : x.cadence === 'weekly' ? x.amount * 52 / 12 : x.amount * 26 / 12;
  const monthly = Math.round(subs.reduce((a, s) => a + Math.abs(m(s)), 0)); return { items: subs.map((s) => ({ ...s, amount: Math.abs(s.amount) })), monthly_total: monthly, annual_total: monthly * 12 };
});

// ---------------- planning ----------------
route('GET', '/debts', (c) => S.debts(c));
route('POST', '/debts/plan', (c, { body }) => {
  const b = parse(z.object({ extra: minor.min(0).default(0) }), body); const ds = S.debts(c).map((d) => ({ id: d.id, name: d.name, balance: d.balance, aprPct: d.aprPct, minPayment: d.minPayment }));
  const a = payoffPlan(ds, 'avalanche', b.extra, today()), s = payoffPlan(ds, 'snowball', b.extra, today()), base = payoffPlan(ds, 'avalanche', 0, today());
  return { avalanche: a, snowball: s, minimum_only: base, interest_saved_vs_minimum: base.totalInterest - a.totalInterest, months_saved: base.months - a.months };
});
route('GET', '/networth', (c) => { const cur = S.netWorth(c); S.snapshotNetWorth(c); return { current: cur, history: all('SELECT date,assets,liabilities,net_worth FROM net_worth_snapshots WHERE workspace_id=? ORDER BY date', c.wid) }; });
route('GET', '/forecast', (c, { query }) => ({ ...S.cashflowForecast(c, Math.min(180, num(query, 'days') ?? 90)), safe: S.safeToSpendNow(c) }));
route('GET', '/reports/categories', (c, { query }) => S.categoryReport(c, query.get('from') || addMonths(today(), -1), query.get('to') || today()));
route('GET', '/reports/trend', (c, { query }) => ({ monthly: S.monthlySeries(c, num(query, 'months') ?? 12), categories: S.categoryTrend(c, num(query, 'months') ?? 6) }));
route('GET', '/dashboard', (c) => { runDueGoalSchedules(c); return S.dashboard(c); });
route('GET', '/insights', (c) => ({ insights: S.currentInsights(c), health: S.health(c) }));
route('GET', '/fx', () => all('SELECT * FROM fx_rates ORDER BY quote'));
route('PUT', '/fx', (c, { body }) => { const b = parse(z.object({ quote: z.string().refine((x) => x in CURRENCIES), rate: z.number().positive() }), body); run('INSERT INTO fx_rates(quote,rate) VALUES(?,?) ON CONFLICT(quote) DO UPDATE SET rate=excluded.rate', b.quote, b.rate); return { ok: true }; });
route('GET', '/notifications', (c) => { S.generateNotifications(c); return { items: all('SELECT * FROM notifications WHERE workspace_id=? ORDER BY id DESC LIMIT 50', c.wid), unread: (get('SELECT COUNT(*) n FROM notifications WHERE workspace_id=? AND read_at IS NULL', c.wid) as Row).n }; });
route('POST', '/notifications/read', (c) => { run("UPDATE notifications SET read_at=datetime('now') WHERE workspace_id=? AND read_at IS NULL", c.wid); return { ok: true }; });
route('GET', '/activity', (c) => all('SELECT * FROM audit_log WHERE workspace_id=? ORDER BY id DESC LIMIT 100', c.wid));

// ---------------- profile ----------------
route('GET', '/profile', (c) => { const p = getProfile(c.userId); return { ...p, completeness: completeness(p), options: { employment: EMPLOYMENT, income_ranges: INCOME_RANGES, risk: RISK, goals: GOALS } }; });
route('PUT', '/profile', (c, { body }) => {
  const b = parse(profileSchema, body); saveProfile(c.userId, b); audit(c, 'profile', c.userId, 'update');
  const p = getProfile(c.userId); return { ...p, completeness: completeness(p) };
});

// ---------------- offers ----------------
route('GET', '/offers', (c) => offersFor(c));
route('PUT', '/offers/:id/status', (c, { params, body }) => {
  const b = parse(z.object({ status: z.enum(['new', 'saved', 'dismissed']) }), body);
  if (!setOfferStatus(c, params[0], b.status)) throw new ApiError(404, 'Offer not found'); return { ok: true };
});

// ---------------- assistant ----------------
route('GET', '/chat/status', async (c) => chatStatus(c));
route('POST', '/chat', async (c, { body }) => {
  const b = parse(z.object({ message: z.string().trim().min(1).max(2000), conversation_id: z.string().max(60).nullish() }), body);
  rateLimit('chat:' + c.userId, 30, 60e3); return answer(c, b.message, b.conversation_id);
});
const svcErr = (e: unknown): never => { if (e instanceof ServiceError) throw new ApiError(e.status === 503 ? 503 : e.status, e.status === 503 ? 'The assistant service is not running' : e.message, e.code); throw e; };
route('GET', '/chat/conversations', async (c) => conversations.list(c));
route('GET', '/chat/conversations/:id', async (c, { params }) => conversations.get(c, params[0]).catch(svcErr));
route('PATCH', '/chat/conversations/:id', async (c, { params, body }) => conversations.rename(c, params[0], parse(z.object({ title: z.string().trim().min(1).max(80) }), body).title).catch(svcErr));
route('DELETE', '/chat/conversations/:id', async (c, { params }) => conversations.remove(c, params[0]).catch(svcErr));
route('DELETE', '/chat/conversations', async (c) => conversations.removeAll(c));

// ---------------- dispatcher ----------------
export async function handle(req: Request, segs: string[]): Promise<Response> {
  const path = '/' + segs.join('/'); const method = req.method;
  if (path.startsWith('/internal/')) { try { return await handleInternal(req, path); } catch (e) { console.error('[internal]', path, e); return Response.json({ code: 'internal', message: 'Internal error' }, { status: 500 }); } }
  try {
    const r = routes.find((x) => x.method === method && x.re.test(path));
    if (!r) throw new ApiError(404, 'Not found');
    let body: any;
    if (method !== 'GET') {
      const origin = req.headers.get('origin'); const host = req.headers.get('host');
      if (origin && host && new URL(origin).host !== host) throw new ApiError(403, 'Cross-origin request blocked', 'csrf');
      if (!(req.headers.get('content-type') ?? '').includes('application/json') && path !== '/auth/logout') throw new ApiError(415, 'Expected JSON', 'bad_request');
      const txt = await req.text(); body = txt ? JSON.parse(txt) : {};
    }
    const c = r.auth ? await requireCtx() : (await getCtx()) ?? (null as unknown as Ctx);
    const out = await r.h(c, { params: path.match(r.re)!.slice(1), query: new URL(req.url).searchParams, body, req });
    if (out && out.__raw !== undefined) return new Response(out.__raw, { headers: { 'content-type': out.type, 'content-disposition': `attachment; filename="${out.name}"`, 'cache-control': 'no-store' } });
    return Response.json(out ?? { ok: true }, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    if (e instanceof ApiError) return Response.json({ code: e.code, message: e.message, fields: e.fields }, { status: e.status });
    if (e instanceof ZodError) { const fields: Record<string, string> = {}; for (const i of e.issues) fields[i.path.join('.') || '_'] = i.message; return Response.json({ code: 'validation', message: 'Please check the highlighted fields', fields }, { status: 400 }); }
    if (e instanceof SyntaxError) return Response.json({ code: 'bad_request', message: 'Malformed JSON' }, { status: 400 });
    console.error('[api]', method, path, e); return Response.json({ code: 'internal', message: 'Something went wrong on our side' }, { status: 500 });
  }
}
