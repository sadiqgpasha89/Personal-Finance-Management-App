import { describe, it, expect, beforeAll } from 'vitest';
process.env.LEDGERLY_DB = ':memory:';
import { run, get } from './db';
import { createUser, Ctx, hashPassword, verifyPassword, passwordProblem } from './auth';
import * as S from './service';
import { seedDemo } from './seed';

let c: Ctx, chk: number, sav: number;
beforeAll(() => {
  const { uid, wid } = createUser('t@example.test', 'T', 'correct-horse-9');
  c = { userId: uid, wid, email: 't@example.test', name: 'T', base: 'USD', startDay: 1, privacy: false, role: 'owner' };
  chk = Number(run("INSERT INTO accounts(workspace_id,name,type,currency,opening_balance) VALUES(?,?,?,?,?)", wid, 'Chk', 'checking', 'USD', 100000).lastInsertRowid);
  sav = Number(run("INSERT INTO accounts(workspace_id,name,type,currency,opening_balance) VALUES(?,?,?,?,?)", wid, 'Sav', 'savings', 'USD', 0).lastInsertRowid);
});
const bal = (id: number) => S.accountsWithBalance(c).find((a) => a.id === id)!.balance as number;

describe('auth helpers', () => {
  it('hashes & verifies', () => { const h = hashPassword('abc12345678'); expect(verifyPassword('abc12345678', h)).toBe(true); expect(verifyPassword('nope', h)).toBe(false); expect(h).not.toContain('abc12345678'); });
  it('password policy', () => { expect(passwordProblem('short1')).toBeTruthy(); expect(passwordProblem('longenough12')).toBeNull(); });
});
describe('ledger invariants', () => {
  it('balance = opening + txns', () => { S.insertTxn(c, { account_id: chk, posted_date: '2026-10-01', amount: -2500, description: 'STARBUCKS #1' }); expect(bal(chk)).toBe(97500); });
  it('auto-categorizes known merchants', () => { const t = get('SELECT c.name cat, merchant FROM transactions t JOIN categories c ON c.id=t.category_id ORDER BY t.id DESC LIMIT 1')!; expect(t.cat).toBe('Dining'); expect(t.merchant).toBe('Starbucks'); });
  it('transfers conserve money and are excluded from spend', () => {
    const before = bal(chk) + bal(sav); S.insertTransfer(c, chk, sav, 10000, '2026-10-02');
    expect(bal(chk) + bal(sav)).toBe(before); expect(bal(sav)).toBe(10000);
    expect(S.spendRows(c, '2026-10-01', '2026-10-31').reduce((a, r) => a + r.spend, 0)).toBe(2500);
  });
  it('rejects same-account transfer', () => expect(() => S.insertTransfer(c, chk, chk, 100, '2026-10-02')).toThrow());
  it('soft delete and restore both transfer legs', () => {
    const leg = get("SELECT id FROM transactions WHERE kind='transfer' AND account_id=?", chk)!.id as number;
    S.deleteTxn(c, leg); expect(bal(sav)).toBe(0); S.deleteTxn(c, leg, true); expect(bal(sav)).toBe(10000);
  });
  it('splits must add up', () => {
    const id = S.insertTxn(c, { account_id: chk, posted_date: '2026-10-03', amount: -10000, description: 'target run' });
    expect(() => S.setSplits(c, id, [{ category_id: null, amount: -5000 }])).toThrow();
    const g = S.ensureCategory(c.wid, 'Groceries'), h = S.ensureCategory(c.wid, 'Health');
    S.setSplits(c, id, [{ category_id: g, amount: -7000 }, { category_id: h, amount: -3000 }]);
    const rows = S.spendRows(c, '2026-10-03', '2026-10-03'); expect(rows.map((r) => r.spend).sort()).toEqual([3000, 7000]);
  });
  it('reimbursements reduce spend', () => { const id = S.insertTxn(c, { account_id: chk, posted_date: '2026-10-04', amount: -4000, description: 'taxi', reimbursable: true }); S.updateTxn(c, id, { reimbursed_amount: 4000 }); expect(S.spendRows(c, '2026-10-04', '2026-10-04').reduce((a, r) => a + r.spend, 0)).toBe(0); });
  it('multi-currency freezes the rate at write time', () => {
    const eur = Number(run("INSERT INTO accounts(workspace_id,name,type,currency,opening_balance) VALUES(?,?,?,?,0)", c.wid, 'Euro', 'checking', 'EUR').lastInsertRowid);
    const id = S.insertTxn(c, { account_id: eur, posted_date: '2026-10-05', amount: -9200, description: 'hotel' });
    const before = get('SELECT base_amount FROM transactions WHERE id=?', id)!.base_amount as number; expect(before).toBe(-10000);
    run("UPDATE fx_rates SET rate=0.5 WHERE quote='EUR'"); expect(get('SELECT base_amount FROM transactions WHERE id=?', id)!.base_amount).toBe(before);
  });
});
describe('budgets', () => {
  it('surplus rollover carries into next period', () => {
    const cat = S.ensureCategory(c.wid, 'Dining');
    run('INSERT INTO budgets(workspace_id,category_id,amount,rollover) VALUES(?,?,?,?)', c.wid, cat, 10000, 'surplus');
    const s = S.budgetSummary(c, '2026-11-01'); const l = s.lines.find((x) => x.category === 'Dining')!;
    expect(l.carry).toBe(7500); expect(l.available).toBe(17500); // $100 budget - $25 spent in Oct
  });
});
describe('demo seed', () => {
  it('produces a consistent dataset', () => {
    const u = createUser('d@example.test', 'D', 'correct-horse-9'); const d: Ctx = { ...c, userId: u.uid, wid: u.wid };
    seedDemo(d);
    const nw = S.netWorth(d); expect(nw.assets - nw.liabilities).toBe(nw.net_worth);
    expect(S.debts(d).length).toBe(2); expect(S.subscriptions(d).some((s) => s.merchant === 'Netflix' && s.priceHike)).toBe(true);
    expect(S.safeToSpendNow(d).spendable).toBeGreaterThan(0); expect(S.dashboard(d).accounts).toBe(4);
  });
});
