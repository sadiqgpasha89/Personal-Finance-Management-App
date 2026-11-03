import { randomUUID } from 'node:crypto';
import { decryptFI, newKeyMaterial, signDetached, verifyDetached } from './crypto.ts';
import type { KeyMaterial } from './crypto.ts';
import { normalizeDeposit } from './normalize.ts';
import type { NormAccount } from './normalize.ts';
import { SANDBOX_FIPS } from './fip-data.ts';

export interface FiuConfig { fiuId: string; apiKey: string; privatePem: string; kid: string; aaBaseUrl: string; aaPublicPem?: string }
const PURPOSE = { code: '102', refUri: 'https://api.rebit.org.in/aa/purpose/102.xml', text: 'Customer spending patterns, budget or other reportings', Category: { type: 'Personal Finance' } };

/** Financial Information User client: talks to an AA over the ReBIT HTTP API (consent, FI request, FI fetch) and decrypts what comes back. */
export class Fiu {
  cfg: FiuConfig;
  constructor(cfg: FiuConfig) { this.cfg = cfg; }
  private async call(path: string, body?: unknown) {
    const text = body !== undefined ? JSON.stringify(body) : undefined; const headers: Record<string, string> = { client_api_key: this.cfg.apiKey, ...(text ? { 'content-type': 'application/json', 'x-jws-signature': signDetached(text, this.cfg.privatePem, this.cfg.kid) } : {}) };
    const r = await fetch(this.cfg.aaBaseUrl + path, { method: text ? 'POST' : 'GET', headers, body: text, signal: AbortSignal.timeout(30_000) }); const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.message ?? `AA returned ${r.status}`), { status: r.status, code: j.code ?? 'aa_error' }); return j;
  }
  async createConsent(o: { mobile: string; handle: string; months: number; expiryMonths?: number; now?: Date }) {
    const now = o.now ?? new Date(); const exp = new Date(now.getTime() + (o.expiryMonths ?? 6) * 30 * 86400000); const from = new Date(now.getTime() - o.months * 30 * 86400000);
    const detail = { consentStart: now.toISOString(), consentExpiry: exp.toISOString(), consentMode: 'VIEW', fetchType: 'PERIODIC', consentTypes: ['TRANSACTIONS', 'PROFILE', 'SUMMARY'], fiTypes: ['DEPOSIT'], DataConsumer: { id: this.cfg.fiuId, type: 'FIU' }, Customer: { id: `${o.mobile}@${o.handle}` }, Purpose: PURPOSE,
      FIDataRange: { from: from.toISOString(), to: exp.toISOString() }, DataLife: { unit: 'MONTH', value: 6 }, Frequency: { unit: 'DAY', value: 4 } };
    const j = await this.call('/Consent', { ver: '2.0.0', timestamp: now.toISOString(), txnid: randomUUID(), ConsentDetail: detail }); return { handle: j.ConsentHandle as string, expires_at: detail.consentExpiry, range_from: detail.FIDataRange.from as string };
  }
  async handleStatus(handle: string) { const j = await this.call(`/Consent/handle/${handle}`); return { status: j.ConsentStatus.status as string, consentId: (j.ConsentStatus.id ?? null) as string | null }; }
  async revoke(consentId: string) { await this.call('/Consent/revoke', { consentId }); }
  async fetchAccounts(consentId: string, range: { from: string; to: string }): Promise<NormAccount[]> {
    const consent = await this.call(`/Consent/${consentId}`); if (consent.status !== 'ACTIVE') throw Object.assign(new Error(`Consent is ${consent.status}`), { status: 403, code: 'consent_not_active' });
    if (this.cfg.aaPublicPem && !verifyDetached(JSON.stringify(consent.ConsentDetail), consent.signedConsent, this.cfg.aaPublicPem)) throw Object.assign(new Error('Consent artefact signature did not verify'), { status: 502, code: 'bad_consent_signature' });
    const km: KeyMaterial = newKeyMaterial();
    const req = await this.call('/FI/request', { ver: '2.0.0', timestamp: new Date().toISOString(), txnid: randomUUID(), FIDataRange: range, Consent: { id: consentId, digitalSignature: consent.signedConsent },
      KeyMaterial: { cryptoAlg: 'ECDHE', curve: 'Curve25519', params: '', DHPublicKey: { expiry: new Date(Date.now() + 3600e3).toISOString(), Parameter: '', KeyValue: km.publicKey }, Nonce: km.nonce } });
    const res = await this.call(`/FI/fetch/${req.sessionId}`); const out: NormAccount[] = [];
    for (const f of res.FI ?? []) for (const d of f.data ?? []) {
      const plain = decryptFI(d.encryptedFI, km, f.KeyMaterial.DHPublicKey.KeyValue, f.KeyMaterial.Nonce);
      out.push(normalizeDeposit(f.fipID, SANDBOX_FIPS.find((p) => p.id === f.fipID)?.name ?? f.fipID, d.linkRefNumber, JSON.parse(plain)));
    }
    return out;
  }
}
