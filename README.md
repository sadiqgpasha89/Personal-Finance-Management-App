# Ledgerly

Personal finance for India and beyond: accounts, cards, UPI, budgets, goals with auto-save, bills, debt, net worth, offers, credit score, bank linking through the Account Aggregator framework, and an on-device AI assistant.

```
app/                 core: Next.js UI + REST API + ledger
services/aggregator  Account Aggregator (FIU) client + sandbox AA
services/bureau      credit report + analysis (sandbox provider)
services/assistant   Llama 3.2 1B (llama.cpp) + conversation history (SQLite)
services/scheduler   timed jobs
packages/shared      service auth, HTTP helpers, language helpers
deploy/              Dockerfiles, docker-compose, .env.example
docs/                ARCHITECTURE.md  (and app/docs: the Intelligence Guide PDF)
```

## Run it locally

```bash
(cd app && npm install) && (cd services/assistant && npm install)
npm run model:download            # Llama 3.2 1B Instruct Q4_K_M, ~0.8 GB (Llama 3.2 Community License, "Built with Llama")
(cd app && npm run build)
npm run dev:all -- --prod         # core :3100 + aggregator :3201 + bureau :3202 + assistant :3203 + scheduler :3204
```

Open http://localhost:3100, register, load the demo data, then try **Bank links** (sandbox OTP `123456`), **Cards**, **UPI**, **Credit score** and the **Assistant**.

Tests: `npm run test:all` (shared + 4 services with `node --test`, core with Vitest). With the stack running, `python3 scripts/e2e-smoke.py` exercises all services together.

Production: see `docs/ARCHITECTURE.md` and `deploy/docker-compose.yml`. Nothing here is a real bank, bureau or payment integration until you configure one (see "What is real and what is a sandbox").

## Licences

Llama 3.2 is used under the Llama 3.2 Community License (https://www.llama.com/llama3_2/license/). **Built with Llama.**
