// Downloads the quantized Llama 3.2 1B Instruct GGUF (about 0.8 GB). Resumable. Verifies the size.
// Licence: Llama 3.2 Community License, https://www.llama.com/llama3_2/license/  ("Built with Llama").
import fs from 'node:fs'; import path from 'node:path';
const url = 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf';
const out = path.resolve('models/Llama-3.2-1B-Instruct-Q4_K_M.gguf'); const EXPECTED = 807694464;
fs.mkdirSync(path.dirname(out), { recursive: true });
if (fs.existsSync(out) && fs.statSync(out).size === EXPECTED) { console.log('Model already present:', out); process.exit(0); }
const have = fs.existsSync(out) ? fs.statSync(out).size : 0; const res = await fetch(url, { headers: have ? { range: `bytes=${have}-` } : {} });
if (!res.ok && res.status !== 206) { console.error('Download failed:', res.status); process.exit(1); }
const ws = fs.createWriteStream(out, { flags: have && res.status === 206 ? 'a' : 'w' }); let n = have;
for await (const chunk of res.body) { ws.write(chunk); n += chunk.length; process.stdout.write(`\r${(n / 1e6).toFixed(0)} / ${(EXPECTED / 1e6).toFixed(0)} MB`); }
await new Promise((r) => ws.end(r)); if (fs.statSync(out).size !== EXPECTED) { console.error('\nSize mismatch, delete the file and retry.'); process.exit(1); } console.log('\nOK', out);
