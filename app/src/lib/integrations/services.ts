import { callService, ServiceError } from '../../../../packages/shared/src/client';
import { signToken, verifyToken } from '../../../../packages/shared/src/svcauth';

/** Where the other Ledgerly services live. In Docker/Kubernetes these are the internal service DNS names. */
export const URLS = {
  get aggregator() { return process.env.AGGREGATOR_URL ?? 'http://127.0.0.1:3201'; }, get bureau() { return process.env.BUREAU_URL ?? 'http://127.0.0.1:3202'; }, get assistant() { return process.env.ASSISTANT_URL ?? 'http://127.0.0.1:3203'; },
};
export const secret = () => { const s = process.env.INTERNAL_API_SECRET ?? (process.env.NODE_ENV === 'production' ? '' : 'dev-only-internal-secret-change-me'); if (s.length < 16) throw new Error('INTERNAL_API_SECRET (16+ chars) must be set'); return s; };
export type Svc = keyof typeof URLS;
export const call = <T = any>(svc: Svc, path: string, o: { body?: unknown; method?: string; user?: { id: number; wid: number }; timeoutMs?: number } = {}) =>
  callService<T>({ baseUrl: URLS[svc], audience: svc, issuer: 'core', secret: secret(), path, ...o });
export const verifyInbound = (header: string | null) => verifyToken(secret(), header?.startsWith('Bearer ') ? header.slice(7) : null, 'core');
export { ServiceError, signToken };
