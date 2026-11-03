import path from 'node:path';
import { createService } from '../../../packages/shared/src/server.ts';
import { callService } from '../../../packages/shared/src/client.ts';
import { env } from '../../../packages/shared/src/index.ts';

/** Runs one tick: asks core to execute whatever is due. Core owns the logic and is idempotent per (schedule, date), so overlapping ticks or restarts are safe. */
export async function tick(o: { coreUrl: string; secret: string }) {
  return callService<{ goals: { ran: number; skipped: number }; links: { synced: number; failed: number }; at: string }>({ baseUrl: o.coreUrl, audience: 'core', issuer: 'scheduler', secret: o.secret, path: '/api/internal/jobs/run-due', body: {}, timeoutMs: 120_000 });
}
export function buildScheduler(o: { port: number; secret: string; coreUrl: string; intervalSeconds: number }) {
  const state = { last: null as null | { at: string; ok: boolean; detail?: unknown }, runs: 0 };
  const svc = createService({ name: 'scheduler', port: o.port, secret: o.secret, routes: [{ method: 'GET', path: '/v1/state', handler: () => state }], ready: () => state.runs > 0 });
  let busy = false;
  const run = async () => { if (busy) return; busy = true; try { const r = await tick(o); state.last = { at: r.at, ok: true, detail: r }; svc.log.info('tick', { goals: r.goals, links: r.links }); } catch (e) { state.last = { at: new Date().toISOString(), ok: false, detail: (e as Error).message }; svc.log.warn('tick failed', { err: (e as Error).message }); } finally { busy = false; state.runs++; } };
  const timer = setInterval(run, o.intervalSeconds * 1000); timer.unref();
  return { ...svc, run, state, stop: () => clearInterval(timer) };
}
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const s = buildScheduler({ port: Number(env('PORT', '3204')), secret: env('INTERNAL_API_SECRET'), coreUrl: env('CORE_URL', 'http://127.0.0.1:3100'), intervalSeconds: Number(env('SCHEDULER_INTERVAL_S', '300')) });
  s.installSignals(); await s.listen(); await s.run();
}
