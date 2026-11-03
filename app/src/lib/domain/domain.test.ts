import { describe, it, expect } from 'vitest';
import { parseMoney, formatMoney, allocate, roundHalfEven, convert } from './money';
import { addMonths, budgetPeriod, isDate } from './dates';
import { occurrences, nextOccurrence } from './recurrence';
import { monthlyPayment, schedule } from './amortization';
import { payoffPlan } from './debt';
import { available, monthlyRequired, alertLevel } from './budget';
import { parseCSV, guessMapping, applyMapping, toCSV } from './csv';
import { categorize, normalizeMerchant } from './categorize';
import { detectSubscriptions, forecast, safeToSpend, healthScore, statementCycle } from './analytics';

describe('money', () => {
  it('parses formats', () => {
    expect(parseMoney('1,234.56')).toBe(123456); expect(parseMoney('(12.30)')).toBe(-1230);
    expect(parseMoney('-$5')).toBe(-500); expect(parseMoney('1.234,56')).toBe(123456); expect(parseMoney('12,5')).toBe(1250);
    expect(parseMoney('abc')).toBeNull(); expect(parseMoney('1,000')).toBe(100000);
  });
  it('formats', () => { expect(formatMoney(-123456)).toBe('-$1,234.56'); expect(formatMoney(500, 'JPY')).toBe('¥500'); });
  it('rounds half-even', () => { expect(roundHalfEven(2.5)).toBe(2); expect(roundHalfEven(3.5)).toBe(4); });
  it('allocates exactly', () => { const a = allocate(100, [1, 1, 1]); expect(a.reduce((x, y) => x + y)).toBe(100); expect(allocate(-100, [1, 1, 1]).reduce((x, y) => x + y)).toBe(-100); });
  it('converts', () => expect(convert(10000, 0.5, 'USD', 'EUR')).toBe(5000));
});
describe('dates', () => {
  it('clamps month end', () => { expect(addMonths('2025-01-31', 1)).toBe('2025-02-28'); expect(addMonths('2024-01-31', 1)).toBe('2024-02-29'); });
  it('budget period with payday', () => { expect(budgetPeriod('2025-03-10', 25)).toMatchObject({ start: '2025-02-25', end: '2025-03-24' }); expect(budgetPeriod('2025-03-10', 1)).toMatchObject({ start: '2025-03-01', end: '2025-03-31' }); });
  it('validates', () => { expect(isDate('2025-02-30')).toBe(false); expect(isDate('2025-02-28')).toBe(true); });
});
describe('recurrence', () => {
  it('keeps anchor day', () => { const o = occurrences('2025-01-31', 'monthly', '2025-01-01', '2025-04-30'); expect(o).toEqual(['2025-01-31', '2025-02-28', '2025-03-31', '2025-04-30']); });
  it('biweekly', () => expect(nextOccurrence('2025-01-01', 'biweekly')).toBe('2025-01-15'));
});
describe('loans & debt', () => {
  it('payment + schedule amortize to zero', () => {
    const pay = monthlyPayment(20000000, 6, 360); expect(pay).toBeGreaterThan(119000); expect(pay).toBeLessThan(120100);
    const s = schedule({ principal: 20000000, aprPct: 6, payment: pay, startDate: '2025-01-01' }); expect(s.rows.at(-1)!.balance).toBe(0); expect(s.rows.length).toBeLessThanOrEqual(361);
    const e = schedule({ principal: 20000000, aprPct: 6, payment: pay, startDate: '2025-01-01', extraMonthly: 50000 }); expect(e.rows.length).toBeLessThan(s.rows.length); expect(e.totalInterest).toBeLessThan(s.totalInterest);
  });
  it('detects negative amortization', () => expect(schedule({ principal: 1000000, aprPct: 24, payment: 1000, startDate: '2025-01-01' }).neverPaysOff).toBe(true));
  const debts = [{ id: 1, name: 'Card', balance: 500000, aprPct: 24, minPayment: 10000 }, { id: 2, name: 'Loan', balance: 100000, aprPct: 5, minPayment: 5000 }];
  it('avalanche saves interest vs snowball', () => {
    const a = payoffPlan(debts, 'avalanche', 20000, '2025-01-01'), s = payoffPlan(debts, 'snowball', 20000, '2025-01-01');
    expect(a.feasible).toBe(true); expect(a.totalInterest).toBeLessThanOrEqual(s.totalInterest);
  });
  it('more extra => earlier', () => expect(payoffPlan(debts, 'avalanche', 50000, '2025-01-01').months).toBeLessThan(payoffPlan(debts, 'avalanche', 0, '2025-01-01').months));
});
describe('budget', () => {
  it('rollover policies', () => {
    expect(available(10000, 7000, 2000, 'none').available).toBe(10000);
    expect(available(10000, 7000, 2000, 'surplus').available).toBe(12000);
    expect(available(10000, 7000, -2000, 'surplus').available).toBe(10000);
    expect(available(10000, 7000, -2000, 'both').available).toBe(8000);
  });
  it('alerts + required', () => { expect(alertLevel(0.85)).toBe(80); expect(monthlyRequired(120000, 20000, 10)).toBe(10000); });
});
describe('csv', () => {
  it('parses quotes and delimiters', () => { expect(parseCSV('a;b\n"x;1";"he said ""hi"""\n')).toEqual([['a', 'b'], ['x;1', 'he said "hi"']]); });
  it('maps debit/credit', () => {
    const rows = parseCSV('Date,Description,Debit,Credit\n2025-01-05,Coffee,4.50,\n01/06/2025,Pay,,100.00\nbad,x,1,\n');
    const m = guessMapping(rows[0])!; m.dateFormat = 'mdy'; const r = applyMapping(rows, m);
    expect(r.rows.map((x) => x.amount)).toEqual([-450, 10000]); expect(r.rows[1].date).toBe('2025-01-06'); expect(r.errors).toHaveLength(1);
  });
  it('guards formula injection', () => expect(toCSV([['=cmd()', 'ok']])).toBe("'=cmd(),ok"));
});
describe('categorize', () => {
  it('normalizes', () => { expect(normalizeMerchant('AMZN MKTP US*2K4')).toBe('Amazon'); expect(normalizeMerchant('POS DEBIT STARBUCKS #1234')).toBe('Starbucks'); });
  it('rule > memory > dictionary', () => {
    const t = { description: 'STARBUCKS 123', amount: -500 };
    expect(categorize(t, [], {}).category).toBe('Dining');
    expect(categorize(t, [], { Starbucks: 'Treats' }).source).toBe('memory');
    expect(categorize(t, [{ priority: 1, conditions: [{ field: 'description', op: 'contains', value: 'starb' }], actions: { category: 'Coffee' } }], { Starbucks: 'Treats' })).toMatchObject({ category: 'Coffee', source: 'rule' });
  });
});
describe('analytics', () => {
  const mk = (id: number, date: string, amt: number): any => ({ id, date, amount: -amt, merchant: 'Netflix', category: 'Subscriptions', kind: 'expense' });
  it('detects subscription + hike', () => {
    const s = detectSubscriptions([mk(1, '2025-01-05', 1500), mk(2, '2025-02-05', 1500), mk(3, '2025-03-05', 1500), mk(4, '2025-04-05', 1800)]);
    expect(s[0]).toMatchObject({ merchant: 'Netflix', cadence: 'monthly', nextCharge: '2025-05-05' }); expect(s[0].priceHike).toBeTruthy();
  });
  it('ignores irregular', () => expect(detectSubscriptions([mk(1, '2025-01-05', 1500), mk(2, '2025-01-20', 1500), mk(3, '2025-04-05', 1500)])).toHaveLength(0));
  it('forecast applies scheduled + variable', () => {
    const f = forecast({ balance: 100000, today: '2025-01-01', days: 30, scheduled: [{ name: 'Rent', amount: -50000, cadence: 'monthly', nextDue: '2025-01-15' }], variableDailySpend: 1000 });
    expect(f.endBalance).toBe(100000 - 50000 - 30000);
  });
  it('safe to spend', () => expect(safeToSpend({ spendable: 100, upcomingBills: 30, sinkingSetAside: 10, essentialsRemaining: 20 }).value).toBe(40));
  it('health explains', () => { const h = healthScore({ savingsRate: 0.2, emergencyMonths: 6, debtToIncome: 0, budgetAdherence: 1, billsOnTime: 1 }); expect(h.score).toBe(100); expect(healthScore({ savingsRate: null, emergencyMonths: null, debtToIncome: null, budgetAdherence: null, billsOnTime: null }).score).toBeNull(); });
  it('statement cycle', () => { expect(statementCycle('2025-03-10', 25, 15)).toMatchObject({ lastClose: '2025-02-25', due: '2025-03-15', daysToDue: 5 }); });
});
