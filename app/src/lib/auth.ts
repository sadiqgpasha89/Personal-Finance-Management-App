import crypto from 'crypto';
import { cookies, headers } from 'next/headers';
import { all, get, run, tx, DEFAULT_CATEGORIES } from './db';

const COOKIE = 'ledgerly_session', TTL = 14 * 864e5;
export class ApiError extends Error { constructor(public status: number, message: string, public code = 'error', public fields?: Record<string, string>) { super(message); } }

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, s, h] = stored.split('$'); if (alg !== 'scrypt') return false;
  const calc = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(calc, Buffer.from(h, 'hex'));
}
const sha = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

export function passwordProblem(pw: string): string | null {
  if (pw.length < 10) return 'Use at least 10 characters';
  if (!/[a-z]/i.test(pw) || !/\d/.test(pw)) return 'Include letters and numbers';
  if (['password123', '1234567890', 'qwertyuiop'].includes(pw.toLowerCase())) return 'That password is too common';
  return null;
}

export function createUser(email: string, name: string, pw: string) {
  return tx(() => {
    const u = run('INSERT INTO users(email,name,pw_hash) VALUES(?,?,?)', email, name, hashPassword(pw));
    const uid = Number(u.lastInsertRowid);
    const w = run('INSERT INTO workspaces(name,owner_id) VALUES(?,?)', `${name}'s finances`, uid);
    const wid = Number(w.lastInsertRowid);
    run('INSERT INTO memberships(workspace_id,user_id,role) VALUES(?,?,?)', wid, uid, 'owner');
    for (const [n, k, g, e] of DEFAULT_CATEGORIES) run('INSERT INTO categories(workspace_id,name,kind,group_name,essential) VALUES(?,?,?,?,?)', wid, n, k, g, e);
    return { uid, wid };
  });
}
export async function startSession(uid: number) {
  const token = crypto.randomBytes(32).toString('base64url');
  const h = await headers();
  run('INSERT INTO sessions(token_hash,user_id,expires_at,ua) VALUES(?,?,?,?)', sha(token), uid, Date.now() + TTL, (h.get('user-agent') ?? '').slice(0, 200));
  (await cookies()).set(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: TTL / 1000 });
}
export async function endSession() {
  const c = await cookies(); const t = c.get(COOKIE)?.value;
  if (t) run('DELETE FROM sessions WHERE token_hash=?', sha(t));
  c.delete(COOKIE);
}
export interface Ctx { userId: number; wid: number; email: string; name: string; base: string; startDay: number; privacy: boolean; role: string }
export async function getCtx(): Promise<Ctx | null> {
  const t = (await cookies()).get(COOKIE)?.value; if (!t) return null;
  const s = get('SELECT user_id,expires_at FROM sessions WHERE token_hash=?', sha(t));
  if (!s || s.expires_at < Date.now()) return null;
  const r = get(`SELECT u.id uid,u.email,u.name,w.id wid,w.base_currency base,w.month_start_day sd,w.privacy_mode pm,m.role FROM users u JOIN memberships m ON m.user_id=u.id JOIN workspaces w ON w.id=m.workspace_id WHERE u.id=? ORDER BY w.id LIMIT 1`, s.user_id);
  if (!r) return null;
  return { userId: r.uid, wid: r.wid, email: r.email, name: r.name, base: r.base, startDay: r.sd, privacy: !!r.pm, role: r.role };
}
export async function requireCtx(): Promise<Ctx> { const c = await getCtx(); if (!c) throw new ApiError(401, 'Not signed in', 'unauthenticated'); return c; }
export const audit = (c: Ctx, entity: string, id: number | null, action: string, detail?: unknown) =>
  run('INSERT INTO audit_log(workspace_id,actor_id,entity,entity_id,action,detail) VALUES(?,?,?,?,?,?)', c.wid, c.userId, entity, id, action, detail ? JSON.stringify(detail).slice(0, 2000) : null);

// ---- tiny in-memory rate limiter ----
const hits = new Map<string, number[]>();
export function rateLimit(key: string, max: number, windowMs: number) {
  const now = Date.now(); const a = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (a.length >= max) throw new ApiError(429, 'Too many attempts, please wait a moment', 'rate_limited');
  a.push(now); hits.set(key, a);
}
export { all };

/** Builds a request context for a user without a cookie (service-to-service calls carry a verified user id instead). */
export function ctxForUser(userId: number, wid?: number): Ctx | null {
  const r = get(`SELECT u.id uid,u.email,u.name,w.id wid,w.base_currency base,w.month_start_day sd,w.privacy_mode pm,m.role FROM users u JOIN memberships m ON m.user_id=u.id JOIN workspaces w ON w.id=m.workspace_id WHERE u.id=? ${wid ? 'AND w.id=?' : ''} ORDER BY w.id LIMIT 1`, ...(wid ? [userId, wid] : [userId]));
  return r ? { userId: r.uid, wid: r.wid, email: r.email, name: r.name, base: r.base, startDay: r.sd, privacy: !!r.pm, role: r.role } : null;
}
