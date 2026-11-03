import test from 'node:test';
import assert from 'node:assert/strict';
import { ConvStore } from './store.ts';
import { buildAssistant } from './main.ts';
import { unsupportedNumbers, renderFacts } from './compose.ts';
import { guard, normalizePlan, toCalls } from './planner.ts';
import { callService } from '../../../packages/shared/src/client.ts';
import type { CoreClient, Entities } from './core.ts';
import type { Llm } from './llm.ts';

const secret = 'test-secret-0123456789';
const ent: Entities = { today: '2026-11-01', base: 'INR', first_name: 'Asha', categories: ['Dining', 'Groceries', 'Transport'], merchants: ['Swiggy', 'Uber', 'Zomato'], accounts: [], cards: [] };
const fakeCore = (log: any[] = []): CoreClient => ({ tools: async () => [], entities: async () => ent, run: async (u, name, input) => { log.push({ u, name, input });
  if (name === 'spending_summary') return { ok: true, result: { currency: 'INR', from: (input as any).from, to: (input as any).to, spent: '₹4,250.00', transactions: 9 } };
  if (name === 'list_subscriptions') return { ok: true, result: { count: 2, monthly_cost_of_subscriptions: '₹1,298.00', subscriptions: [{ merchant: 'Netflix', amount: '₹649.00' }, { merchant: 'Spotify', amount: '₹649.00' }] } };
  return { ok: false, result: { error: 'Unknown tool' } }; } });
const stub = (plans: object[], composes: string[]): Llm => ({ name: 'stub-llm', plan: async () => plans.shift()!, compose: async () => composes.shift()!, close: async () => {} });
const P = (o: object) => ({ intent: 'help', category: '', merchant: '', period: '', sort: '', count: 0, follow_up: false, ...o });

test('the store keeps conversations per user, survives reopen, prunes and deletes', () => {
  const s = new ConvStore(':memory:'); const a = s.create(1, 'How much on dining?'); s.add(1, a, { role: 'user', content: 'hi' }); s.add(1, a, { role: 'assistant', content: 'hello', plan: { intent: 'help' }, tools: ['x'], engine: 'e' });
  assert.equal(s.messages(1, a)!.length, 2); assert.equal(s.messages(2, a), null); assert.equal(s.has(2, a), false); assert.throws(() => s.add(2, a, { role: 'user', content: 'x' })); assert.equal(s.list(1)[0].messages, 2); assert.equal(s.list(2).length, 0);
  assert.equal(s.rename(2, a, 'x'), false); assert.equal(s.rename(1, a, 'Dining'), true); s.db.prepare("UPDATE conversations SET updated_at='2020-01-01 00:00:00'").run(); assert.equal(s.prune(90), 1); assert.equal(s.list(1).length, 0);
  for (let i = 0; i < 5; i++) s.create(1, 'c' + i); assert.equal(s.prune(90, 3), 2); assert.equal(s.removeAll(1), 3);
});
test('numbers the data does not contain are caught', () => {
  const facts = { spent: '₹4,250.00', transactions: 9 }; assert.deepEqual(unsupportedNumbers('You spent ₹4,250.00 across 9 transactions.', facts), []); assert.deepEqual(unsupportedNumbers('You spent ₹4,520.00.', facts), ['4,520.00']); assert.deepEqual(unsupportedNumbers('About 3 of them', facts), []);
  assert.match(renderFacts([{ name: 'x', result: { currency: 'INR', spent: '₹1', items: [{ a: 1, b: 'two' }] } }], 'Period: last month.'), /Period: last month\.\n- spent: ₹1\nitems:\n- a: 1, b: two/);
});
test('plans become validated tool calls: dates and categories come from code, not the model', () => {
  const r = toCalls('How much did I spend on eating out last month?', normalizePlan(P({ intent: 'spending', category: 'eating out', period: 'last month' }))!, null, ent);
  assert.deepEqual(r.calls, [{ name: 'spending_summary', input: { from: '2026-10-01', to: '2026-10-31', category: 'Dining' } }]);
  assert.equal(normalizePlan({ intent: 'drop_tables' }), null); assert.equal(normalizePlan(P({ intent: 'spending', count: 99999 }))!.count, 0);
  const prev = normalizePlan(P({ intent: 'spending', category: 'dining', period: 'last month' }))!; const f = toCalls('and the month before?', normalizePlan(P({ intent: 'spending', period: 'the month before', follow_up: true }))!, prev, ent);
  assert.equal(f.calls[0].input.category, 'Dining'); const s = toCalls('what about swiggy', normalizePlan(P({ intent: 'spending', merchant: 'swiggy', follow_up: true }))!, prev, ent); assert.equal(s.calls[0].input.merchant, 'Swiggy'); assert.equal(s.calls[0].input.category, undefined);
  assert.deepEqual(toCalls('show my 3 biggest purchases', normalizePlan(P({ intent: 'transactions', sort: 'largest', count: 3 }))!, null, ent).calls[0].input, { sort: 'largest', limit: 3, kind: 'expense' });
  assert.deepEqual(guard('what is my cibil score', 'spending'), { intent: 'credit_score', guarded: true }); assert.equal(guard('pay my electricity bill via upi', 'bills').intent, 'bills');
});
test('chat end to end with a stub model: plan, tools, verified answer, history and follow-up', async () => {
  const log: any[] = []; const llm = stub([P({ intent: 'spending', category: 'dining', period: 'last month' }), P({ intent: 'spending', period: 'the month before', follow_up: true })], ['You spent ₹4,250.00 on dining last month across 9 transactions.', 'Dining came to ₹9,999.00 that month.']);
  const svc = buildAssistant({ port: 0, secret, dbFile: ':memory:', core: fakeCore(log), llm, headline: true }); await new Promise<void>((r) => svc.server.listen(0, r)); const port = (svc.server.address() as any).port;
  const call = <T,>(uid: number, p: string, body?: unknown, method?: string) => callService<T>({ baseUrl: `http://127.0.0.1:${port}`, audience: 'assistant', issuer: 'core', secret, path: p, body, method, user: { id: uid, wid: 1 } });
  try {
    const a: any = await call(1, '/v1/chat', { message: 'How much did I spend on dining last month?' }); assert.ok(a.reply.startsWith('You spent ₹4,250.00 on dining last month across 9 transactions.')); assert.match(a.reply, /\*\*₹4,250\.00\*\*/); assert.equal(a.engine, 'stub-llm'); assert.deepEqual(a.tools_used, ['spending_summary']); assert.equal(a.verified_numbers, true);
    assert.deepEqual(log[0].input, { from: '2026-10-01', to: '2026-10-31', category: 'Dining' }); assert.deepEqual(log[0].u, { id: 1, wid: 1 });
    const b: any = await call(1, '/v1/chat', { message: 'and the month before?', conversation_id: a.conversation_id }); assert.equal(log[1].input.category, 'Dining'); assert.equal(log[1].input.from, '2026-09-01');   // follow-up inherited the category, recomputed the dates
    assert.match(b.reply, /You spent \*\*₹4,250\.00\*\*/); assert.ok(!b.reply.includes('9,999')); assert.equal(b.verified_numbers, false);           // the model invented ₹9,999.00, so the plain facts were used instead
    const conv: any = await call(1, `/v1/conversations/${a.conversation_id}`); assert.equal(conv.messages.length, 4); assert.equal(conv.messages[1].plan.intent, 'spending');
    await assert.rejects(call(2, `/v1/conversations/${a.conversation_id}`), (e: any) => e.status === 404); await assert.rejects(call(2, '/v1/chat', { message: 'hi', conversation_id: a.conversation_id }), (e: any) => e.status === 404);
    assert.equal(((await call(1, '/v1/conversations')) as any).items.length, 1); await call(1, `/v1/conversations/${a.conversation_id}`, undefined, 'DELETE'); assert.equal(((await call(1, '/v1/conversations')) as any).items.length, 0);
    await assert.rejects(call(1, '/v1/chat', { message: '' }), (e: any) => e.status === 400);
  } finally { await svc.close(); svc.store.close(); }
});
test('without a model the service still answers using rules, and a failing model falls back', async () => {
  const svc = buildAssistant({ port: 0, secret, dbFile: ':memory:', core: fakeCore(), llm: null }); const r: any = await svc.chat({ id: 1, wid: 1 }, 'what subscriptions am I paying for?'); assert.equal(r.engine, 'rules'); assert.match(r.reply, /Netflix/); assert.equal((await svc.chat({ id: 1, wid: 1 }, 'hello')).reply.startsWith('Hi Asha'), true);
  const broken: Llm = { name: 'broken', plan: async () => { throw new Error('boom'); }, compose: async () => { throw new Error('boom'); }, close: async () => {} }; const svc2 = buildAssistant({ port: 0, secret, dbFile: ':memory:', core: fakeCore(), llm: broken });
  const r2: any = await svc2.chat({ id: 1, wid: 1 }, 'what subscriptions am I paying for?'); assert.match(r2.reply, /Netflix/); svc.store.close(); svc2.store.close();
});
test('follow-ups keep the previous answer\'s resolved dates and can step back from them', () => {
  const prev = { ...normalizePlan(P({ intent: 'spending', category: 'dining', period: 'last month' }))!, from: '2026-09-01', to: '2026-09-30' };
  assert.deepEqual(toCalls('what about uber', normalizePlan(P({ intent: 'spending', merchant: 'uber' }))!, prev, ent).calls[0].input, { from: '2026-09-01', to: '2026-09-30', merchant: 'Uber' });
  assert.deepEqual(toCalls('and the month before?', normalizePlan(P({ intent: 'spending' }))!, prev, ent).calls[0].input, { from: '2026-08-01', to: '2026-08-31', category: 'Dining' });
});

test('by default the model plans but does not write the answer: facts are rendered from templates', async () => {
  let composed = 0; const llm: Llm = { name: 'stub', plan: async () => P({ intent: 'subscriptions' }), compose: async () => { composed++; return 'You pay for 7 subscriptions.'; }, close: async () => {} };
  const svc = buildAssistant({ port: 0, secret, dbFile: ':memory:', core: fakeCore(), llm }); const r: any = await svc.chat({ id: 1, wid: 1 }, 'what do I pay for?'); assert.equal(composed, 0); assert.match(r.reply, /You have \*\*2\*\* subscriptions/); assert.equal(r.engine, 'stub'); svc.store.close();
});

test('income questions get an income answer, not an expense list', () => {
  assert.equal(guard('and how much did I receive?', 'transactions').intent, 'income'); assert.equal(guard('what is my salary credited this month', 'spending').intent, 'income');
  assert.match(renderFacts([{ name: 'spending_summary', result: { from: '2026-10-01', to: '2026-10-31', spent: '₹1.00', income: '₹5,000.00' } }], '', 'income'), /You received \*\*₹5,000\.00\*\*/);
});
