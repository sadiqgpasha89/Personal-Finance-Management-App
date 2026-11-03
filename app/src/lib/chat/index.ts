import { Ctx } from '../auth';
import { getProfile } from '../profile';
import { askClaude, llmConfigured } from './agent';
import { localAnswer } from './local';
import { call, ServiceError } from '../integrations/services';

/**
 * Which brain answers:
 *  - llama (default): the assistant service runs Llama 3.2 1B on this machine; questions, tool results and history never leave the deployment.
 *  - rules: the built-in offline engine, used automatically if the assistant service is down.
 *  - claude: only when the operator sets ASSISTANT_PROVIDER=anthropic, ALLOW_EXTERNAL_AI=1 and a key, and the user has opted in.
 */
export type Provider = 'llama' | 'rules' | 'claude';
export const provider = (): Provider => (process.env.ASSISTANT_PROVIDER === 'anthropic' ? 'claude' : process.env.ASSISTANT_PROVIDER === 'rules' ? 'rules' : 'llama');
export interface ChatReply { reply: string; engine: string; tools_used: string[]; conversation_id: string | null; note?: string }
const user = (c: Ctx) => ({ id: c.userId, wid: c.wid });

let statusCache: { at: number; v: any } | null = null;
export async function chatStatus(c: Ctx) {
  const p = provider();
  if (p === 'llama') {
    if (!statusCache || Date.now() - statusCache.at > 15_000) statusCache = { at: Date.now(), v: await call('assistant', '/v1/status', { user: user(c), timeoutMs: 3000 }).catch(() => null) };
    const s = statusCache.v; return { provider: p, engine: s?.llm ? 'llama-local' : s ? 'rules' : 'rules', model: s?.llm ?? null, service_up: !!s, on_device: true, external_ai: false, note: s?.llm ? null : s ? 'The assistant service is up but the model file is not loaded, so it answers with built-in rules.' : 'The assistant service is not reachable; the app falls back to built-in rules without chat history.' };
  }
  if (p === 'claude') { const on = llmConfigured() && getProfile(c.userId).ai_assistant; return { provider: p, engine: on ? 'claude' : 'rules', model: on ? 'claude-haiku-5-5' : null, service_up: false, on_device: false, external_ai: true, note: on ? 'Questions and the figures needed to answer them are sent to Anthropic.' : 'External AI is not enabled for you.' }; }
  return { provider: p, engine: 'rules', model: null, service_up: false, on_device: true, external_ai: false, note: null };
}
export async function answer(c: Ctx, message: string, conversationId?: string | null): Promise<ChatReply> {
  const p = provider();
  if (p === 'llama') {
    try { const r = await call<any>('assistant', '/v1/chat', { user: user(c), body: { message, conversation_id: conversationId ?? undefined }, timeoutMs: 120_000 }); return { reply: r.reply, engine: r.engine, tools_used: r.tools_used, conversation_id: r.conversation_id }; }
    catch (e) { if (e instanceof ServiceError && e.status < 500 && e.status !== 503) throw e; const l = localAnswer(c, message); return { reply: l.reply, engine: l.engine, tools_used: l.tools_used, conversation_id: null, note: 'The on-device assistant is unavailable, so this answer came from the built-in rules and was not saved to your chat history.' }; }
  }
  if (p === 'claude' && llmConfigured() && getProfile(c.userId).ai_assistant) {
    try { const r = await askClaude(c, [{ role: 'user', content: message }]); return { reply: r.reply, engine: r.engine, tools_used: r.tools_used, conversation_id: null }; } catch { /* fall through to rules */ }
  }
  const l = localAnswer(c, message); return { reply: l.reply, engine: l.engine, tools_used: l.tools_used, conversation_id: null };
}
export const conversations = {
  list: (c: Ctx) => call<{ items: any[] }>('assistant', '/v1/conversations', { user: user(c) }).catch(() => ({ items: [] as any[] })),
  get: (c: Ctx, id: string) => call<any>('assistant', `/v1/conversations/${encodeURIComponent(id)}`, { user: user(c) }),
  rename: (c: Ctx, id: string, title: string) => call('assistant', `/v1/conversations/${encodeURIComponent(id)}`, { user: user(c), method: 'PATCH', body: { title } }),
  remove: (c: Ctx, id: string) => call('assistant', `/v1/conversations/${encodeURIComponent(id)}`, { user: user(c), method: 'DELETE' }),
  removeAll: (c: Ctx) => call('assistant', '/v1/conversations', { user: user(c), method: 'DELETE' }).catch(() => null),
};
