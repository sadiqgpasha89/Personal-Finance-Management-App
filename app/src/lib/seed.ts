import { run, tx } from './db';
import { Ctx } from './auth';
import * as S from './service';
import { addDays, addMonths, today, fmt, parts, daysInMonth } from './domain/dates';

/** Deterministic demo data: ~6 months of realistic activity across 4 accounts. */
export function seedDemo(c: Ctx) {
  let seed = 42; const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
  const cat = (n: string) => S.ensureCategory(c.wid, n);
  tx(() => {
    const acc = (name: string, type: string, open: number, extra: Record<string, any> = {}) => Number(run(
      `INSERT INTO accounts(workspace_id,name,type,currency,opening_balance,spending,statement_close_day,payment_due_day,credit_limit,apr,min_payment,loan_principal,loan_term_months,loan_start) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      c.wid, name, type, c.base, open, +['checking', 'cash'].includes(type), extra.close ?? null, extra.due ?? null, extra.limit ?? null, extra.apr ?? null, extra.min ?? null, extra.principal ?? null, extra.term ?? null, extra.start ?? null).lastInsertRowid);
    const chk = acc('Everyday Checking', 'checking', 250000), sav = acc('High-Yield Savings', 'savings', 1200000);
    const cc = acc('Rewards Visa', 'credit_card', -85000, { close: 25, due: 15, limit: 800000, apr: 22.9, min: 7500 });
    const car = acc('Auto Loan', 'loan', -1450000, { apr: 6.4, min: 38500, principal: 1800000, term: 60, start: addMonths(today(), -10) });
    const start = addMonths(today().slice(0, 7) + '-01', -5); const end = today();
    const mk = (a: number, d: string, amt: number, desc: string, category?: string, merch?: string) => S.insertTxn(c, { account_id: a, posted_date: d, amount: amt, description: desc, merchant: merch ?? null, category_id: category ? cat(category) : undefined });
    for (let m = 0; m <= 5; m++) {
      const base = addMonths(start, m); const y = parts(base).y, mo = parts(base).m, dim = daysInMonth(y, mo);
      const day = (d: number) => fmt(y, mo, Math.min(d, dim)); const ok = (d: string) => d <= end;
      for (const d of [1, 15]) if (ok(day(d))) mk(chk, day(d), 285000, 'ACME CORP PAYROLL DIRECT DEP', 'Salary');
      if (ok(day(1))) mk(chk, day(1), -145000, 'RENT PROPERTY MGMT', 'Housing');
      if (ok(day(5))) mk(chk, day(5), -9000 - Math.round(rnd() * 5000), 'ELECTRIC CO UTILITY', 'Utilities');
      if (ok(day(8))) mk(chk, day(8), -6500, 'COMCAST XFINITY INTERNET', 'Utilities');
      if (ok(day(10))) mk(chk, day(10), -38500, 'AUTO LOAN PAYMENT', 'Debt Payment');
      if (ok(day(12))) mk(cc, day(12), -(m < 4 ? 1599 : 1999), 'NETFLIX.COM', 'Subscriptions');
      if (ok(day(14))) mk(cc, day(14), -1099, 'SPOTIFY USA', 'Subscriptions');
      if (ok(day(3))) mk(cc, day(3), -4500, 'PLANET FITNESS', 'Health');
      if (ok(day(3))) S.insertTransfer(c, chk, sav, 50000, day(3), 'Monthly savings');
      for (let k = 0; k < 7; k++) { const d = day(1 + Math.floor(rnd() * 27)); if (ok(d)) mk(cc, d, -(6000 + Math.round(rnd() * 14000)), pick(['WHOLE FOODS #123', 'TRADER JOES 551', 'KROGER 0042', 'WALMART SUPERCENTER', 'COSTCO WHSE #772'])); }
      for (let k = 0; k < 8; k++) { const d = day(1 + Math.floor(rnd() * 27)); if (ok(d)) mk(cc, d, -(900 + Math.round(rnd() * 3600)), pick(['STARBUCKS #8812', 'CHIPOTLE 1932', 'DOORDASH*ORDER', 'UBER EATS PENDING', 'MCDONALDS F2201', 'SWIGGY ORDER'])); }
      for (let k = 0; k < 4; k++) { const d = day(1 + Math.floor(rnd() * 27)); if (ok(d)) mk(cc, d, -(1500 + Math.round(rnd() * 5000)), pick(['SHELL OIL 5772', 'UBER TRIP', 'LYFT RIDE', 'CHEVRON 0991'])); }
      for (let k = 0; k < 3; k++) { const d = day(1 + Math.floor(rnd() * 27)); if (ok(d)) mk(cc, d, -(1800 + Math.round(rnd() * 9000)), pick(['AMZN MKTP US*2K4', 'AMAZON.COM*1R7', 'TARGET 00231'])); }
      if (m === 2) mk(cc, day(18), -64000, 'AIRBNB * HMXY', 'Travel'); if (m === 4) mk(cc, day(9), -21000, 'DELTA AIR 0062', 'Travel');
      if (m === 5 && ok(day(9))) { mk(cc, day(9), -4200, 'UBER EATS ORDER'); mk(cc, day(9), -4200, 'UBER EATS ORDER'); }
      if (ok(day(26))) S.insertTransfer(c, chk, cc, 90000, day(26), 'Card payment');
      if (ok(day(28))) mk(sav, day(28), 3200 + m * 50, 'INTEREST PAID', 'Interest');
    }
    // budgets
    const bud: [string, number, string][] = [['Housing', 145000, 'none'], ['Groceries', 55000, 'surplus'], ['Dining', 25000, 'none'], ['Transport', 20000, 'none'], ['Utilities', 18000, 'none'], ['Subscriptions', 6000, 'none'], ['Shopping', 20000, 'none'], ['Health', 8000, 'none'], ['Travel', 20000, 'both'], ['Debt Payment', 38500, 'none']];
    for (const [n, a, r] of bud) run('INSERT INTO budgets(workspace_id,category_id,amount,rollover) VALUES(?,?,?,?)', c.wid, cat(n), a, r);
    // recurring
    const rec = (name: string, kind: string, amt: number, a: number, cn: string, cad: string, next: string) => run('INSERT INTO recurring_items(workspace_id,name,kind,amount,account_id,category_id,cadence,next_due,is_bill) VALUES(?,?,?,?,?,?,?,?,?)', c.wid, name, kind, amt, a, cat(cn), cad, next, +(kind === 'expense'));
    const nm = (d: number) => { const t = today(); const cand = fmt(parts(t).y, parts(t).m, Math.min(d, daysInMonth(parts(t).y, parts(t).m))); return cand >= t ? cand : addMonths(cand, 1, d); };
    rec('Rent', 'expense', 145000, chk, 'Housing', 'monthly', nm(1)); rec('Electric', 'expense', 11000, chk, 'Utilities', 'monthly', nm(5)); rec('Internet', 'expense', 6500, chk, 'Utilities', 'monthly', nm(8));
    rec('Auto loan payment', 'expense', 38500, chk, 'Debt Payment', 'monthly', nm(10)); rec('Netflix', 'expense', 1999, cc, 'Subscriptions', 'monthly', nm(12)); rec('Paycheck', 'income', 285000, chk, 'Salary', 'monthly', nm(15));
    rec('Car insurance', 'expense', 62000, chk, 'Insurance', 'yearly', addMonths(today(), 3));
    // goals, funds, assets
    run('INSERT INTO goals(workspace_id,name,type,target_amount,target_date,linked_account_id) VALUES(?,?,?,?,?,?)', c.wid, 'Emergency fund (6 months)', 'emergency', 2400000, addMonths(today(), 14), sav);
    run('INSERT INTO goals(workspace_id,name,type,target_amount,target_date,current_amount) VALUES(?,?,?,?,?,?)', c.wid, 'Japan trip', 'vacation', 450000, addMonths(today(), 8), 120000);
    run('INSERT INTO goals(workspace_id,name,type,target_amount,target_date,current_amount) VALUES(?,?,?,?,?,?)', c.wid, 'House down payment', 'down_payment', 6000000, addMonths(today(), 36), 800000);
    run('INSERT INTO sinking_funds(workspace_id,name,category_id,target_amount,due_date,balance) VALUES(?,?,?,?,?,?)', c.wid, 'Car insurance (annual)', cat('Insurance'), 62000, addMonths(today(), 3), 15000);
    run('INSERT INTO manual_assets(workspace_id,name,kind,value,currency,is_liability) VALUES(?,?,?,?,?,?)', c.wid, 'Car', 'vehicle', 2100000, c.base, 0);
    run('INSERT INTO holdings(workspace_id,symbol,asset_class,quantity,cost_basis,price) VALUES(?,?,?,?,?,?)', c.wid, 'VTI', 'fund', 42.5, 950000, 27800);
    run("INSERT INTO rules(workspace_id,priority,conditions_json,actions_json) VALUES(?,?,?,?)", c.wid, 10, JSON.stringify([{ field: 'description', op: 'contains', value: 'PLANET FITNESS' }]), JSON.stringify({ category: 'Health', tag: 'fitness' }));
    for (let i = 5; i >= 0; i--) { const d = addDays(today(), -i * 30); run('INSERT OR IGNORE INTO net_worth_snapshots(workspace_id,date,assets,liabilities,net_worth) VALUES(?,?,?,?,?)', c.wid, d, 4200000 + (5 - i) * 90000, 1600000 - (5 - i) * 30000, 2600000 + (5 - i) * 120000); }
    run('UPDATE workspaces SET onboarded=1 WHERE id=?', c.wid);
  });
}
