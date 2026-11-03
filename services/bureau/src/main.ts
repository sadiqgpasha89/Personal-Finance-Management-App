import path from 'node:path';
import { createService, HttpError } from '../../../packages/shared/src/server.ts';
import type { Route } from '../../../packages/shared/src/server.ts';
import { env } from '../../../packages/shared/src/index.ts';
import { buildReport, httpProvider, sandboxProvider } from './providers.ts';
import type { Provider } from './providers.ts';

export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export function validate(b: any, today: string) {
  const f: Record<string, string> = {}; const name = String(b.name ?? '').trim(), pan = String(b.pan ?? '').trim().toUpperCase(), mobile = String(b.mobile ?? '').trim(), dob = String(b.dob ?? '');
  if (name.length < 2 || name.length > 80 || !/^[A-Za-z .'-]+$/.test(name)) f.name = 'Enter your name as on your PAN';
  if (!PAN_RE.test(pan) || pan[3] !== 'P') f.pan = 'Enter a valid individual PAN (like ABCPE1234F)';
  if (!/^[6-9]\d{9}$/.test(mobile)) f.mobile = 'Enter a 10-digit Indian mobile number';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || Number.isNaN(Date.parse(dob)) || dob > today) f.dob = 'Enter a valid date of birth'; else if (Number(today.slice(0, 4)) - Number(dob.slice(0, 4)) < 18) f.dob = 'You must be 18 or older';
  if (!(b.consent?.given === true) || !b.consent?.text_version) f.consent = 'Consent is required to fetch your credit report';
  if (Object.keys(f).length) throw new HttpError(400, 'validation', 'Please check the highlighted fields', f);
  return { name, pan, mobile, dob };
}
export function buildBureau(o: { port: number; secret: string; provider: Provider; cooldownSeconds: number; now?: () => Date }) {
  const last = new Map<number, number>(); const now = () => o.now?.() ?? new Date();
  const routes: Route[] = [
    { method: 'GET', path: '/v1/provider', handler: () => ({ provider: o.provider.name, sample: o.provider.sample, cooldown_seconds: o.cooldownSeconds }) },
    { method: 'POST', path: '/v1/reports', handler: async (c) => {
      const today = now().toISOString().slice(0, 10); const req = validate(c.body, today); const uid = c.claims!.sub!; const prev = last.get(uid);
      if (prev && now().getTime() - prev < o.cooldownSeconds * 1000) throw new HttpError(429, 'cooldown', `A report was fetched moments ago. Try again in ${Math.ceil((o.cooldownSeconds * 1000 - (now().getTime() - prev)) / 1000)}s.`);
      try { const report = await buildReport(o.provider, req, today); last.set(uid, now().getTime()); return { report }; }
      catch (e: any) { throw new HttpError(e.status ?? 502, e.code ?? 'provider_error', 'The credit bureau could not be reached. Nothing was charged; try again later.'); }   // never echo provider internals or inputs
    } },
  ];
  return createService({ name: 'bureau', port: o.port, secret: o.secret, routes });
}
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const port = Number(env('PORT', '3202')); const mode = env('BUREAU_PROVIDER', 'sandbox');
  const provider = mode === 'http' ? httpProvider(env('BUREAU_BASE_URL'), env('BUREAU_API_KEY')) : sandboxProvider;
  const svc = buildBureau({ port, secret: env('INTERNAL_API_SECRET'), provider, cooldownSeconds: Number(env('BUREAU_COOLDOWN_S', mode === 'http' ? '86400' : '20')) }); svc.installSignals(); svc.listen();
}
