import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, createSign, createVerify, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

/**
 * ReBIT / Sahamati Account Aggregator crypto, written from the published spec:
 *  - FI payloads are encrypted per request with an ephemeral Curve25519 (X25519) ECDH exchange. Public keys travel as base64 X.509 (SPKI) DER.
 *  - Both sides contribute a 32-byte nonce. xor = nonceFIP XOR nonceFIU; HKDF-SHA256(sharedSecret, salt = xor[0..20), info = empty) gives the AES-256 key;
 *    the GCM IV is xor[20..32). The ciphertext carries the 128-bit GCM tag at its end and is base64 encoded.
 *  - API requests carry a detached RS256 JWS ("header..signature") over the body in x-jws-signature.
 * NOTE: verify these details against your AA's sandbox before going live; vendors can differ in small ways.
 */
export interface KeyMaterial { privateKey: KeyObject; publicKey: string; nonce: string }
export const newKeyMaterial = (): KeyMaterial => { const k = generateKeyPairSync('x25519'); return { privateKey: k.privateKey, publicKey: k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), nonce: randomBytes(32).toString('base64') }; };

function deriveKey(priv: KeyObject, peerPublicB64: string, nonceA: string, nonceB: string) {
  const a = Buffer.from(nonceA, 'base64'), b = Buffer.from(nonceB, 'base64'); if (a.length !== 32 || b.length !== 32) throw new Error('Nonces must be 32 bytes');
  const shared = diffieHellman({ privateKey: priv, publicKey: createPublicKey({ key: Buffer.from(peerPublicB64, 'base64'), format: 'der', type: 'spki' }) });
  const x = Buffer.alloc(32); for (let i = 0; i < 32; i++) x[i] = a[i] ^ b[i];
  return { key: Buffer.from(hkdfSync('sha256', shared, x.subarray(0, 20), Buffer.alloc(0), 32)), iv: x.subarray(20) };
}
export function encryptFI(plaintext: string, own: KeyMaterial, peerPublicB64: string, peerNonce: string): string {
  const { key, iv } = deriveKey(own.privateKey, peerPublicB64, own.nonce, peerNonce); const c = createCipheriv('aes-256-gcm', key, iv);
  return Buffer.concat([c.update(plaintext, 'utf8'), c.final(), c.getAuthTag()]).toString('base64');
}
export function decryptFI(encryptedB64: string, own: KeyMaterial, peerPublicB64: string, peerNonce: string): string {
  const { key, iv } = deriveKey(own.privateKey, peerPublicB64, own.nonce, peerNonce); const raw = Buffer.from(encryptedB64, 'base64'); if (raw.length < 17) throw new Error('Ciphertext too short');
  const d = createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(raw.subarray(raw.length - 16)); return Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString('utf8');
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
export const newRsa = () => { const k = generateKeyPairSync('rsa', { modulusLength: 2048 }); return { privatePem: k.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, publicPem: k.publicKey.export({ type: 'spki', format: 'pem' }) as string }; };
export const kidOf = (publicPem: string) => createHash('sha256').update(publicPem).digest('hex').slice(0, 16);
/** Detached JWS: base64url(header) + ".." + signature, where the signature covers header + "." + base64url(body). */
export function signDetached(body: string, privatePem: string, kid: string): string {
  const h = b64u(JSON.stringify({ alg: 'RS256', kid, typ: 'JOSE' })); const s = createSign('RSA-SHA256').update(`${h}.${b64u(body)}`).sign(createPrivateKey(privatePem));
  return `${h}..${b64u(s)}`;
}
export function verifyDetached(body: string, jws: string | undefined, publicPem: string): boolean {
  if (!jws) return false; const [h, mid, sig] = jws.split('.'); if (!h || mid !== '' || !sig) return false;
  try { return createVerify('RSA-SHA256').update(`${h}.${b64u(body)}`).verify(createPublicKey(publicPem), Buffer.from(sig, 'base64url')); } catch { return false; }
}
