// Starts core + every service for local development, with prefixed logs. Ctrl+C stops everything.
import { spawn } from 'node:child_process'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const secret = process.env.INTERNAL_API_SECRET ?? 'dev-only-internal-secret-change-me';
const base = { ...process.env, INTERNAL_API_SECRET: secret, NODE_ENV: process.env.NODE_ENV ?? 'development' };
const svc = (name, dir, env, cmd = ['node', 'src/main.ts']) => ({ name, cwd: path.join(root, dir), cmd, env: { ...base, ...env } });
const list = [
  svc('aggregator', 'services/aggregator', { PORT: '3201', DATA_DIR: path.join(root, 'data/aggregator'), PUBLIC_URL: 'http://localhost:3201', ALLOWED_REDIRECT_ORIGINS: 'http://localhost:3100', AA_MODE: 'sandbox' }),
  svc('bureau', 'services/bureau', { PORT: '3202', BUREAU_PROVIDER: 'sandbox', BUREAU_COOLDOWN_S: '20' }),
  svc('assistant', 'services/assistant', { PORT: '3203', ASSISTANT_DB: path.join(root, 'data/assistant/assistant.db'), CORE_URL: 'http://127.0.0.1:3100' }),
  svc('scheduler', 'services/scheduler', { PORT: '3204', CORE_URL: 'http://127.0.0.1:3100', SCHEDULER_INTERVAL_S: '60' }),
  { name: 'core', cwd: path.join(root, 'app'), cmd: process.argv.includes('--prod') ? ['npx', 'next', 'start', '-p', '3100'] : ['npx', 'next', 'dev', '-p', '3100'], env: { ...base, AGGREGATOR_URL: 'http://127.0.0.1:3201', BUREAU_URL: 'http://127.0.0.1:3202', ASSISTANT_URL: 'http://127.0.0.1:3203', PUBLIC_URL: 'http://localhost:3100' } },
];
const kids = list.map((s) => { const p = spawn(s.cmd[0], s.cmd.slice(1), { cwd: s.cwd, env: s.env, stdio: ['ignore', 'pipe', 'pipe'] }); const tag = `[${s.name}]`.padEnd(13);
  for (const st of [p.stdout, p.stderr]) st.on('data', (d) => process.stdout.write(String(d).split('\n').filter(Boolean).map((l) => `${tag}${l}`).join('\n') + '\n')); p.on('exit', (c) => console.log(`${tag}exited (${c})`)); return p; });
const stop = () => { for (const k of kids) k.kill('SIGTERM'); setTimeout(() => process.exit(0), 1500); }; process.on('SIGINT', stop); process.on('SIGTERM', stop);
