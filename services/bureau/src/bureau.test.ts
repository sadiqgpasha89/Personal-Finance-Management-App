import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBureau, validate } from './main.ts';
import { sandboxProvider, buildReport } from './providers.ts';
import { analyze, bandOf } from './analysis.ts';
import { callService } from '../../../packages/shared/src/client.ts';

const secret = 'test-secret-0123456789'; const good = { name: 'Asha Verma', dob: '1990-05-17', pan: 'ABCPE1234F', mobile: '9876543210', consent: { given: true, text_version: 'v1' } };
test('input validation: PAN shape and entity type, age, mobile, consent', () => {
  assert.deepEqual(validate(good, '2026-11-01'), { name: 'Asha Verma', pan: 'ABCPE1234F', mobile: '9876543210', dob: '1990-05-17' });
  for (const [k, v] of [['pan', 'ABCDE1234F'], ['pan', 'abc'], ['mobile', '12345'], ['dob', '2015-01-01'], ['dob', 'nope'], ['name', '1'], ['consent', { given: false }]] as const)
    assert.throws(() => validate({ ...good, [k]: v }, '2026-11-01'), (e: any) => e.status === 400 && k in e.fields);
  assert.equal(validate({ ...good, pan: 'abcpe1234f' }, '2026-11-01').pan, 'ABCPE1234F');
});
test('bands and the transparent factor analysis behave sensibly', () => {
  assert.deepEqual([300, 549, 550, 649, 650, 749, 750, 799, 800, 900].map(bandOf), ['poor', 'poor', 'fair', 'fair', 'good', 'good', 'very_good', 'very_good', 'excellent', 'excellent']);
  const tl = (util: number, dpd: number[], opened = '2018-01-01') => [{ type: 'credit_card' as const, lender: 'X', opened, limit_or_amount: 100000, balance: util * 100000, overdue: 0, status: 'active' as const, dpd_history: dpd }];
  const clean = analyze(tl(0.1, Array(24).fill(0)), [], '2026-11-01'), maxed = analyze(tl(0.95, Array(24).fill(0)), [], '2026-11-01'), late = analyze(tl(0.1, [0, 90, ...Array(22).fill(0)]), [], '2026-11-01');
  assert.ok(clean.estimate > maxed.estimate && clean.estimate > late.estimate); assert.equal(clean.factors.find((f) => f.id === 'utilization')!.status, 'good'); assert.equal(maxed.factors.find((f) => f.id === 'utilization')!.status, 'poor'); assert.equal(late.factors.find((f) => f.id === 'payment')!.status, 'poor');
  assert.ok(clean.estimate >= 300 && clean.estimate <= 900); assert.equal(analyze([], [], '2026-11-01').summary.accounts, 0);
});
test('sandbox reports are deterministic, labelled as samples, and keep only the last 4 of the PAN', async () => {
  const a = await buildReport(sandboxProvider, good, '2026-11-01'), b = await buildReport(sandboxProvider, good, '2026-11-01'); assert.deepEqual({ ...a, generated_at: '' }, { ...b, generated_at: '' });
  assert.equal(a.sample, true); assert.match(a.score.model, /not a real/i); assert.equal(a.subject.pan_last4, '234F'); assert.ok(!JSON.stringify(a).includes('ABCPE')); assert.equal(a.factors.length, 5);
  const scores = new Set(); for (const p of ['ABCPE1111A', 'ABCPE2222B', 'ABCPE3333C', 'ABCPE4444D', 'ABCPE5555E', 'ABCPE6666F']) scores.add((await buildReport(sandboxProvider, { ...good, pan: p }, '2026-11-01')).score.value); assert.ok(scores.size >= 4);
});
test('the service authenticates, rate-limits per user, and does not leak provider errors', async () => {
  let t = 1_700_000_000_000; const svc = buildBureau({ port: 0, secret, provider: sandboxProvider, cooldownSeconds: 60, now: () => new Date(t) }); await new Promise<void>((r) => svc.server.listen(0, r)); const port = (svc.server.address() as any).port;
  const call = (uid: number, body: unknown) => callService<any>({ baseUrl: `http://127.0.0.1:${port}`, audience: 'bureau', issuer: 'core', secret, path: '/v1/reports', body, user: { id: uid, wid: 1 } });
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/reports`, { method: 'POST', body: '{}' })).status, 401);
    const r = await call(1, good); assert.equal(r.report.sample, true); await assert.rejects(call(1, good), (e: any) => e.status === 429); assert.ok((await call(2, good)).report); t += 61_000; assert.ok((await call(1, good)).report);
    await assert.rejects(call(3, { ...good, consent: undefined }), (e: any) => e.status === 400 && !!e.fields.consent);
  } finally { await svc.close(); }
  const bad = buildBureau({ port: 0, secret, provider: { name: 'x', sample: false, fetch: async () => { throw new Error('upstream said PAN ABCPE1234F is invalid'); } }, cooldownSeconds: 0 }); await new Promise<void>((r) => bad.server.listen(0, r)); const p2 = (bad.server.address() as any).port;
  try { await assert.rejects(callService({ baseUrl: `http://127.0.0.1:${p2}`, audience: 'bureau', issuer: 'core', secret, path: '/v1/reports', body: good, user: { id: 1, wid: 1 } }), (e: any) => e.status === 502 && !e.message.includes('ABCPE')); } finally { await bad.close(); }
});
