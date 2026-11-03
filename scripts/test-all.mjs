// Runs every test suite: shared package, each service (node:test), and the core app (vitest).
import { spawnSync } from 'node:child_process'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); let failed = 0;
const run = (name, cwd, cmd) => { console.log(`\n=== ${name} ===`); const r = spawnSync(cmd[0], cmd.slice(1), { cwd: path.join(root, cwd), stdio: 'inherit' }); if (r.status !== 0) { failed++; console.log(`!! ${name} FAILED`); } };
run('shared', 'packages/shared', ['node', '--test', 'src/shared.test.ts']);
for (const s of ['aggregator', 'bureau', 'assistant', 'scheduler']) run(s, `services/${s}`, ['node', '--test', 'src/*.test.ts']);
run('core', 'app', ['npx', 'vitest', 'run']); console.log(failed ? `\n${failed} suite(s) failed` : '\nAll suites passed'); process.exit(failed ? 1 : 0);
