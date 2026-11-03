import { describe, it, expect, beforeAll, vi } from 'vitest';
process.env.LEDGERLY_DB = ':memory:'; process.env.INTERNAL_API_SECRET = 'test-secret-0123456789';
const calls: any[] = []; let aggData: any = { accounts: [] };
vi.mock('./integrations/services', async (orig) => { const m: any = await orig(); return { ...m, call: async (svc: string, path: string, o: any) => { calls.push({ svc, path, o });
  if (path === '/v1/consents' && o?.body) return { id: 'agg-1', approval_url: 'http://x/approve' }; if (path.endsWith('/fetch')) return aggData; if (path.startsWith('/v1/consents/')) return { status: 'ACTIVE', expires_at: '2027-01-01' };
  if (path === '/v1/reports') return { report: { provider: 'sandbox', sample: true, subject: { pan_last4: '234F' }, score: { value: 712, band: 'good', model: 'x' }, factors: [], summary: { utilization: 0.2 }, tradelines: [], enquiries: [] } }; return {}; } }; });
import { all, get, run } from './db';
import { createUser, Ctx } from './auth';
import * as S from './service';
import { startLink, syncLink } from './connections';
import { fetchReport, creditOverview, deleteReports } from './credit';
import { handleInternal } from './internal';
import { signToken } from '../../../packages/shared/src/svcauth';

let c: Ctx;
beforeAll(() => { const a = createUser('i@example.test', 'Ira', 'correct-horse-9'); c = { userId: a.uid, wid: a.wid, email: 'i@example.test', name: 'Ira', base: 'INR', startDay: 1, privacy: false, role: 'owner' }; run("UPDATE workspaces SET base_currency='INR' WHERE id=?", c.wid); });
const acct = (txns: any[], balance: number) => ({ fip_id: 'HDFC-FIP', fip_name: 'HDFC Bank', link_ref: 'ref1', masked_acc: 'XXXX1234', kind: 'savings', currency: 'INR', balance, opening_balance: balance - txns.reduce((s, t) => s + t.amount, 0), txns });
const t = (id: string, amount: number, narration: string, mode = 'OTHERS') => ({ txn_id: id, date: '2026-10-05', amount, mode, narration, balance: null, reference: null });

describe('bank links (Account Aggregator) in core', () => {
  it('links, creates accounts with an opening balance that reconciles, tags UPI, and never double-imports', async () => {
    await startLink(c, { mobile: '9876543210', aa_handle: 'anumati' }); expect(calls[0].o.body.redirect_url).toMatch(/\/connections$/); expect(calls[0].o.user).toEqual({ id: c.userId, wid: c.wid });
    const id = get('SELECT id FROM bank_links')!.id; expect(get('SELECT mobile_masked m FROM bank_links')!.m).toBe('98XXXXXX10');
    aggData = { accounts: [acct([t('a1', 5_000_000, 'SALARY'), t('a2', -45000, 'UPI/412345678901/Zomato/zomato@icici/Order', 'UPI')], 4_955_000 + 100_000)] };
    const r = await syncLink(c, id); expect(r).toMatchObject({ created_accounts: 1, new_transactions: 2, drift_notes: [] });
    const a = S.accountsWithBalance(c).find((x) => x.name.startsWith('HDFC'))!; expect(a.balance).toBe(5_055_000); expect(a.currency).toBe('INR');
    expect(get("SELECT payment_method pm, merchant FROM transactions WHERE external_id='a2'")).toMatchObject({ pm: 'upi', merchant: 'Zomato' });
    expect((await syncLink(c, id))).toMatchObject({ new_transactions: 0, already_imported: 2 });
    aggData = { accounts: [acct([t('a1', 5_000_000, 'SALARY'), t('a2', -45000, 'UPI/412345678901/Zomato/zomato@icici/Order', 'UPI'), t('a3', -1000, 'ATM', 'ATM')], 5_054_000)] };
    expect(await syncLink(c, id)).toMatchObject({ new_transactions: 1, created_accounts: 0 }); expect(S.accountsWithBalance(c).find((x) => x.name.startsWith('HDFC'))!.balance).toBe(5_054_000);
  });
  it('flags when the ledger and the bank disagree', async () => {
    const id = get('SELECT id FROM bank_links')!.id; aggData = { accounts: [acct([], 9_999_999)] }; const r = await syncLink(c, id); expect(r.drift_notes[0]).toMatch(/HDFC Bank: Ledgerly shows .* but the bank reports/);
  });
});
describe('credit reports in core', () => {
  it('needs consent, stores the score and only the last 4 of the PAN, records the consent, and can be deleted', async () => {
    await expect(fetchReport(c, { name: 'Ira', dob: '1990-01-01', pan: 'ABCPE1234F', mobile: '9876543210', consent: false })).rejects.toThrow(/Consent/);
    await fetchReport(c, { name: 'Ira', dob: '1990-01-01', pan: 'ABCPE1234F', mobile: '9876543210', consent: true });
    const sent = calls.filter((x) => x.path === '/v1/reports').at(-1)!.o.body; expect(sent.pan).toBe('ABCPE1234F'); expect(sent.consent).toMatchObject({ given: true });
    expect(JSON.stringify(all('SELECT * FROM credit_reports'))).not.toContain('ABCPE'); expect(get('SELECT COUNT(*) n FROM credit_consents')!.n).toBe(1);
    const o = creditOverview(c); expect(o.latest.score.value).toBe(712); expect(o.history).toHaveLength(1); deleteReports(c); expect(creditOverview(c).latest).toBeNull();
  });
});
describe('internal API', () => {
  const req = (path: string, token: string | null, body?: unknown, method = body ? 'POST' : 'GET') => handleInternal(new Request('http://x' + path, { method, headers: token ? { authorization: 'Bearer ' + token, 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }), path);
  const tok = (o: object = {}) => signToken(process.env.INTERNAL_API_SECRET!, { iss: 'assistant', aud: 'core', sub: c.userId, wid: c.wid, ...o });
  it('rejects missing, wrongly-addressed and forged tokens', async () => {
    expect((await req('/internal/tools', null)).status).toBe(401); expect((await req('/internal/tools', tok({ aud: 'bureau' }))).status).toBe(401); expect((await req('/internal/tools', 'garbage.token')).status).toBe(401);
  });
  it('serves tools for the user named in the token, and nothing for other users', async () => {
    expect(((await (await req('/internal/tools', tok())).json()) as any).tools.length).toBeGreaterThan(12);
    const r: any = await (await req('/internal/tools/run', tok(), { name: 'account_balances', input: {} })).json(); expect(r.ok).toBe(true); expect(r.result.accounts.length).toBeGreaterThan(0);
    expect((await req('/internal/tools/run', tok({ sub: 9999 }), { name: 'account_balances' })).status).toBe(404); expect((await req('/internal/tools/run', tok(), { name: 'drop_tables' })).status).toBe(400);
    const e: any = await (await req('/internal/entities', tok())).json(); expect(e.categories).toContain('Dining'); expect(e.first_name).toBe('Ira');
  });
  it('only the scheduler may run jobs', async () => {
    expect((await req('/internal/jobs/run-due', tok(), {})).status).toBe(403); const r = await req('/internal/jobs/run-due', tok({ iss: 'scheduler', sub: undefined, wid: undefined }), {}); expect(r.status).toBe(200); expect(((await r.json()) as any).goals).toBeDefined();
  });
});
