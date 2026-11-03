import test from 'node:test';
import assert from 'node:assert/strict';
import { signToken, verifyToken, createService, callService, HttpError, ServiceError } from './index.ts';

const secret = 'test-secret-0123456789';
test('tokens verify only for the right audience, secret and time', () => {
  const t = signToken(secret, { iss: 'core', aud: 'aggregator', sub: 7, wid: 9 }, 60, 1_000_000);
  assert.deepEqual({ ...verifyToken(secret, t, 'aggregator', 1_030_000)! }, { iss: 'core', aud: 'aggregator', sub: 7, wid: 9, iat: 1000, exp: 1060 });
  assert.equal(verifyToken(secret, t, 'bureau', 1_030_000), null); assert.equal(verifyToken('other-secret-0123456789', t, 'aggregator', 1_030_000), null);
  assert.equal(verifyToken(secret, t, 'aggregator', 1_100_000), null); assert.equal(verifyToken(secret, t.slice(0, -2) + 'xx', 'aggregator', 1_030_000), null); assert.equal(verifyToken(secret, 'garbage', 'aggregator'), null);
  assert.throws(() => signToken('short', { iss: 'a', aud: 'b' }));
});
test('a service enforces auth, validates JSON, caps bodies and reports health', async () => {
  const svc = createService({ name: 'demo', port: 0, secret, maxBody: 50, routes: [
    { method: 'POST', path: '/v1/echo', handler: (c) => ({ you: c.claims?.sub, got: c.body }) }, { method: 'GET', path: '/v1/boom', handler: () => { throw new HttpError(409, 'conflict', 'nope'); } },
    { method: 'GET', path: '/public', auth: 'none', handler: () => ({ hi: 1 }) }, { method: 'GET', path: '/v1/crash', handler: () => { throw new Error('secret detail'); } } ] });
  await new Promise<void>((r) => svc.server.listen(0, r)); const port = (svc.server.address() as any).port; const base = `http://127.0.0.1:${port}`;
  const call = (path: string, body?: unknown, user = { id: 5, wid: 1 }) => callService<any>({ baseUrl: base, audience: 'demo', issuer: 'test', secret, path, body, user });
  assert.deepEqual(await call('/v1/echo', { a: 1 }), { you: 5, got: { a: 1 } });
  assert.equal((await fetch(base + '/healthz').then((r) => r.json())).ok, true); assert.equal((await fetch(base + '/public').then((r) => r.json())).hi, 1);
  assert.equal((await fetch(base + '/v1/echo', { method: 'POST', body: '{}' })).status, 401);
  await assert.rejects(call('/v1/boom'), (e: ServiceError) => e.status === 409 && e.code === 'conflict');
  await assert.rejects(call('/v1/crash'), (e: ServiceError) => e.status === 500 && !e.message.includes('secret detail'));
  await assert.rejects(call('/v1/echo', { big: 'x'.repeat(200) }), (e: ServiceError) => e.status === 413);
  const bad = await fetch(base + '/v1/echo', { method: 'POST', headers: { authorization: 'Bearer ' + (await import('./svcauth.ts')).signToken(secret, { iss: 't', aud: 'demo' }), 'content-type': 'application/json' }, body: '{nope' }); assert.equal(bad.status, 400);
  await svc.close();
  await assert.rejects(callService({ baseUrl: base, audience: 'demo', issuer: 't', secret, path: '/v1/echo', body: {}, timeoutMs: 500 }), (e: ServiceError) => e.status === 503);
});
