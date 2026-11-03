'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { formatMoney, parseMoney } from './domain/money';

export class ApiFail extends Error { constructor(public status: number, message: string, public fields?: Record<string, string>) { super(message); } }
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const r = await fetch('/api' + path, { method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'), headers: opts.body !== undefined ? { 'content-type': 'application/json' } : undefined, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiFail(r.status, j.message ?? 'Request failed', j.fields);
  return j as T;
}

const bus = new EventTarget();
export const invalidate = () => bus.dispatchEvent(new Event('inv'));
export function useApi<T = any>(path: string | null) {
  const [data, setData] = useState<T | null>(null); const [error, setError] = useState<string | null>(null); const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const load = useCallback(() => {
    if (!path) return; const n = ++seq.current; setLoading(true);
    api<T>(path).then((d) => { if (n === seq.current) { setData(d); setError(null); } }).catch((e) => { if (n === seq.current) setError(e.message); }).finally(() => n === seq.current && setLoading(false));
  }, [path]);
  useEffect(() => { load(); bus.addEventListener('inv', load); return () => bus.removeEventListener('inv', load); }, [load]);
  return { data, error, loading, reload: load };
}

export interface Me { user: { email: string; name: string } | null; workspace?: { id: number; name: string; base_currency: string; month_start_day: number; privacy_mode: boolean; onboarded: boolean }; currencies?: string[]; role?: string }
const SessionCtx = createContext<{ me: Me; base: string; privacy: boolean; fmt: (n: number, cur?: string, o?: { sign?: boolean }) => string; refresh: () => void } | null>(null);
export const SessionProvider = SessionCtx.Provider;
export function useSession() { const s = useContext(SessionCtx); if (!s) throw new Error('no session'); return s; }

/** Parse a user-typed amount to minor units for the given currency; null if invalid. */
export const toMinor = (s: string, cur = 'USD') => parseMoney(s, cur);
export const fromMinor = (n: number | null | undefined, cur = 'USD') => (n == null ? '' : (n / 10 ** (cur === 'JPY' ? 0 : 2)).toFixed(cur === 'JPY' ? 0 : 2));
export const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export { formatMoney };
