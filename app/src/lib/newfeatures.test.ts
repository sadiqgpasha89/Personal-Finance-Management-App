import { describe, it, expect, beforeAll } from 'vitest';
process.env.LEDGERLY_DB = ':memory:';
import { run, get, all } from './db';
import { createUser, Ctx } from './auth';
import * as S from './service';
import { cardSchema, listCards } from './cards';
import { containsCardNumber, expiryState, luhn, nextDayOfMonth, utilization, utilizationBand, feeWaiverProgress } from './domain/cards';
import { buildUpiLink, parseUpiLink, parseUpiNarration, isVpa, appOf } from './domain/upi';
import { makeLink, recordPayment, upiSummary } from './upi';
import { runDueGoalSchedules, saveSchedule } from './goalsched';

let c: Ctx, chk: number, sav: number, cc: number;
beforeAll(() => {
  const a = createUser('n@example.test', 'N', 'correct-horse-9'); c = { userId: a.uid, wid: a.wid, email: 'n@example.test', name: 'N', base: 'INR', startDay: 1, privacy: false, role: 'owner' };
  const acc = (n: string, t: string, ob: number, extra = '') => Number(run(`INSERT INTO accounts(workspace_id,name,type,currency,opening_balance) VALUES(?,?,?,?,?)`, c.wid, n, t, 'INR', ob).lastInsertRowid);
  chk = acc('Salary A/c', 'checking', 5_000_000); sav = acc('Savings', 'savings', 0); cc = acc('HDFC Regalia', 'credit_card', 0);
});

describe('card helpers', () => {
  it('spots full card numbers but not other numbers', () => {
    expect(luhn('4111111111111111')).toBe(true); expect(containsCardNumber('my card 4111 1111 1111 1111')).toBe(true); expect(containsCardNumber('order 1234567890123')).toBe(false); expect(containsCardNumber('ref 123456789012')).toBe(false);
  });
  it('expiry, utilization and fee waiver', () => {
    expect(expiryState(12, 2026, '2026-11-01')).toMatchObject({ state: 'expiring', daysLeft: 60 }); expect(expiryState(10, 2026, '2026-11-01').state).toBe('expired'); expect(expiryState(null, null, '2026-11-01').state).toBe('unknown'); expect(expiryState(1, 27, '2026-11-01').state).toBe('ok');
    expect(utilization(30000, 100000)).toBe(0.3); expect(utilizationBand(0.29)).toBe('good'); expect(utilizationBand(0.5)).toBe('fair'); expect(utilizationBand(0.9)).toBe('high');
    expect(feeWaiverProgress(60000, 120000, 5000)).toMatchObject({ pct: 0.5, remaining: 60000, waived: false }); expect(feeWaiverProgress(1, null, 5000)).toBeNull();
    expect(nextDayOfMonth(31, '2026-02-10')).toBe('2026-02-28'); expect(nextDayOfMonth(5, '2026-12-10')).toBe('2027-01-05');
  });
  it('schema rejects a full PAN anywhere and requires 4 digits', () => {
    const ok = { nickname: 'Regalia', kind: 'credit', last4: '1234' };
    expect(cardSchema.safeParse(ok).success).toBe(true); expect(cardSchema.safeParse({ ...ok, last4: '41111111' }).success).toBe(false); expect(cardSchema.safeParse({ ...ok, nickname: '4111 1111 1111 1111' }).success).toBe(false);
  });
});

describe('cards in the ledger', () => {
  it('attributes spend by card, supports untagged single-card accounts and computes utilization', () => {
    const k1 = Number(run("INSERT INTO cards(workspace_id,account_id,nickname,kind,network,last4,credit_limit,due_day,expiry_month,expiry_year) VALUES(?,?,?,?,?,?,?,?,?,?)", c.wid, cc, 'Regalia', 'credit', 'visa', '4242', 10_000_000, 20, 12, 2030).lastInsertRowid);
    const k2 = Number(run("INSERT INTO cards(workspace_id,account_id,nickname,kind,network,last4) VALUES(?,?,?,?,?,?)", c.wid, chk, 'Debit', 'debit', 'rupay', '9876').lastInsertRowid);
    const d = new Date(); const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    S.insertTxn(c, { account_id: cc, posted_date: today, amount: -2_500_000, description: 'AMAZON PAY INDIA' });
    S.insertTxn(c, { account_id: chk, posted_date: today, amount: -100_000, description: 'POS PURCHASE CARD XX9876 BIGBAZAAR' }); // auto-tagged to the debit card
    S.insertTxn(c, { account_id: chk, posted_date: today, amount: -50_000, description: 'RENT', card_id: null });
    const r = listCards(c); const credit = r.items.find((x) => x.id === k1)!, debit = r.items.find((x) => x.id === k2)!;
    expect(credit.owed).toBe(2_500_000); expect(credit.utilization).toBeCloseTo(0.25); expect(credit.utilization_band).toBe('good'); expect(credit.available_credit).toBe(7_500_000);
    expect(get('SELECT card_id FROM transactions WHERE description LIKE ?', '%BIGBAZAAR%')!.card_id).toBe(k2);
    expect(debit.spent_period).toBe(150_000); expect(r.summary.total_limit).toBe(10_000_000); expect(r.summary.utilization).toBeCloseTo(0.25);
  });
});

describe('UPI', () => {
  it('builds and parses payment links safely', () => {
    const l = buildUpiLink({ vpa: 'shop@okaxis', name: 'Ravi & Sons', amount: 249.5, note: 'Rent Nov', ref: 'INV1' });
    expect(l).toBe('upi://pay?pa=shop%40okaxis&pn=Ravi%20%26%20Sons&tr=INV1&tn=Rent%20Nov&am=249.50&cu=INR'); expect(parseUpiLink(l)).toMatchObject({ vpa: 'shop@okaxis', name: 'Ravi & Sons', amount: 249.5, note: 'Rent Nov' });
    expect(() => buildUpiLink({ vpa: 'not a vpa' })).toThrow(); expect(() => buildUpiLink({ vpa: 'a@b', amount: 0 })).toThrow(); expect(() => buildUpiLink({ vpa: 'ab@okaxis', amount: 10.123 })).toThrow();
    expect(parseUpiLink('https://evil.test')).toBeNull(); expect(isVpa('x@y')).toBe(false); expect(isVpa('ab@y1')).toBe(true); expect(appOf('a.b@okhdfcbank')).toContain('Google Pay');
  });
  it('parses the narration styles Indian banks use', () => {
    expect(parseUpiNarration('UPI/412345678901/Zomato/zomato@icici/Order')).toMatchObject({ ref: '412345678901', vpa: 'zomato@icici', payee: 'Zomato' });
    expect(parseUpiNarration('UPI-RAJESH KUMAR-rajesh@okaxis-HDFC0000123-412345678902-Dinner')).toMatchObject({ ref: '412345678902', vpa: 'rajesh@okaxis', payee: 'RAJESH KUMAR', note: 'Dinner' });
    expect(parseUpiNarration('TO TRANSFER-UPI/DR/412345678903/AMAZON/YESB/amazon@yapl/NA')).toMatchObject({ ref: '412345678903', vpa: 'amazon@yapl', direction: 'debit', payee: 'AMAZON' });
    expect(parseUpiNarration('ATM WITHDRAWAL 7TH AVE')).toBeNull(); expect(parseUpiNarration('NEFT CR 123456789012 SALARY')).toBeNull();
  });
  it('tags UPI transactions from bank narrations and learns payees', () => {
    run('INSERT INTO upi_payees(workspace_id,name,vpa,category_id) VALUES(?,?,?,?)', c.wid, 'Zomato', 'zomato@icici', S.ensureCategory(c.wid, 'Dining'));
    const id = S.insertTxn(c, { account_id: chk, posted_date: '2026-10-05', amount: -45000, description: 'UPI/412345678901/Zomato/zomato@icici/Order' });
    const t = get('SELECT t.*, cat.name cat FROM transactions t LEFT JOIN categories cat ON cat.id=t.category_id WHERE t.id=?', id)!;
    expect(t).toMatchObject({ payment_method: 'upi', upi_vpa: 'zomato@icici', upi_ref: '412345678901', merchant: 'Zomato', cat: 'Dining' });
  });
  it('records a payment once per UPI reference and returns a QR', async () => {
    const q = await makeLink(c, { vpa: 'shop@okaxis', name: 'Shop', amount: 120 }); expect(q.qr_svg).toContain('<svg'); expect(q.link).toContain('am=120.00');
    expect((await makeLink(c, { vpa: 'ab@okaxis', amount: 200000 })).warnings.length).toBe(1);
    const id = recordPayment(c, { account_id: chk, vpa: 'shop@okaxis', name: 'Shop', amount: 12000, date: '2026-10-06', ref: '555555555555' }); expect(get('SELECT payment_method FROM transactions WHERE id=?', id)!.payment_method).toBe('upi');
    expect(() => recordPayment(c, { account_id: chk, vpa: 'shop@okaxis', amount: 12000, date: '2026-10-06', ref: '555555555555' })).toThrow(/already recorded/); expect(() => recordPayment(c, { account_id: chk, vpa: 'shop@okaxis', amount: 1, date: '2026-10-06', ref: '12' })).toThrow(/12 digits/);
    expect(upiSummary(c).recent.length).toBeGreaterThan(1);
  });
});

describe('goal auto-contributions', () => {
  const goal = (linked: number | null) => Number(run('INSERT INTO goals(workspace_id,name,target_amount,linked_account_id) VALUES(?,?,?,?)', c.wid, 'G' + Math.random(), 10_000_000, linked).lastInsertRowid);
  const bal = (id: number) => S.accountsWithBalance(c).find((a) => a.id === id)!.balance as number;
  it('transfers to a linked savings account on the chosen date, with catch-up and no double runs', () => {
    const g = goal(sav); saveSchedule(c, g, { amount: 100_000, cadence: 'monthly', next_run: '2026-08-15', from_account_id: chk, active: true });
    const before = bal(chk); const r = runDueGoalSchedules(c, '2026-10-20'); expect(r.ran).toBe(3);   // Aug 15, Sep 15, Oct 15
    expect(bal(sav)).toBe(300_000); expect(bal(chk)).toBe(before - 300_000); expect(runDueGoalSchedules(c, '2026-10-20').ran).toBe(0);
    expect(get('SELECT next_run FROM goal_schedules WHERE goal_id=?', g)!.next_run).toBe('2026-11-15'); expect(runDueGoalSchedules(c, '2026-11-15').ran).toBe(1); expect(bal(sav)).toBe(400_000);
  });
  it('books an expense plus a contribution when the goal has no linked account, and finishes one-off schedules', () => {
    const g = goal(null); run("INSERT INTO goal_schedules(workspace_id,goal_id,amount,cadence,next_run,from_account_id) VALUES(?,?,?,?,?,?)", c.wid, g, 250_000, 'once', '2026-09-01', chk);
    const before = bal(chk); runDueGoalSchedules(c, '2026-09-02'); expect(bal(chk)).toBe(before - 250_000);
    expect(get('SELECT current_amount FROM goals WHERE id=?', g)!.current_amount).toBe(250_000); expect(get('SELECT cat.name n FROM transactions t JOIN categories cat ON cat.id=t.category_id WHERE t.description LIKE ?', '%goal%')!.n).toBe('Savings');
    expect(get('SELECT active FROM goal_schedules WHERE goal_id=?', g)!.active).toBe(0);
  });
  it('skips with a notification when the account lacks funds and keeps going next time', () => {
    const empty = Number(run("INSERT INTO accounts(workspace_id,name,type,currency,opening_balance) VALUES(?,?,?,?,?)", c.wid, 'Tiny', 'savings', 'INR', 1000).lastInsertRowid);
    const g = goal(null); saveSchedule(c, g, { amount: 500_000, cadence: 'monthly', next_run: '2026-10-01', from_account_id: empty, active: true });
    const r = runDueGoalSchedules(c, '2026-10-02'); expect(r).toMatchObject({ ran: 0, skipped: 1 }); expect(get("SELECT status FROM goal_runs WHERE run_date='2026-10-01' AND message LIKE 'Not enough%'")!.status).toBe('skipped');
    expect(get("SELECT COUNT(*) n FROM notifications WHERE title LIKE 'Auto-save skipped%'")!.n).toBe(1); expect(get('SELECT next_run FROM goal_schedules WHERE goal_id=?', g)!.next_run).toBe('2026-11-01');
  });
  it('validates the source account', () => {
    const g = goal(sav); expect(() => saveSchedule(c, g, { amount: 1, cadence: 'monthly', next_run: '2026-12-01', from_account_id: sav, active: true })).toThrow(/already tracks/);
    expect(() => saveSchedule(c, g, { amount: 1, cadence: 'monthly', next_run: '2026-12-01', from_account_id: cc, active: true })).toThrow(/spendable|checking/);
  });
});
