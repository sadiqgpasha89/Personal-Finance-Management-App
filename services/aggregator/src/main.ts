import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { createService, HttpError } from '../../../packages/shared/src/server.ts';
import type { Route } from '../../../packages/shared/src/server.ts';
import { env } from '../../../packages/shared/src/index.ts';
import { kidOf, newRsa, verifyDetached } from './crypto.ts';
import { Fiu } from './fiu.ts';
import { AA_HANDLES, SANDBOX_FIPS } from './fip-data.ts';
import { sandboxRoutes } from './sandbox/aa.ts';

export function buildAggregator(o: { port: number; secret: string; dataDir: string; mode: 'sandbox' | 'live'; publicUrl: string; allowedRedirectOrigins: string[]; aaBaseUrl?: string; fiuId?: string; apiKey?: string; privatePem?: string; aaPublicPem?: string; redirectTemplate?: string; now?: () => Date }) {
  fs.mkdirSync(o.dataDir, { recursive: true }); const db = new DatabaseSync(path.join(o.dataDir, 'aggregator.db')); db.exec('PRAGMA journal_mode=WAL');
  // Only consent metadata lives here. Account and transaction data is fetched on demand and returned to the caller, never stored.
  db.exec(`CREATE TABLE IF NOT EXISTS consents(id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, wid INTEGER NOT NULL, aa_handle TEXT NOT NULL, handle TEXT NOT NULL UNIQUE, consent_id TEXT, status TEXT NOT NULL, mobile_masked TEXT, created_at TEXT NOT NULL, expires_at TEXT, last_sync_at TEXT, range_from TEXT)`);
  let privatePem = o.privatePem, publicPem = ''; const keyFile = path.join(o.dataDir, 'fiu-key.json');
  if (!privatePem) { if (o.mode === 'live') throw new Error('FIU_PRIVATE_KEY_PEM is required in live mode'); if (fs.existsSync(keyFile)) ({ privatePem, publicPem } = JSON.parse(fs.readFileSync(keyFile, 'utf8'))); else { const k = newRsa(); privatePem = k.privatePem; publicPem = k.publicPem; fs.writeFileSync(keyFile, JSON.stringify(k), { mode: 0o600 }); } }
  const { createPublicKey, createPrivateKey } = require_crypto(); if (!publicPem) publicPem = createPublicKey(createPrivateKey(privatePem!)).export({ type: 'spki', format: 'pem' }) as string;
  const apiKey = o.apiKey ?? 'sandbox-api-key'; const fiuId = o.fiuId ?? 'LEDGERLY-FIU';
  const sandbox = o.mode === 'sandbox' ? sandboxRoutes({ fiuApiKey: apiKey, fiuPublicPem: publicPem, fiuWebhook: `http://127.0.0.1:${o.port}/v1/webhooks/aa/consent`, allowedRedirectOrigins: o.allowedRedirectOrigins, now: o.now }) : null;
  const aaBase = o.aaBaseUrl ?? `http://127.0.0.1:${o.port}/sandbox-aa`;
  const fiu = new Fiu({ fiuId, apiKey, privatePem: privatePem!, kid: kidOf(publicPem), aaBaseUrl: aaBase, aaPublicPem: o.aaPublicPem ?? sandbox?.publicPem });
  const mine = (userId: number | undefined, id: string) => { const r = db.prepare('SELECT * FROM consents WHERE id=? AND user_id=?').get(id, userId ?? -1) as any; if (!r) throw new HttpError(404, 'not_found', 'Consent not found'); return r; };
  const view = (r: any) => ({ id: r.id, aa_handle: r.aa_handle, status: r.status, mobile_masked: r.mobile_masked, created_at: r.created_at, expires_at: r.expires_at, last_sync_at: r.last_sync_at });
  const wrap = async <T,>(f: () => Promise<T>) => { try { return await f(); } catch (e: any) { if (e instanceof HttpError) throw e; throw new HttpError(e.status && e.status < 500 ? e.status : 502, e.code ?? 'aa_error', e.message ?? 'Account Aggregator error'); } };
  const refresh = async (r: any) => {
    if (!['PENDING', 'ACTIVE'].includes(r.status)) return r; const s = await fiu.handleStatus(r.handle);
    const status = s.status === 'APPROVED' ? 'ACTIVE' : s.status === 'PENDING' ? 'PENDING' : 'REJECTED';
    if (status !== r.status || s.consentId !== r.consent_id) db.prepare('UPDATE consents SET status=?, consent_id=? WHERE id=?').run(status, s.consentId, r.id); return { ...r, status, consent_id: s.consentId };
  };
  const routes: Route[] = [
    { method: 'GET', path: '/v1/providers', handler: () => ({ mode: o.mode, aa_handles: AA_HANDLES, banks: o.mode === 'sandbox' ? SANDBOX_FIPS.map((f) => ({ id: f.id, name: f.name })) : [], sandbox_otp: o.mode === 'sandbox' ? '123456' : undefined }) },
    { method: 'GET', path: '/v1/consents', handler: (c) => ({ items: (db.prepare('SELECT * FROM consents WHERE user_id=? ORDER BY created_at DESC').all(c.claims!.sub!) as any[]).map(view) }) },
    { method: 'POST', path: '/v1/consents', handler: (c) => wrap(async () => {
      const b = c.body; if (!/^[6-9]\d{9}$/.test(String(b.mobile ?? ''))) throw new HttpError(400, 'validation', 'Enter a 10-digit Indian mobile number', { mobile: 'Invalid' });
      if (!AA_HANDLES.some((h) => h.handle === b.aa_handle)) throw new HttpError(400, 'validation', 'Choose an Account Aggregator', { aa_handle: 'Unknown' });
      if (!b.redirect_url || !o.allowedRedirectOrigins.includes(new URL(b.redirect_url).origin)) throw new HttpError(400, 'validation', 'Redirect URL is not allowed', { redirect_url: 'Not allowed' });
      const months = Math.min(24, Math.max(1, Number(b.months) || 6)); const r = await fiu.createConsent({ mobile: b.mobile, handle: b.aa_handle, months, now: o.now?.() });
      const id = randomUUID(); db.prepare('INSERT INTO consents(id,user_id,wid,aa_handle,handle,status,mobile_masked,created_at,expires_at,range_from) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, c.claims!.sub!, c.claims!.wid ?? 0, b.aa_handle, r.handle, 'PENDING', `${b.mobile.slice(0, 2)}XXXXXX${b.mobile.slice(-2)}`, (o.now?.() ?? new Date()).toISOString(), r.expires_at, r.range_from);
      const approval = o.mode === 'sandbox' ? `${o.publicUrl}/sandbox-aa/approve?handle=${r.handle}&redirect=${encodeURIComponent(b.redirect_url)}` : (o.redirectTemplate ?? '').replace('{handle}', r.handle).replace('{redirect}', encodeURIComponent(b.redirect_url));
      return { id, status: 'PENDING', approval_url: approval };
    }) },
    { method: 'GET', path: '/v1/consents/:id', handler: (c) => wrap(async () => view(await refresh(mine(c.claims!.sub, c.params[0])))) },
    { method: 'POST', path: '/v1/consents/:id/fetch', handler: (c) => wrap(async () => {
      const r = await refresh(mine(c.claims!.sub, c.params[0])); if (r.status !== 'ACTIVE' || !r.consent_id) throw new HttpError(409, 'consent_not_active', `Consent is ${r.status.toLowerCase()}; approve it in your Account Aggregator first`);
      const to = (o.now?.() ?? new Date()).toISOString().slice(0, 10); const wanted = String(c.body.from ?? new Date((o.now?.() ?? new Date()).getTime() - 120 * 86400000).toISOString().slice(0, 10)); const from = r.range_from && wanted < r.range_from.slice(0, 10) ? r.range_from.slice(0, 10) : wanted;
      const accounts = await fiu.fetchAccounts(r.consent_id, { from: `${from}T00:00:00.000Z`, to: `${to}T23:59:59.000Z` });
      const at = (o.now?.() ?? new Date()).toISOString(); db.prepare('UPDATE consents SET last_sync_at=? WHERE id=?').run(at, r.id); return { fetched_at: at, accounts };
    }) },
    { method: 'DELETE', path: '/v1/consents/:id', handler: (c) => wrap(async () => { const r = mine(c.claims!.sub, c.params[0]); if (r.consent_id && o.mode === 'sandbox') await fiu.revoke(r.consent_id).catch(() => {}); db.prepare("UPDATE consents SET status='REVOKED' WHERE id=?").run(r.id); return { ok: true, note: o.mode === 'live' ? 'Also revoke the consent in your Account Aggregator app to stop data flowing.' : undefined }; }) },
    { method: 'POST', path: '/v1/webhooks/aa/consent', auth: 'none', handler: (c) => {
      if (!sandbox || !verifyDetached(c.raw, c.req.headers['x-jws-signature'] as string, o.aaPublicPem ?? sandbox.publicPem)) throw new HttpError(401, 'bad_signature', 'Invalid notification signature');
      const n = c.body.ConsentStatusNotification; if (!n?.consentHandle) throw new HttpError(400, 'bad_request', 'Malformed notification');
      db.prepare('UPDATE consents SET status=?, consent_id=COALESCE(?,consent_id) WHERE handle=?').run(n.consentStatus === 'ACTIVE' ? 'ACTIVE' : n.consentStatus, n.consentId ?? null, n.consentHandle); return { ok: true };
    } },
    ...(sandbox?.routes ?? []),
  ];
  const svc = createService({ name: 'aggregator', port: o.port, secret: o.secret, routes, ready: () => { try { db.prepare('SELECT 1').get(); return true; } catch { return false; } }, onClose: () => db.close() });
  return { ...svc, db, fiu };
}
import { createRequire } from 'node:module';
function require_crypto() { return createRequire(import.meta.url)('node:crypto') as typeof import('node:crypto'); }

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const port = Number(env('PORT', '3201')); const mode = env('AA_MODE', 'sandbox') as 'sandbox' | 'live';
  const svc = buildAggregator({ port, secret: env('INTERNAL_API_SECRET'), dataDir: env('DATA_DIR', './data'), mode, publicUrl: env('PUBLIC_URL', `http://localhost:${port}`), allowedRedirectOrigins: env('ALLOWED_REDIRECT_ORIGINS', 'http://localhost:3100').split(','),
    aaBaseUrl: process.env.AA_BASE_URL, fiuId: process.env.FIU_ID, apiKey: process.env.FIU_API_KEY, privatePem: process.env.FIU_PRIVATE_KEY_PEM?.replace(/\\n/g, '\n'), aaPublicPem: process.env.AA_PUBLIC_KEY_PEM?.replace(/\\n/g, '\n'), redirectTemplate: process.env.AA_REDIRECT_TEMPLATE });
  svc.installSignals(); svc.listen();
}
