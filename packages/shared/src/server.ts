import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { bearer, verifyToken } from './svcauth.ts';
import type { ServiceClaims } from './svcauth.ts';
import { logger } from './log.ts';

export class HttpError extends Error {
  status: number; code: string; fields?: Record<string, string>;
  constructor(status: number, code: string, message: string, fields?: Record<string, string>) { super(message); this.status = status; this.code = code; this.fields = fields; }
}
export interface Ctx { req: http.IncomingMessage; url: URL; params: string[]; query: URLSearchParams; body: any; raw: string; claims: ServiceClaims | null; id: string }
export type Handler = (c: Ctx) => unknown | Promise<unknown>;
/** A handler may return { __html } or { __raw, type } for non-JSON responses (used by the sandbox consent page). */
export interface Route { method: string; path: string; handler: Handler; auth?: 'service' | 'none' }

/**
 * Minimal service skeleton: routing, JSON bodies with a size cap, service-token auth, /healthz, request logging, graceful shutdown.
 * Deliberately dependency-free so every service image stays small and auditable.
 */
export function createService(opts: { name: string; port: number; secret: string; routes: Route[]; maxBody?: number; onClose?: () => void | Promise<void>; ready?: () => boolean | Promise<boolean> }) {
  const log = logger(opts.name); const maxBody = opts.maxBody ?? 1_000_000;
  const table = opts.routes.map((r) => ({ ...r, re: new RegExp('^' + r.path.replace(/:\w+/g, '([^/]+)') + '$') }));
  const server = http.createServer(async (req, res) => {
    const id = (req.headers['x-request-id'] as string) || randomUUID(); const started = Date.now(); const url = new URL(req.url ?? '/', 'http://x');
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      const isRaw = body && typeof body === 'object' && ('__html' in (body as any) || '__raw' in (body as any));
      const payload = isRaw ? String((body as any).__html ?? (body as any).__raw) : JSON.stringify(body ?? { ok: true });
      res.writeHead(status, { 'content-type': isRaw ? (body as any).type ?? 'text/html; charset=utf-8' : 'application/json', 'cache-control': 'no-store', 'x-request-id': id, 'x-content-type-options': 'nosniff', ...headers }); res.end(payload);
    };
    try {
      if (url.pathname === '/healthz') return send(200, { ok: true, service: opts.name });
      if (url.pathname === '/readyz') { const ok = opts.ready ? await opts.ready() : true; return send(ok ? 200 : 503, { ready: ok, service: opts.name }); }
      const match = table.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!match) throw new HttpError(404, 'not_found', 'Not found');
      let claims: ServiceClaims | null = null;
      if ((match.auth ?? 'service') === 'service') { claims = verifyToken(opts.secret, bearer(req.headers.authorization), opts.name); if (!claims) throw new HttpError(401, 'unauthorized', 'Missing or invalid service token'); }
      let body: any; let rawText = '';
      if (req.method !== 'GET' && req.method !== 'DELETE') {
        const chunks: Buffer[] = []; let n = 0;
        for await (const ch of req) { n += (ch as Buffer).length; if (n > maxBody) throw new HttpError(413, 'too_large', 'Request body too large'); chunks.push(ch as Buffer); }
        const text = Buffer.concat(chunks).toString(); rawText = text;
        const ct = req.headers['content-type'] ?? '';
        if (text) { if (ct.includes('application/x-www-form-urlencoded')) { body = {}; for (const [k, v] of new URLSearchParams(text)) body[k] = k in body ? ([] as string[]).concat(body[k], v) : v; } else { try { body = JSON.parse(text); } catch { throw new HttpError(400, 'bad_json', 'Malformed JSON'); } } }
      }
      const out = await match.handler({ req, url, params: url.pathname.match(match.re)!.slice(1), query: url.searchParams, body: body ?? {}, raw: rawText, claims, id });
      if (out && typeof out === 'object' && '__redirect' in (out as any)) return send(302, {}, { location: String((out as any).__redirect) });
      send(200, out);
    } catch (e) {
      if (e instanceof HttpError) send(e.status, { code: e.code, message: e.message, fields: e.fields });
      else { log.error('unhandled', { id, err: (e as Error).message }); send(500, { code: 'internal', message: 'Internal error' }); }
    } finally { log.info('req', { id, m: req.method, p: url.pathname, ms: Date.now() - started }); }
  });
  const shutdown = async () => { log.info('shutting down'); server.close(); try { await opts.onClose?.(); } finally { process.exit(0); } };
  return { server, log, listen: () => new Promise<void>((r) => server.listen(opts.port, () => { log.info('listening', { port: opts.port }); r(); })), close: () => new Promise<void>((r) => server.close(() => r())), installSignals: () => { process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown); } };
}
