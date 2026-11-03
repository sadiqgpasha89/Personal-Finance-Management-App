import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Service-to-service tokens: base64url(payload).base64url(HMAC-SHA256). Short-lived, audience-bound, and they carry the end user's
 * identity (sub = user id, wid = workspace id) so downstream services never trust a user id from a request body.
 */
export interface ServiceClaims { iss: string; aud: string; sub?: number; wid?: number; iat: number; exp: number }
const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const mac = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest();

export function signToken(secret: string, claims: { iss: string; aud: string; sub?: number; wid?: number }, ttlSeconds = 300, now = Date.now()): string {
  if (!secret || secret.length < 16) throw new Error('INTERNAL_API_SECRET must be at least 16 characters');
  const payload = b64(JSON.stringify({ ...claims, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + ttlSeconds } satisfies ServiceClaims));
  return `${payload}.${b64(mac(secret, payload))}`;
}
export function verifyToken(secret: string, token: string | undefined | null, aud: string, now = Date.now()): ServiceClaims | null {
  if (!token || !secret) return null; const [payload, sig] = token.split('.'); if (!payload || !sig) return null;
  const want = mac(secret, payload); let got: Buffer; try { got = Buffer.from(sig, 'base64url'); } catch { return null; }
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let c: ServiceClaims; try { c = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return null; }
  const t = Math.floor(now / 1000); if (c.aud !== aud || !(c.exp > t) || c.iat > t + 30) return null; return c;
}
export const bearer = (h: string | string[] | undefined) => (typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7) : null);
