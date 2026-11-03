import path from 'node:path';
import { createService, HttpError } from '../../../packages/shared/src/server.ts';
import type { Route } from '../../../packages/shared/src/server.ts';
import { env } from '../../../packages/shared/src/index.ts';
import { ConvStore } from './store.ts';
import { coreClient } from './core.ts';
import type { CoreClient, Entities, User } from './core.ts';
import { loadLlama } from './llm.ts';
import type { Llm } from './llm.ts';
import { HELP_TEXT, COMPOSE_SYSTEM, composePrompt, looksLikeAnAnswer, renderFacts, unsupportedNumbers } from './compose.ts';
import { PLAN_SCHEMA, PLAN_SYSTEM, guard, normalizePlan, planPrompt, periodLabel, toCalls } from './planner.ts';
import type { Plan } from './planner.ts';

const cheapPlan = (q: string): Plan => { const g = guard(q, 'help'); const intent = g.guarded ? g.intent : /\b(spent|spend|cost|paid)\b/i.test(q) ? 'spending' : /\b(show|list|biggest|largest|latest|recent)\b/i.test(q) ? 'transactions' : /\b(bill|due)\b/i.test(q) ? 'bills' : /\b(balance|accounts?)\b/i.test(q) ? 'balances' : /\bbudget\b/i.test(q) ? 'budget' : /\bgoals?\b/i.test(q) ? 'goals' : /\b(debt|loan|emi|owe)\b/i.test(q) ? 'debts' : /\bcards?\b/i.test(q) ? 'cards' : 'help'; return { intent, category: '', merchant: '', period: '', sort: /biggest|largest/i.test(q) ? 'largest' : '', count: 0, follow_up: false }; };

export function buildAssistant(o: { port: number; secret: string; dbFile: string; core: CoreClient; llm: Llm | null; retentionDays?: number; headline?: boolean }) {
  const store = new ConvStore(o.dbFile); store.prune(o.retentionDays ?? 90); const timer = setInterval(() => store.prune(o.retentionDays ?? 90), 24 * 3600e3); timer.unref();
  const entCache = new Map<number, { at: number; e: Entities }>();
  const entities = async (u: User) => { const hit = entCache.get(u.id); if (hit && Date.now() - hit.at < 60_000) return hit.e; const e = await o.core.entities(u); entCache.set(u.id, { at: Date.now(), e }); return e; };
  const user = (c: { claims: { sub?: number; wid?: number } | null }): User => { if (!c.claims?.sub) throw new HttpError(400, 'bad_request', 'Token has no user'); return { id: c.claims.sub, wid: c.claims.wid ?? 0 }; };

  async function chat(u: User, message: string, convId?: string) {
    const q = message.trim(); if (!q || q.length > 2000) throw new HttpError(400, 'validation', 'Message must be 1-2000 characters');
    if (convId && !store.has(u.id, convId)) throw new HttpError(404, 'not_found', 'Conversation not found');
    const id = convId ?? store.create(u.id, q); const prior = store.messages(u.id, id, 12) ?? [];
    const lastA = [...prior].reverse().find((m) => m.role === 'assistant' && m.plan); const lastQ = lastA ? [...prior].reverse().find((m) => m.role === 'user' && m.id < lastA.id)?.content ?? null : null; const prev = (lastA?.plan as Plan | null) ?? null;
    const ent = await entities(u); let engine = 'rules'; let plan: Plan | null = null;
    if (o.llm) { try { plan = normalizePlan(await o.llm.plan(PLAN_SYSTEM, planPrompt(q, prev, lastQ), PLAN_SCHEMA)); engine = o.llm.name; } catch { plan = null; } }
    plan ??= cheapPlan(q); const g = guard(q, plan.intent); plan = { ...plan, intent: g.intent };
    const { plan: final, calls } = toCalls(q, plan, prev, ent);
    let reply: string; const results: { name: string; result: any }[] = []; let verified = true;
    if (!calls.length) reply = /^(thanks|thank you|thx|ok|cool|great)\b/i.test(q) ? "You're welcome! Ask me anything about your money." : /^(hi|hello|hey)\b/i.test(q) ? `Hi ${ent.first_name}! ${HELP_TEXT}` : HELP_TEXT;
    else {
      await Promise.all(calls.map(async (c) => { const r = await o.core.run(u, c.name, c.input); results.push({ name: c.name, result: r.result }); }));
      const facts = results.length === 1 ? results[0].result : results; const when = periodLabel(q, final, ent.today); const intro = final.intent === 'spending' || final.intent === 'income' || final.intent === 'transactions' ? `Period: ${when}.` : '';
      const fallback = renderFacts(results, intro, final.intent); reply = fallback;
      // The model's one-sentence summary is opt-in: a 1B model can read a number correctly yet describe it wrongly, and for money the verified, template-rendered facts are the safer default.
      if (o.llm && o.headline && !JSON.stringify(facts).includes('"error"')) {
        try { const t = (await o.llm.compose(COMPOSE_SYSTEM, composePrompt(q, facts, [], intro))).trim(); const bad = unsupportedNumbers(t, facts); if (t && !bad.length && looksLikeAnAnswer(t)) reply = `${t}\n\n${fallback}`; else verified = false; } catch { verified = false; }
      }
    }
    store.add(u.id, id, { role: 'user', content: q }); store.add(u.id, id, { role: 'assistant', content: reply, plan: final, tools: results.map((r) => r.name), engine });
    return { conversation_id: id, reply, engine, tools_used: results.map((r) => r.name), intent: final.intent, verified_numbers: verified };
  }
  const routes: Route[] = [
    { method: 'GET', path: '/v1/status', handler: () => ({ llm: o.llm?.name ?? null, privacy: 'All inference runs inside this service; no data is sent to a third party.' }) },
    { method: 'POST', path: '/v1/chat', handler: (c) => chat(user(c), String(c.body.message ?? ''), c.body.conversation_id ? String(c.body.conversation_id) : undefined) },
    { method: 'GET', path: '/v1/conversations', handler: (c) => ({ items: store.list(user(c).id) }) },
    { method: 'GET', path: '/v1/conversations/:id', handler: (c) => { const m = store.messages(user(c).id, c.params[0]); if (!m) throw new HttpError(404, 'not_found', 'Conversation not found'); return { id: c.params[0], messages: m }; } },
    { method: 'PATCH', path: '/v1/conversations/:id', handler: (c) => { if (!store.rename(user(c).id, c.params[0], String(c.body.title ?? ''))) throw new HttpError(404, 'not_found', 'Conversation not found'); return { ok: true }; } },
    { method: 'DELETE', path: '/v1/conversations/:id', handler: (c) => { if (!store.remove(user(c).id, c.params[0])) throw new HttpError(404, 'not_found', 'Conversation not found'); return { ok: true }; } },
    { method: 'DELETE', path: '/v1/conversations', handler: (c) => ({ deleted: store.removeAll(user(c).id) }) },
  ];
  const svc = createService({ name: 'assistant', port: o.port, secret: o.secret, routes, maxBody: 20_000, ready: () => true, onClose: async () => { clearInterval(timer); store.close(); await o.llm?.close(); } });
  return { ...svc, store, chat };
}
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const secret = env('INTERNAL_API_SECRET'); const modelPath = env('LLAMA_MODEL_PATH', './models/Llama-3.2-1B-Instruct-Q4_K_M.gguf');
  const llm = process.env.LLM_DISABLED === '1' ? null : await loadLlama({ modelPath, threads: process.env.LLAMA_THREADS ? Number(process.env.LLAMA_THREADS) : undefined }).catch((e) => { console.error(JSON.stringify({ level: 'error', service: 'assistant', msg: 'model not loaded, running rules-only', err: (e as Error).message })); return null; });
  const svc = buildAssistant({ port: Number(env('PORT', '3203')), secret, dbFile: env('ASSISTANT_DB', './data/assistant.db'), core: coreClient(env('CORE_URL', 'http://127.0.0.1:3100'), secret), llm, retentionDays: Number(env('RETENTION_DAYS', '90')), headline: process.env.ASSISTANT_LLM_HEADLINE === '1' });
  svc.installSignals(); svc.listen();
}
