import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildAggregator } from './main.ts';
import { callService } from '../../../packages/shared/src/client.ts';
import { decryptFI, encryptFI, newKeyMaterial, newRsa, signDetached, verifyDetached } from './crypto.ts';
import { depositFI, SANDBOX_FIPS } from './fip-data.ts';
import { normalizeDeposit } from './normalize.ts';
import { SANDBOX_OTP } from './sandbox/aa.ts';

const secret = 'test-secret-0123456789'; const CORE = 'http://localhost:3100';
test('ECDH + HKDF + AES-GCM round trip, and tampering fails', () => {
  const fiu = newKeyMaterial(), fip = newKeyMaterial(); const enc = encryptFI('{"hello":"world"}', fip, fiu.publicKey, fiu.nonce);
  assert.equal(decryptFI(enc, fiu, fip.publicKey, fip.nonce), '{"hello":"world"}');
  const bad = Buffer.from(enc, 'base64'); bad[0] ^= 1; assert.throws(() => decryptFI(bad.toString('base64'), fiu, fip.publicKey, fip.nonce));
  assert.throws(() => decryptFI(enc, newKeyMaterial(), fip.publicKey, fip.nonce)); assert.throws(() => decryptFI(enc, fiu, fip.publicKey, newKeyMaterial().nonce));
});
test('detached JWS signs the body and rejects changes', () => {
  const k = newRsa(); const body = '{"a":1}'; const sig = signDetached(body, k.privatePem, 'kid1'); assert.match(sig, /^[\w-]+\.\.[\w-]+$/);
  assert.equal(verifyDetached(body, sig, k.publicPem), true); assert.equal(verifyDetached('{"a":2}', sig, k.publicPem), false); assert.equal(verifyDetached(body, sig, newRsa().publicPem), false); assert.equal(verifyDetached(body, undefined, k.publicPem), false);
});
test('synthetic FI data is internally consistent and normalizes to signed paise', () => {
  const today = new Date('2026-10-30T00:00:00Z'); const { fi, opening, closing } = depositFI('9876543210', SANDBOX_FIPS[0], today);
  const a = normalizeDeposit('HDFC-FIP', 'HDFC Bank', 'ref', fi); assert.ok(a.txns.length > 50); assert.equal(a.balance, closing);
  assert.equal(a.opening_balance + a.txns.reduce((s, t) => s + t.amount, 0), a.balance); assert.equal(a.opening_balance, opening);
  let bal = opening; for (const t of a.txns) { bal += t.amount; assert.equal(t.balance, bal); } assert.ok(a.txns.some((t) => t.amount > 0) && a.txns.some((t) => t.amount < 0) && a.txns.some((t) => /^UPI\//.test(t.narration)));
  assert.deepEqual(depositFI('9876543210', SANDBOX_FIPS[0], today).fi, fi);                   // deterministic
  assert.throws(() => normalizeDeposit('x', 'x', 'r', { Account: { Summary: { currentBalance: '1', type: 'SAVINGS' }, Transactions: { Transaction: [{ type: 'WEIRD', amount: '1', txnId: '1' }] } } }));
});
test('full consent and data-fetch flow through the HTTP API, with isolation between users', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-')); const port = 38201 + Math.floor(Math.random() * 500);
  const svc = buildAggregator({ port, secret, dataDir: dir, mode: 'sandbox', publicUrl: `http://127.0.0.1:${port}`, allowedRedirectOrigins: [CORE] }); await svc.listen();
  const as = (id: number) => <T>(p: string, body?: unknown, method?: string) => callService<T>({ baseUrl: `http://127.0.0.1:${port}`, audience: 'aggregator', issuer: 'core', secret, path: p, body, method, user: { id, wid: 1 } });
  const u1 = as(1), u2 = as(2);
  try {
    await assert.rejects(u1('/v1/consents', { mobile: '12345', aa_handle: 'anumati', redirect_url: CORE + '/connections' }), (e: any) => e.status === 400);
    await assert.rejects(u1('/v1/consents', { mobile: '9876543210', aa_handle: 'anumati', redirect_url: 'https://evil.test/x' }), (e: any) => e.status === 400);
    const c: any = await u1('/v1/consents', { mobile: '9876543210', aa_handle: 'anumati', months: 3, redirect_url: CORE + '/connections' }); assert.equal(c.status, 'PENDING'); assert.match(c.approval_url, /sandbox-aa\/approve/);
    await assert.rejects(u1(`/v1/consents/${c.id}/fetch`, {}), (e: any) => e.status === 409);            // not approved yet
    await assert.rejects(u2(`/v1/consents/${c.id}`), (e: any) => e.status === 404);                       // another user cannot see it
    const page = await fetch(c.approval_url).then((r) => r.text()); assert.match(page, /Sandbox/); assert.match(page, /HDFC Bank/);
    const handle = new URL(c.approval_url).searchParams.get('handle')!; const post = (body: Record<string, string | string[]>) => fetch(`http://127.0.0.1:${port}/sandbox-aa/approve`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(Object.entries(body).flatMap(([k, v]) => ([] as string[]).concat(v).map((x) => [k, x]))) });
    assert.equal((await post({ handle, redirect: CORE + '/connections', decision: 'approve', otp: '000000', acc: ['HDFC-FIP'] })).status, 400);                  // wrong OTP
    assert.equal((await post({ handle, redirect: 'https://evil.test', decision: 'approve', otp: SANDBOX_OTP, acc: ['HDFC-FIP'] })).status, 400);               // open redirect blocked
    const ok = await post({ handle, redirect: CORE + '/connections', decision: 'approve', otp: SANDBOX_OTP, acc: ['HDFC-FIP', 'SBI-FIP'] }); assert.equal(ok.status, 302); assert.match(ok.headers.get('location')!, /consent=.*result=active/);
    await new Promise((r) => setTimeout(r, 150)); assert.equal(((await u1(`/v1/consents/${c.id}`)) as any).status, 'ACTIVE');
    const data: any = await u1(`/v1/consents/${c.id}/fetch`, {}); assert.equal(data.accounts.length, 2); const a = data.accounts[0];
    assert.equal(a.opening_balance + a.txns.reduce((s: number, t: any) => s + t.amount, 0), a.balance); assert.ok(a.txns.length > 40); assert.equal(a.currency, 'INR');
    assert.equal(((await u1('/v1/consents')) as any).items.length, 1); assert.equal(((await u2('/v1/consents')) as any).items.length, 0);
    await u1(`/v1/consents/${c.id}`, undefined, 'DELETE'); assert.equal(((await u1(`/v1/consents/${c.id}`)) as any).status, 'REVOKED'); await assert.rejects(u1(`/v1/consents/${c.id}/fetch`, {}), (e: any) => e.status === 409);
    // no financial data is persisted by the service
    const tables = svc.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]; assert.deepEqual(tables.map((t) => t.name).filter((n) => !n.startsWith('sqlite_')), ['consents']);
  } finally { await svc.close(); svc.db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('the webhook rejects unsigned notifications', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-')); const port = 38801 + Math.floor(Math.random() * 500);
  const svc = buildAggregator({ port, secret, dataDir: dir, mode: 'sandbox', publicUrl: `http://127.0.0.1:${port}`, allowedRedirectOrigins: [CORE] }); await svc.listen();
  try { const r = await fetch(`http://127.0.0.1:${port}/v1/webhooks/aa/consent`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ConsentStatusNotification: { consentHandle: 'x', consentStatus: 'ACTIVE' } }) }); assert.equal(r.status, 401); }
  finally { await svc.close(); svc.db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
