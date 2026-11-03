export * from './svcauth.ts';
export * from './server.ts';
export * from './client.ts';
export * from './log.ts';
export * from './nlp.ts';
export const env = (name: string, fallback?: string): string => { const v = process.env[name] ?? fallback; if (v === undefined) throw new Error(`Missing environment variable ${name}`); return v; };
