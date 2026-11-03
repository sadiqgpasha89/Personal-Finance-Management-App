# Ledgerly — Personal Finance Management App

Local-first, privacy-respecting personal finance app: accounts, transactions, CSV import, budgets with rollover,
bills & subscriptions, goals, debt payoff, net worth, forecasts, explainable insights and a financial-health score.

> This folder is the **core** of a multi-service system. See the repository README and `docs/ARCHITECTURE.md` for the services (aggregator, bureau, assistant, scheduler), Docker deployment and what is sandboxed.

## Run

```bash
npm install
npm run dev        # http://localhost:3100  (or: npm run build && npm start)
npm test           # domain + service tests (Vitest)
```

Requires Node ≥ 22.13 (uses the built-in `node:sqlite`; no native modules). Data lives in `data/ledgerly.db`
(override with `LEDGERLY_DB`). Register, then click **Load demo data** on the dashboard for six months of sample data.

## Assistant, profile and offers

- **Assistant** (`/assistant`): ask about transactions, subscriptions, bills, budgets, debts, goals and offers in plain language. With `ANTHROPIC_API_KEY` set and the user's opt-in (Profile > Privacy choices) it uses **Claude Haiku 5.5** (`LEDGERLY_CHAT_MODEL` overrides) through a tool-use loop. The model can only call read-only, workspace-scoped tools (`src/lib/chat/tools.ts`), so every figure comes from the database and nothing can be written. Only the question and the tool results needed to answer are sent to the API. Without a key, without opt-in, or if the API call fails, a built-in offline engine (`src/lib/chat/local.ts`) answers from the same tools.
- **Profile** (`/profile`): personal details, work and household, goals and two privacy switches (personalise offers; allow the AI model). Included in the JSON export and deleted with the account.
- **Offers** (`/offers`): rules in `src/lib/domain/offers.ts` match a **sample catalogue** (fictional partners) against 3 months of the user's own history, show the evidence and assumptions behind each match, and list the offers that do not fit yet with the reason. Save or hide an offer; nothing leaves the app.

Copy `.env.example` to `.env.local` to configure the key.

## Importing bank statements

`/import` accepts **PDF statements** (text-based, including password-protected), **OFX/QFX**, **QIF** and **CSV**. PDFs are read with positioned text extraction (`pdfjs-dist`), then parsed by `src/lib/domain/statements.ts`: columns, running balance, printed signs and statement period decide each transaction's date and sign. The result is **reconciled against the statement's opening and closing balances**, and the page tells you whether it matches before anything is saved. Output flows into the normal import preview, duplicate detection, auto-categorization and undo.

- Scanned or photographed PDFs have no text layer and are rejected (no OCR).
- If a PDF reads poorly and the AI assistant is enabled, "Re-read with AI" sends the statement text (long account numbers masked) to the model, and the result goes through the same reconciliation.
- Try it with the synthetic files in `public/samples/` or `samples/statements/`. Parser tests: `src/lib/statements.test.ts`.

Docs: [docs/Ledgerly-Intelligence-Guide.pdf](docs/Ledgerly-Intelligence-Guide.pdf).

## Layout

| Path | What |
|---|---|
| `src/lib/domain/` | Pure, tested logic: money (integer minor units), dates, recurrence, amortization, debt payoff, budgets, categorization, CSV, forecast, subscriptions, insights, health score |
| `src/lib/db.ts` | SQLite schema + re-entrant transactions |
| `src/lib/auth.ts` | scrypt passwords, hashed server-side sessions, rate limiting, audit log |
| `src/lib/service.ts` | Ledger operations & aggregates (balances, spend, budgets, net worth, safe-to-spend) |
| `src/lib/api.ts` | REST JSON API (`/api/*`), zod validation, CSRF/origin checks |
| `src/app/(app)/` | UI pages |

## Design decisions
See `../plan.md` §24 (build log, scope mapping, enhancements, known gaps).
