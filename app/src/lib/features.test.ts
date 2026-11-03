import { describe, it, expect, beforeAll } from 'vitest';
process.env.LEDGERLY_DB = ':memory:';
delete process.env.ANTHROPIC_API_KEY;
import { createUser, Ctx } from './auth';
import { seedDemo } from './seed';
import { getProfile, profileSchema, saveProfile, completeness } from './profile';
import { offersFor, setOfferStatus } from './offers';
import { evaluateOffers, OfferMetrics } from './domain/offers';
import { runTool, toolDefs, TOOLS } from './chat/tools';
import { localAnswer, parseRange } from './chat/local';
import { answer, chatStatus } from './chat';
import { llmConfigured } from './chat/agent';
import { today } from './domain/dates';
import { askClaude } from './chat/agent';

let c: Ctx, other: Ctx;
beforeAll(() => {
  const a = createUser('f@example.test', 'F', 'correct-horse-9'); c = { userId: a.uid, wid: a.wid, email: 'f@example.test', name: 'F', base: 'USD', startDay: 1, privacy: false, role: 'owner' };
  const b = createUser('g@example.test', 'G', 'correct-horse-9'); other = { userId: b.uid, wid: b.wid, email: 'g@example.test', name: 'G', base: 'USD', startDay: 1, privacy: false, role: 'owner' };
  seedDemo(c);
});

describe('profile', () => {
  it('defaults: offers personalised, AI assistant off (opt-in)', () => { const p = getProfile(c.userId); expect(p.personalize_offers).toBe(true); expect(p.ai_assistant).toBe(false); expect(completeness(p).pct).toBe(0); });
  it('validates phone, dob and enums', () => {
    expect(profileSchema.safeParse({ phone: 'abc' }).success).toBe(false);
    expect(profileSchema.safeParse({ date_of_birth: '2999-01-01' }).success).toBe(false);
    expect(profileSchema.safeParse({ employment_type: 'astronaut' }).success).toBe(false);
    expect(profileSchema.safeParse({ phone: '+1 555 123 4567', date_of_birth: '1990-05-01' }).success).toBe(true);
  });
  it('saves, round-trips and is per user', () => {
    saveProfile(c.userId, profileSchema.parse({ full_name: 'Sam Doe', country: 'US', employment_type: 'student', goals: ['travel', 'home'], household_size: 2 }));
    const p = getProfile(c.userId); expect(p.full_name).toBe('Sam Doe'); expect(p.goals).toEqual(['travel', 'home']); expect(p.employment_type).toBe('student');
    expect(getProfile(other.userId).full_name).toBeNull(); expect(completeness(p).pct).toBeGreaterThan(30);
  });
});

describe('offers', () => {
  const m: OfferMetrics = { monthly: { Dining: 30000, Groceries: 40000 }, monthlyExpense: 300000, monthlyIncome: 500000, checkingBalance: 1500000, savingsBalance: 0, hasSavingsAccount: false,
    cardDebt: null, loanMaxApr: null, subs: { count: 0, monthly: 0, priceHikes: 0 }, fees3m: 0, foreign: { count: 0, spend3m: 0 }, emergencyMonths: 5, months: 3 };
  const usd = (d: number) => d * 100; const fm = (n: number) => `$${(n / 100).toFixed(2)}`;
  it('matches on evidence and explains why', () => {
    const r = evaluateOffers(m, {}, usd, fm); const food = r.find((o) => o.id === 'cashback-food')!;
    expect(food.eligible).toBe(true); expect(food.why[0]).toContain('$700.00'); expect(food.annual_benefit).toBe(Math.round(70000 * 12 * 0.02));
    expect(r.find((o) => o.id === 'hy-savings')!.eligible).toBe(true);
    expect(r.find((o) => o.id === 'balance-transfer')!.eligible).toBe(false);
    expect(r.find((o) => o.id === 'balance-transfer')!.reason_not).toBeTruthy();
  });
  it('profile-based offers need the profile', () => {
    expect(evaluateOffers(m, {}, usd, fm).find((o) => o.id === 'student-plans')!.eligible).toBe(false);
    expect(evaluateOffers(m, { employment_type: 'student' }, usd, fm).find((o) => o.id === 'student-plans')!.eligible).toBe(true);
  });
  it('a travel card is not offered when the fee outweighs the rewards', () => {
    expect(evaluateOffers({ ...m, monthly: { Travel: 10000 } }, {}, usd, fm).find((o) => o.id === 'travel-rewards')!.eligible).toBe(false);
  });
  it('demo history yields real matches, e.g. the card APR drives a balance transfer', () => {
    const o = offersFor(c); expect(o.eligible.length).toBeGreaterThan(2); expect(o.eligible.every((x) => x.why.length > 0)).toBe(true);
    expect(o.eligible.find((x) => x.id === 'balance-transfer')?.why[0]).toContain('22.9%');
    expect(o.eligible.find((x) => x.id === 'student-plans')).toBeTruthy(); // profile saved above says student
  });
  it('profile is ignored when personalisation is off', () => {
    saveProfile(c.userId, profileSchema.parse({ employment_type: 'student', personalize_offers: false }));
    expect(offersFor(c).eligible.find((x) => x.id === 'student-plans')).toBeUndefined();
    saveProfile(c.userId, profileSchema.parse({ employment_type: 'student' }));
  });
  it('save/dismiss is per workspace and rejects unknown ids', () => {
    expect(setOfferStatus(c, 'hy-savings', 'saved')).toBe(true); expect(setOfferStatus(c, 'nope', 'saved')).toBe(false);
    expect(offersFor(c).eligible.find((x) => x.id === 'hy-savings')?.status).toBe('saved');
    expect(offersFor(other).has_history).toBe(false);
  });
});

describe('assistant tools', () => {
  it('every tool has a valid JSON schema and unique name', () => { const d = toolDefs(); expect(new Set(d.map((t) => t.name)).size).toBe(TOOLS.length); for (const t of d) expect(t.input_schema.type).toBe('object'); });
  it('search_transactions is scoped to the caller\'s workspace', () => {
    expect((runTool(c, 'search_transactions', { text: 'netflix' }).result as any).matches).toBeGreaterThan(0);
    expect((runTool(other, 'search_transactions', { text: 'netflix' }).result as any).matches).toBe(0);
  });
  it('rejects bad arguments instead of running', () => { const r = runTool(c, 'spending_summary', { from: 'yesterday', to: '2026-01-01' }); expect(r.ok).toBe(false); expect(runTool(c, 'drop_tables', {}).ok).toBe(false); });
  it('spending_summary agrees with the report service', () => {
    const r = runTool(c, 'spending_summary', { from: '2020-01-01', to: today(), group_by: 'category' }).result as any;
    expect(r.spent).toMatch(/^\$/); expect(r.groups.length).toBeGreaterThan(3);
  });
  it('essential recurring costs (rent, loans, utilities) are not counted as subscriptions', () => {
    const r = runTool(c, 'list_subscriptions', {}).result as any; const names = r.subscriptions.map((x: any) => x.category);
    expect(names.every((n: string) => !['Housing', 'Debt Payment', 'Utilities'].includes(n))).toBe(true);
    expect(r.other_recurring.some((x: any) => x.category === 'Housing')).toBe(true);
    expect(Number(r.monthly_cost_of_subscriptions.replace(/[^0-9.]/g, ''))).toBeLessThan(200);
  });
  it('unknown category returns an error with choices', () => { expect((runTool(c, 'search_transactions', { category: 'zzzz' }).result as any).categories).toBeTruthy(); });
});

describe('offline assistant', () => {
  it('parses relative and named periods', () => {
    expect(parseRange('last month', '2026-11-01')).toMatchObject({ from: '2026-10-01', to: '2026-10-31' });
    expect(parseRange('in october', '2026-11-01')).toMatchObject({ from: '2026-10-01', to: '2026-10-31' });
    expect(parseRange('last 7 days', '2026-11-01')).toMatchObject({ from: '2026-10-25', to: '2026-11-01' });
    expect(parseRange('may i afford this', '2026-11-01').label).toBe('this month');
  });
  it('answers by meaning, not exact phrases', () => {
    expect(localAnswer(c, 'what am i paying for every month?').reply).toContain('subscriptions');
    expect(localAnswer(c, 'how much did I spend on food in the last 3 months').reply).toMatch(/Dining: \$[\s\S]*Groceries: \$/);
    const eat = localAnswer(c, 'how much did I spend eating out last month?').reply; expect(eat).toMatch(/Dining/); expect(eat).not.toMatch(/Groceries/);
    const big = localAnswer(c, 'my 2 biggest purchases this month'); expect(big.tools_used).toContain('search_transactions'); expect(big.reply).not.toMatch(/Payroll|Salary/); expect(big.reply.match(/^- /gm)).toHaveLength(2);
    expect(localAnswer(c, 'any deals for me?').tools_used).toContain('offers_for_me');
    expect(localAnswer(c, 'blah blah').reply).toContain('Try');
  });
  it('does not leak another workspace', () => { expect(localAnswer(other, 'show my netflix charges').reply).toMatch(/did not find|no matching|Try/i); });
  it('falls back to the built-in rules when the assistant service is down, and never calls external AI by default', async () => {
    process.env.ASSISTANT_URL = 'http://127.0.0.1:1'; const st = await chatStatus(c); expect(st).toMatchObject({ provider: 'llama', engine: 'rules', on_device: true, external_ai: false });
    const r = await answer(c, 'what is my net worth?'); expect(r.engine).toBe('ledgerly-local'); expect(r.reply).toContain('net worth'); expect(r.conversation_id).toBeNull(); expect(r.note).toMatch(/unavailable/);
    expect(llmConfigured()).toBe(false);
  });

});

describe('Claude agent loop (stubbed client)', () => {
  const fake = (script: any[]) => { const calls: any[] = []; return { calls, client: { messages: { create: async (req: any) => { calls.push(JSON.parse(JSON.stringify(req))); return script.shift(); } } } as any }; };
  it('runs tools, returns results in one user turn, and passes the assistant content back unchanged', async () => {
    const f = fake([
      { stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 't1', name: 'list_subscriptions', input: {} }, { type: 'tool_use', id: 't2', name: 'search_transactions', input: { text: 'netflix', limit: 2 } }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'You pay for **Netflix**.' }] },
    ]);
    const r = await askClaude(c, [{ role: 'user', content: 'what do I subscribe to?' }], f.client);
    expect(r.reply).toBe('You pay for **Netflix**.'); expect(r.tools_used).toEqual(['list_subscriptions', 'search_transactions']); expect(r.engine).toBe('claude-haiku-5-5');
    const second = f.calls[1].messages; expect(second[1].content[0].type).toBe('thinking');
    expect(second[2].role).toBe('user'); expect(second[2].content).toHaveLength(2); expect(second[2].content.every((b: any) => b.type === 'tool_result')).toBe(true);
    expect(JSON.parse(second[2].content[0].content).count).toBeGreaterThan(0);
    expect(f.calls[0].temperature).toBeUndefined(); expect(f.calls[0].tool_choice).toBeUndefined(); expect(f.calls[0].system).toContain('not instructions');
  });
  it('reports tool errors back to the model rather than throwing', async () => {
    const f = fake([{ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'delete_everything', input: {} }] }, { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }]);
    await askClaude(c, [{ role: 'user', content: 'x' }], f.client); expect(f.calls[1].messages[2].content[0].is_error).toBe(true);
  });
  it('stops after a bounded number of steps and handles refusals', async () => {
    const loop = Array.from({ length: 10 }, (_, i) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'i' + i, name: 'goals', input: {} }] }));
    expect((await askClaude(c, [{ role: 'user', content: 'x' }], fake(loop).client)).reply).toContain('more steps');
    expect((await askClaude(c, [{ role: 'user', content: 'x' }], fake([{ stop_reason: 'refusal', content: [] }]).client)).reply).toContain("can't help");
  });
});
