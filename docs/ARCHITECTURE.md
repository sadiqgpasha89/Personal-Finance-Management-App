# Ledgerly architecture

Ledgerly is a **modular core plus four small services**. The ledger stays one deployable (a modular monolith) because it is one consistent database; the pieces that have a different security, compute or lifecycle profile are separate processes with their own data and a narrow, authenticated API.

```
                       browser
                          │ HTTPS (only core is public)
                 ┌────────▼─────────┐
                 │  core  :3100     │  Next.js UI + REST API + ledger (SQLite)
                 │  cards · UPI ·   │  domain modules in app/src/lib/domain (pure)
                 │  goals · offers  │
                 └─┬──────┬──────┬──┘
   signed tokens   │      │      │                         ┌───────────────┐
   (HMAC, 5 min)   │      │      └──────────────────────── │ scheduler     │ calls core every 5 min
        ┌──────────▼┐  ┌──▼────────┐  ┌────────────────┐   │ :3204         │ (goal auto-saves, stale bank syncs)
        │aggregator │  │ bureau    │  │ assistant      │   └───────────────┘
        │ :3201     │  │ :3202     │  │ :3203          │
        │ AA FIU    │  │ credit    │  │ Llama 3.2 1B   │──► calls core's read-only tool API
        │ client +  │  │ report +  │  │ + chat history │    (token names the user)
        │ sandbox   │  │ analysis  │  │ SQLite         │
        └───────────┘  └───────────┘  └────────────────┘
```

## Services

| Service | Port | Owns | Talks to | Why it is separate |
|---|---|---|---|---|
| **core** (`app/`) | 3100 | Ledger DB: users, accounts, transactions, cards, UPI payees, goals and schedules, bank links, credit reports | aggregator, bureau, assistant | The product. One database, one transaction boundary. |
| **aggregator** (`services/aggregator`) | 3201 | Consent metadata only (`aggregator.db`). **No account or transaction data is stored** | An Account Aggregator over HTTPS (or its built-in sandbox) | Holds the FIU private key and speaks a regulated protocol with its own crypto; different compliance surface. |
| **bureau** (`services/bureau`) | 3202 | Nothing (stateless) | A credit bureau partner (or sandbox) | Receives a PAN transiently; keep it away from the ledger process and its logs. |
| **assistant** (`services/assistant`) | 3203 | Conversation history (`assistant.db`) | core's `/api/internal/*` tool API | CPU/RAM heavy (1B model, ~1.5 GB resident); scales and restarts independently. |
| **scheduler** (`services/scheduler`) | 3204 | Nothing | core `/api/internal/jobs/run-due` | Timed work out of the web process; jobs are idempotent per (schedule, date). |
| **shared** (`packages/shared`) | – | – | – | HMAC service tokens, tiny HTTP server/client, logging, date-phrase parsing. No dependencies. |

### Boundaries and contracts

- **Data ownership.** A service never reads another service's database. The assistant reads the ledger only through core's validated, read-only tool API (12+ tools, zod-checked inputs, formatted outputs).
- **Service tokens.** `base64url(claims).base64url(HMAC-SHA256)` with `iss`, `aud`, `sub` (user id), `wid` (workspace), `iat`, `exp` (5 minutes). The audience must match the receiving service, so a token for the bureau is useless against core. The *user is taken from the token, never from a request body*.
- **Errors** are `{ code, message, fields? }` everywhere; clients map them to user-safe messages and never echo upstream internals.
- **Health.** Every service exposes `/healthz` and `/readyz`; compose healthchecks use them.
- **Failure isolation.** Core keeps working if any service is down: bank links and credit show a clear "service not running" message, the assistant falls back to built-in rules, and the scheduler's absence only delays auto-saves (core also runs due schedules whenever the Goals page or dashboard loads).

### Three flows

1. **Link a bank.** core → aggregator `POST /v1/consents` (mobile, AA handle) → aggregator signs a consent request (RS256 detached JWS) → AA returns a handle → user approves at the AA (sandbox: built-in consent screen) → AA notifies the aggregator webhook (signature checked) → core `POST /connections/:id/sync` → aggregator creates a Curve25519 key pair + nonce, requests the FI data, **decrypts** it (ECDH → HKDF → AES-GCM) and returns normalized accounts/transactions → core imports them idempotently by transaction id and checks that its balance equals the bank's.
2. **Ask the assistant.** core → assistant `POST /v1/chat` → Llama fills a small JSON form (intent, phrases) → code turns phrases into real dates, categories and merchants → assistant calls core's tools → answer rendered from the verified results → both turns saved in `assistant.db`.
3. **Auto-save to a goal.** scheduler → core `jobs/run-due` → for each schedule due on or before today (catching up missed dates, max 12) core moves the money in the ledger, once per (schedule, date).

## Deployment

`deploy/docker-compose.yml` publishes only `core` (plus the aggregator's consent screen on localhost). Two networks: `backend` (internal, no route to the internet) and `edge`. The assistant and scheduler are on `backend` only, so the on-device model physically cannot send data out; core, aggregator and bureau also join `edge` because they must reach banks, the AA and a bureau partner. Every container is read-only with all capabilities dropped and `no-new-privileges`. Secrets come from `deploy/.env` (`INTERNAL_API_SECRET` is required). The Llama model file is mounted read-only from `services/assistant/models`.

**Block `/api/internal/*` at your ingress/reverse proxy.** Those routes require a service token, but they should not be reachable from the internet at all.

### Scaling and what to change first

| Concern | Today | When you outgrow it |
|---|---|---|
| Ledger DB | SQLite (WAL), single writer | Move core to Postgres; the data layer is isolated in `app/src/lib/db.ts` and `service.ts` |
| Chat history | SQLite file owned by the assistant | One assistant replica per history file, or move the store to Postgres to run several |
| Assistant throughput | One model, requests serialized (about 3–6 s per question on CPU) | More replicas behind a queue, or a GPU build of llama.cpp |
| Rate limits | In-memory per process | Redis-backed limiter when core runs more than one replica |
| Scheduler | One instance | Safe to run two (idempotent), but one is enough |

## What is real and what is a sandbox

| Capability | Status |
|---|---|
| Account Aggregator link, consent, encrypted FI fetch | Implemented to the ReBIT/Sahamati spec as I understand it, **running against a built-in sandbox AA** with synthetic banks. Not yet verified against Anumati, Finvu or OneMoney. Going live needs FIU registration with an RBI-licensed AA, then `AA_MODE=live` plus their endpoint, keys and redirect template. Their sandboxes may differ in small details (key encoding, redirect parameters, polling). |
| CIBIL report | **Sandbox only.** CIBIL data is available to member institutions and authorised partners; the `http` provider is a stub for a partner that returns this service's tradeline shape. The sandbox score is clearly labelled and is not a CIBIL score. |
| UPI payments | Ledgerly **does not move money**. It builds standard `upi://pay` links and QR codes for any UPI app, parses UPI bank narrations, and records payments. Real in-app payments need a PSP/TPAP licence. |
| Goal auto-debit | In-ledger bookkeeping on the chosen date. It does **not** pull money from a bank account; that needs a bank mandate (UPI AutoPay / e-NACH). |
| Llama 3.2 1B | Real, on-device, CPU. Used for intent and slot extraction and follow-ups; answer text is template-rendered from verified data by default (see the Intelligence Guide). |
