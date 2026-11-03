import fs from 'node:fs';

/** The only thing the rest of the service knows about the model. */
export interface Llm { name: string; plan(system: string, user: string, schema: object): Promise<unknown>; compose(system: string, user: string, maxTokens?: number): Promise<string>; close(): Promise<void> }

/**
 * Llama 3.2 1B Instruct (Q4_K_M GGUF) running in-process through llama.cpp on the CPU.
 * Requests are serialized: one model, one context, no data leaves the machine.
 */
export async function loadLlama(o: { modelPath: string; threads?: number; contextSize?: number }): Promise<Llm> {
  if (!fs.existsSync(o.modelPath)) throw new Error(`Model file not found: ${o.modelPath}. Run "npm run model:download" in services/assistant.`);
  const { getLlama, LlamaChatSession } = await import('node-llama-cpp');
  const llama = await getLlama({ gpu: false }); const model = await llama.loadModel({ modelPath: o.modelPath });
  const ctx = await model.createContext({ contextSize: o.contextSize ?? 4096, threads: o.threads });
  let chain: Promise<unknown> = Promise.resolve(); const serial = <T,>(f: () => Promise<T>) => { const r = chain.then(f, f); chain = r.catch(() => {}); return r; };
  const run = async <T,>(system: string, f: (s: InstanceType<typeof LlamaChatSession>) => Promise<T>) => { const seq = ctx.getSequence(); const session = new LlamaChatSession({ contextSequence: seq, systemPrompt: system }); try { return await f(session); } finally { session.dispose(); seq.dispose(); } };
  return {
    name: 'llama-3.2-1b-instruct-q4_k_m',
    plan: (system, user, schema) => serial(async () => { const grammar = await llama.createGrammarForJsonSchema(schema as any); return run(system, async (s) => grammar.parse(await s.prompt(user, { grammar, maxTokens: 160, temperature: 0 }))); }),
    compose: (system, user, maxTokens = 260) => serial(() => run(system, async (s) => (await s.prompt(user, { maxTokens, temperature: 0.2, topP: 0.9 })).trim())),
    close: async () => { await ctx.dispose(); await model.dispose(); await llama.dispose(); },
  };
}
