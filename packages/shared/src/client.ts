import { signToken } from './svcauth.ts';

export class ServiceError extends Error {
  status: number; code: string; fields?: Record<string, string>;
  constructor(status: number, code: string, message: string, fields?: Record<string, string>) { super(message); this.status = status; this.code = code; this.fields = fields; }
}
/** Calls another Ledgerly service with a fresh short-lived token for the given user. Times out and maps errors to ServiceError. */
export async function callService<T = any>(o: { baseUrl: string; audience: string; issuer: string; secret: string; path: string; method?: string; body?: unknown; user?: { id: number; wid: number }; timeoutMs?: number; requestId?: string }): Promise<T> {
  const token = signToken(o.secret, { iss: o.issuer, aud: o.audience, sub: o.user?.id, wid: o.user?.wid });
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), o.timeoutMs ?? 30_000);
  try {
    const r = await fetch(o.baseUrl.replace(/\/$/, '') + o.path, { method: o.method ?? (o.body !== undefined ? 'POST' : 'GET'), signal: ctl.signal, headers: { authorization: `Bearer ${token}`, ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(o.requestId ? { 'x-request-id': o.requestId } : {}) }, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new ServiceError(r.status, j.code ?? 'upstream_error', j.message ?? `${o.audience} returned ${r.status}`, j.fields);
    return j as T;
  } catch (e) {
    if (e instanceof ServiceError) throw e;
    throw new ServiceError(503, 'unavailable', `${o.audience} is unavailable`);
  } finally { clearTimeout(t); }
}
