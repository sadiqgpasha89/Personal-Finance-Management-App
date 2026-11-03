import { randomUUID } from 'node:crypto';
import { HttpError } from '../../../../packages/shared/src/server.ts';
import type { Route } from '../../../../packages/shared/src/server.ts';
import { encryptFI, newKeyMaterial, newRsa, kidOf, signDetached, verifyDetached } from '../crypto.ts';
import { AA_HANDLES, SANDBOX_FIPS, depositFI } from '../fip-data.ts';

/**
 * A stand-in Account Aggregator + FIPs speaking the same HTTP shapes as a real AA, so the FIU client, signing and encryption are exercised end to end
 * without credentials. State is in memory (restarting forgets consents) and the data is synthetic. The sandbox OTP is 123456.
 */
export const SANDBOX_OTP = '123456';
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
interface C { handle: string; id: string; customer: string; detail: any; status: 'PENDING' | 'ACTIVE' | 'REJECTED' | 'REVOKED'; accounts: string[]; txnid: string }

export function sandboxRoutes(cfg: { fiuApiKey: string; fiuPublicPem: string; fiuWebhook: string; allowedRedirectOrigins: string[]; now?: () => Date }) {
  const aa = newRsa(); const kid = kidOf(aa.publicPem); const consents = new Map<string, C>(); const byId = new Map<string, C>(); const sessions = new Map<string, { consent: C; fiuPub: string; fiuNonce: string; range: { from: string; to: string } }>();
  const now = () => cfg.now?.() ?? new Date(); const stamp = () => now().toISOString();
  const raw = (c: { raw: string }) => c.raw;
  const guard = (c: { req: any; body: any; raw: string }) => {
    if (c.req.headers['client_api_key'] !== cfg.fiuApiKey) throw new HttpError(401, 'bad_api_key', 'Invalid client_api_key');
    if (!verifyDetached(raw(c), c.req.headers['x-jws-signature'], cfg.fiuPublicPem)) throw new HttpError(401, 'bad_signature', 'Invalid x-jws-signature');
  };
  const redirectOk = (u: string) => { try { return cfg.allowedRedirectOrigins.includes(new URL(u).origin); } catch { return false; } };
  const page = (inner: string) => ({ __html: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sandbox Account Aggregator</title><style>body{font:15px system-ui;max-width:30rem;margin:2rem auto;padding:0 1rem;color:#141821}.b{background:#fff4dd;border:1px solid #d9a441;padding:.6rem .8rem;border-radius:8px;font-size:13px}label{display:block;margin:.5rem 0}input[type=text]{padding:.5rem;border:1px solid #c9ced8;border-radius:6px;width:8rem}button{padding:.6rem 1rem;border-radius:8px;border:0;background:#146e5a;color:#fff;font-weight:600;cursor:pointer}.s{background:#fff;color:#146e5a;border:1px solid #146e5a}</style><body>${inner}` });

  const routes: Route[] = [
    { method: 'GET', path: '/sandbox-aa/keys', auth: 'none', handler: () => ({ kid, publicPem: aa.publicPem }) },
    { method: 'POST', path: '/sandbox-aa/Consent', auth: 'none', handler: (c) => {
      guard(c); const d = c.body.ConsentDetail; if (!d?.Customer?.id || !/^\d{10}@[a-z]+$/.test(d.Customer.id)) throw new HttpError(400, 'bad_customer', 'Customer.id must look like 9999999999@handle');
      const handle = d.Customer.id.split('@')[1]; if (!AA_HANDLES.some((h) => h.handle === handle)) throw new HttpError(400, 'unknown_handle', `Unknown AA handle ${handle}`);
      if (!d.FIDataRange?.from || !d.FIDataRange?.to || !(d.fiTypes ?? []).includes('DEPOSIT')) throw new HttpError(400, 'bad_consent', 'DEPOSIT FI type and FIDataRange are required');
      const ch = randomUUID(); const rec: C = { handle: ch, id: randomUUID(), customer: d.Customer.id.split('@')[0], detail: d, status: 'PENDING', accounts: [], txnid: c.body.txnid }; consents.set(ch, rec); byId.set(rec.id, rec);
      return { ver: '2.0.0', timestamp: stamp(), txnid: c.body.txnid, Customer: { id: d.Customer.id }, ConsentHandle: ch };
    } },
    { method: 'GET', path: '/sandbox-aa/Consent/handle/:h', auth: 'none', handler: (c) => {
      if (c.req.headers['client_api_key'] !== cfg.fiuApiKey) throw new HttpError(401, 'bad_api_key', 'Invalid client_api_key'); const r = consents.get(c.params[0]); if (!r) throw new HttpError(404, 'not_found', 'Unknown consent handle');
      return { ver: '2.0.0', timestamp: stamp(), txnid: r.txnid, ConsentHandle: r.handle, ConsentStatus: { id: r.status === 'ACTIVE' ? r.id : null, status: r.status === 'ACTIVE' ? 'APPROVED' : r.status === 'PENDING' ? 'PENDING' : 'REJECTED' } };
    } },
    { method: 'GET', path: '/sandbox-aa/Consent/:id', auth: 'none', handler: (c) => {
      if (c.req.headers['client_api_key'] !== cfg.fiuApiKey) throw new HttpError(401, 'bad_api_key', 'Invalid client_api_key'); const r = byId.get(c.params[0]); if (!r) throw new HttpError(404, 'not_found', 'Unknown consent');
      const body = { ver: '2.0.0', timestamp: stamp(), txnid: r.txnid, consentId: r.id, status: r.status, createTimestamp: stamp(), ConsentDetail: r.detail, accounts: r.accounts };
      return { ...body, signedConsent: signDetached(JSON.stringify(r.detail), aa.privatePem, kid) };
    } },
    { method: 'POST', path: '/sandbox-aa/Consent/revoke', auth: 'none', handler: (c) => { guard(c); const r = byId.get(c.body.consentId); if (!r) throw new HttpError(404, 'not_found', 'Unknown consent'); r.status = 'REVOKED'; return { ok: true }; } },
    { method: 'POST', path: '/sandbox-aa/FI/request', auth: 'none', handler: (c) => {
      guard(c); const r = byId.get(c.body.Consent?.id); if (!r || r.status !== 'ACTIVE') throw new HttpError(403, 'consent_not_active', 'Consent is not active');
      if (!verifyDetached(JSON.stringify(r.detail), c.body.Consent.digitalSignature, aa.publicPem)) throw new HttpError(403, 'bad_consent_signature', 'Consent signature does not verify');
      const k = c.body.KeyMaterial; if (k?.curve !== 'Curve25519' || !k?.DHPublicKey?.KeyValue || !k?.Nonce) throw new HttpError(400, 'bad_key_material', 'Curve25519 key material required');
      const range = c.body.FIDataRange ?? r.detail.FIDataRange; if (range.from.slice(0, 10) < r.detail.FIDataRange.from.slice(0, 10) || range.to.slice(0, 10) > r.detail.FIDataRange.to.slice(0, 10)) throw new HttpError(400, 'range_outside_consent', 'FIDataRange is outside the consented range');
      const sid = randomUUID(); sessions.set(sid, { consent: r, fiuPub: k.DHPublicKey.KeyValue, fiuNonce: k.Nonce, range }); return { ver: '2.0.0', timestamp: stamp(), txnid: c.body.txnid, consentId: r.id, sessionId: sid };
    } },
    { method: 'GET', path: '/sandbox-aa/FI/fetch/:sid', auth: 'none', handler: (c) => {
      if (c.req.headers['client_api_key'] !== cfg.fiuApiKey) throw new HttpError(401, 'bad_api_key', 'Invalid client_api_key'); const s = sessions.get(c.params[0]); if (!s) throw new HttpError(404, 'not_found', 'Unknown session');
      const out = s.consent.accounts.map((fipId) => SANDBOX_FIPS.find((f) => f.id === fipId)!).filter(Boolean).map((fip) => {
        const km = newKeyMaterial(); const { fi } = depositFI(s.consent.customer, fip, now(), 120);
        // honour the requested range
        fi.Account.Transactions.Transaction = fi.Account.Transactions.Transaction.filter((t: any) => t.valueDate >= s.range.from && t.valueDate <= s.range.to);
        return { fipID: fip.id, data: [{ linkRefNumber: fi.Account.linkedAccRef, maskedAccNumber: fi.Account.maskedAccNumber, encryptedFI: encryptFI(JSON.stringify(fi), km, s.fiuPub, s.fiuNonce) }], KeyMaterial: { cryptoAlg: 'ECDHE', curve: 'Curve25519', params: '', DHPublicKey: { expiry: new Date(now().getTime() + 3600e3).toISOString(), Parameter: '', KeyValue: km.publicKey }, Nonce: km.nonce } };
      });
      return { ver: '2.0.0', timestamp: stamp(), txnid: randomUUID(), FI: out };
    } },
    // ---- the customer-facing consent screen ----
    { method: 'GET', path: '/sandbox-aa/approve', auth: 'none', handler: (c) => {
      const r = consents.get(c.query.get('handle') ?? ''); if (!r) throw new HttpError(404, 'not_found', 'Unknown consent request'); const redirect = c.query.get('redirect') ?? ''; if (redirect && !redirectOk(redirect)) throw new HttpError(400, 'bad_redirect', 'Redirect not allowed');
      const d = r.detail; return page(`<h2>Sandbox Account Aggregator</h2><p class="b"><b>Sandbox.</b> No real bank is involved and the accounts below are synthetic. OTP: <code>${SANDBOX_OTP}</code>.</p>
        <p><b>${esc(d.DataConsumer.id)}</b> asks to read <b>${esc(d.fiTypes.join(', ').toLowerCase())}</b> data (${esc(d.consentTypes.join(', ').toLowerCase())}) from <b>${esc(d.FIDataRange.from.slice(0, 10))}</b> to <b>${esc(d.FIDataRange.to.slice(0, 10))}</b>,
        for: <i>${esc(d.Purpose.text)}</i>. Consent expires ${esc(d.consentExpiry.slice(0, 10))}. You can revoke it any time.</p>
        <form method="post" action="/sandbox-aa/approve"><input type="hidden" name="handle" value="${esc(r.handle)}"><input type="hidden" name="redirect" value="${esc(redirect)}">
        ${SANDBOX_FIPS.map((f) => `<label><input type="checkbox" name="acc" value="${esc(f.id)}" checked> ${esc(f.name)} (${f.type.toLowerCase()} account)</label>`).join('')}
        <label>OTP sent to ${esc(r.customer.slice(0, 2))}XXXXXX${esc(r.customer.slice(-2))} <input type="text" name="otp" inputmode="numeric" autocomplete="one-time-code"></label>
        <button type="submit" name="decision" value="approve">Approve</button> <button class="s" type="submit" name="decision" value="reject">Deny</button></form>`);
    } },
    { method: 'POST', path: '/sandbox-aa/approve', auth: 'none', handler: async (c) => {
      const b = c.body as Record<string, any>; const r = consents.get(String(b.handle)); if (!r || r.status !== 'PENDING') throw new HttpError(400, 'bad_request', 'This consent request is not pending');
      const redirect = String(b.redirect ?? ''); if (redirect && !redirectOk(redirect)) throw new HttpError(400, 'bad_redirect', 'Redirect not allowed');
      if (b.decision === 'approve') { if (b.otp !== SANDBOX_OTP) throw new HttpError(400, 'bad_otp', 'Incorrect OTP'); const acc = ([] as string[]).concat(b.acc ?? []); if (!acc.length) throw new HttpError(400, 'no_accounts', 'Choose at least one account'); r.accounts = acc.filter((a) => SANDBOX_FIPS.some((f) => f.id === a)); r.status = 'ACTIVE'; }
      else r.status = 'REJECTED';
      const note = JSON.stringify({ ver: '2.0.0', timestamp: stamp(), txnid: randomUUID(), Notifier: { type: 'AA', id: 'sandbox-aa' }, ConsentStatusNotification: { consentId: r.status === 'ACTIVE' ? r.id : null, consentHandle: r.handle, consentStatus: r.status } });
      fetch(cfg.fiuWebhook, { method: 'POST', headers: { 'content-type': 'application/json', 'x-jws-signature': signDetached(note, aa.privatePem, kid) }, body: note }).catch(() => {});
      return redirect ? { __redirect: redirect + (redirect.includes('?') ? '&' : '?') + `consent=${encodeURIComponent(r.handle)}&result=${r.status.toLowerCase()}` } : page(`<p>Consent ${r.status.toLowerCase()}. You can close this window.</p>`);
    } },
  ];
  return { routes, publicPem: aa.publicPem };
}
