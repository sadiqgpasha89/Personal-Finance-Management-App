import { all, Row } from './db';
import { Ctx, ctxForUser } from './auth';
import { runTool, toolDefs } from './chat/tools';
import { runAllDueGoalSchedules } from './goalsched';
import { syncStaleLinks } from './connections';
import { today } from './domain/dates';
import { verifyInbound } from './integrations/services';

/** Service-to-service API (never exposed through the public gateway). Every call needs a signed token from a Ledgerly service. */
const json = (status: number, body: unknown) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function handleInternal(req: Request, path: string): Promise<Response> {
  const claims = verifyInbound(req.headers.get('authorization')); if (!claims) return json(401, { code: 'unauthorized', message: 'Missing or invalid service token' });
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  if (path === '/internal/jobs/run-due' && req.method === 'POST') {
    if (claims.iss !== 'scheduler') return json(403, { code: 'forbidden', message: 'Only the scheduler may run jobs' });
    const goals = runAllDueGoalSchedules(); const links = await syncStaleLinks(); return json(200, { goals, links, at: new Date().toISOString() });
  }
  // everything else acts for one user, taken from the verified token, never from the body
  if (!claims.sub) return json(400, { code: 'bad_request', message: 'Token has no user' });
  const c = ctxForUser(claims.sub, claims.wid); if (!c) return json(404, { code: 'not_found', message: 'Unknown user' });
  if (path === '/internal/tools' && req.method === 'GET') return json(200, { tools: toolDefs() });
  if (path === '/internal/tools/run' && req.method === 'POST') { const r = runTool(c, String(body.name ?? ''), body.input); return json(r.ok ? 200 : 400, r); }
  if (path === '/internal/entities' && req.method === 'GET') return json(200, entities(c));
  return json(404, { code: 'not_found', message: 'Not found' });
}
function entities(c: Ctx) {
  const col = (sql: string, ...p: any[]) => all(sql, ...p).map((r: Row) => String(Object.values(r)[0]));
  return { today: today(), base: c.base, first_name: c.name.split(' ')[0], categories: col('SELECT name FROM categories WHERE workspace_id=?', c.wid),
    merchants: col(`SELECT merchant FROM transactions WHERE workspace_id=? AND merchant IS NOT NULL AND deleted_at IS NULL GROUP BY merchant ORDER BY COUNT(*) DESC LIMIT 200`, c.wid),
    accounts: col('SELECT name FROM accounts WHERE workspace_id=? AND is_archived=0', c.wid), cards: col('SELECT nickname FROM cards WHERE workspace_id=?', c.wid) };
}
