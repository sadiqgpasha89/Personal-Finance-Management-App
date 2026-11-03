import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { buildScheduler } from './main.ts';
import { verifyToken } from '../../../packages/shared/src/svcauth.ts';

const secret = 'test-secret-0123456789';
test('a tick calls core with a scheduler-signed token and records the result', async () => {
  const seen: any[] = []; const core = http.createServer((req, res) => { seen.push({ url: req.url, claims: verifyToken(secret, req.headers.authorization?.slice(7), 'core') }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ goals: { ran: 2, skipped: 0 }, links: { synced: 1, failed: 0 }, at: 'now' })); });
  await new Promise<void>((r) => core.listen(0, r)); const port = (core.address() as any).port;
  const s = buildScheduler({ port: 0, secret, coreUrl: `http://127.0.0.1:${port}`, intervalSeconds: 3600 });
  try { await s.run(); assert.equal(seen[0].url, '/api/internal/jobs/run-due'); assert.equal(seen[0].claims.iss, 'scheduler'); assert.equal(s.state.last!.ok, true); assert.equal(s.state.runs, 1); }
  finally { s.stop(); core.close(); }
});
test('a failing core is recorded, not thrown, so the loop keeps running', async () => {
  const s = buildScheduler({ port: 0, secret, coreUrl: 'http://127.0.0.1:1', intervalSeconds: 3600 }); try { await s.run(); assert.equal(s.state.last!.ok, false); assert.equal(s.state.runs, 1); } finally { s.stop(); }
});
