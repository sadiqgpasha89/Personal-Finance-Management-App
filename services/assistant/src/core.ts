import { callService } from '../../../packages/shared/src/client.ts';

export interface ToolDef { name: string; description: string; input_schema: object }
export interface Entities { today: string; base: string; first_name: string; categories: string[]; merchants: string[]; accounts: string[]; cards: string[] }
export interface CoreClient { tools(user: User): Promise<ToolDef[]>; run(user: User, name: string, input: unknown): Promise<{ ok: boolean; result: any }>; entities(user: User): Promise<Entities> }
export interface User { id: number; wid: number }

/** The assistant reads the ledger only through core's read-only, validated tool API, with a token naming the user. */
export const coreClient = (baseUrl: string, secret: string): CoreClient => {
  const call = <T,>(path: string, user: User, body?: unknown) => callService<T>({ baseUrl, audience: 'core', issuer: 'assistant', secret, path, user, body, timeoutMs: 30_000 });
  return {
    tools: async (u) => (await call<{ tools: ToolDef[] }>('/api/internal/tools', u)).tools,
    run: async (u, name, input) => { try { return await call('/api/internal/tools/run', u, { name, input }); } catch (e: any) { if (e.status === 400 && e.message) return { ok: false, result: { error: e.message } }; throw e; } },
    entities: (u) => call<Entities>('/api/internal/entities', u),
  };
};
