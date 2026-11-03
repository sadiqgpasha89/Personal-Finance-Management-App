import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';

const g = globalThis as unknown as { __db?: DatabaseSync };
export function db(): DatabaseSync {
  if (g.__db) return g.__db;
  const file = process.env.LEDGERLY_DB ?? path.join(process.cwd(), 'data', 'ledgerly.db');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const d = new DatabaseSync(file);
  d.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  d.exec(SCHEMA); migrate(d);
  g.__db = d;
  return d;
}
/** Adds columns to tables created by earlier versions (CREATE TABLE IF NOT EXISTS never alters). */
function migrate(d: DatabaseSync) {
  const addCol = (table: string, col: string, ddl: string) => { if (!(d.prepare(`PRAGMA table_info(${table})`).all() as any[]).some((c) => c.name === col)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`); };
  addCol('transactions', 'card_id', 'INTEGER REFERENCES cards(id) ON DELETE SET NULL');
  addCol('transactions', 'payment_method', 'TEXT');
  addCol('transactions', 'upi_vpa', 'TEXT');
  addCol('transactions', 'upi_ref', 'TEXT');
  d.exec('CREATE INDEX IF NOT EXISTS tx_card ON transactions(card_id); CREATE INDEX IF NOT EXISTS tx_upi_ref ON transactions(workspace_id, upi_ref); CREATE INDEX IF NOT EXISTS tx_ext ON transactions(workspace_id, account_id, external_id);');
}
export type Row = Record<string, any>;
export const all = (sql: string, ...p: any[]): Row[] => db().prepare(sql).all(...p) as Row[];
export const get = (sql: string, ...p: any[]): Row | undefined => db().prepare(sql).get(...p) as Row | undefined;
export const run = (sql: string, ...p: any[]) => db().prepare(sql).run(...p);
let depth = 0;
/** Re-entrant transaction: outer = BEGIN/COMMIT, nested = SAVEPOINT. */
export function tx<T>(fn: () => T): T {
  const d = db(); const sp = `sp${depth}`;
  d.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`); depth++;
  try { const r = fn(); depth--; d.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`); return r; }
  catch (e) { depth--; d.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`); throw e; }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, pw_hash TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  failed_logins INTEGER DEFAULT 0, locked_until INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL, ua TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS workspaces(id INTEGER PRIMARY KEY, name TEXT NOT NULL, owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  base_currency TEXT NOT NULL DEFAULT 'USD', month_start_day INTEGER NOT NULL DEFAULT 1, timezone TEXT DEFAULT 'UTC', privacy_mode INTEGER DEFAULT 0, onboarded INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS memberships(workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL DEFAULT 'owner', PRIMARY KEY(workspace_id,user_id));
CREATE TABLE IF NOT EXISTS accounts(id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, name TEXT NOT NULL,
  type TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'USD', opening_balance INTEGER NOT NULL DEFAULT 0, is_archived INTEGER DEFAULT 0, spending INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0, color TEXT, statement_close_day INTEGER, payment_due_day INTEGER, credit_limit INTEGER,
  apr REAL, min_payment INTEGER, loan_principal INTEGER, loan_term_months INTEGER, loan_start TEXT);
CREATE TABLE IF NOT EXISTS categories(id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'expense',
  group_name TEXT, color TEXT, essential INTEGER DEFAULT 0, UNIQUE(workspace_id,name));
CREATE TABLE IF NOT EXISTS transactions(id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, posted_date TEXT NOT NULL, amount INTEGER NOT NULL, currency TEXT NOT NULL,
  base_amount INTEGER NOT NULL, fx_rate REAL NOT NULL DEFAULT 1, fx_overridden INTEGER DEFAULT 0,
  kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'posted', description TEXT NOT NULL DEFAULT '', merchant TEXT, category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  notes TEXT, tags TEXT DEFAULT '[]', transfer_pair_id INTEGER, refund_of_id INTEGER, reimbursable INTEGER DEFAULT 0, reimbursed_amount INTEGER DEFAULT 0,
  reconciled INTEGER DEFAULT 0, external_id TEXT, import_batch_id INTEGER, recurring_id INTEGER, auto_categorized INTEGER DEFAULT 0,
  deleted_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, row_version INTEGER DEFAULT 1);
CREATE INDEX IF NOT EXISTS tx_ws_date ON transactions(workspace_id, posted_date DESC);
CREATE INDEX IF NOT EXISTS tx_acct_date ON transactions(workspace_id, account_id, posted_date);
CREATE TABLE IF NOT EXISTS transaction_splits(id INTEGER PRIMARY KEY, transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE, category_id INTEGER REFERENCES categories(id), amount INTEGER NOT NULL, notes TEXT);
CREATE TABLE IF NOT EXISTS merchant_memory(workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, merchant TEXT NOT NULL, category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE, PRIMARY KEY(workspace_id,merchant));
CREATE TABLE IF NOT EXISTS rules(id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, priority INTEGER DEFAULT 100, conditions_json TEXT NOT NULL, actions_json TEXT NOT NULL, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS import_batches(id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, account_id INTEGER, source TEXT, row_count INTEGER, skipped INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS import_mappings(id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, name TEXT, header_sig TEXT, mapping_json TEXT);
CREATE TABLE IF NOT EXISTS budgets(id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL, rollover TEXT NOT NULL DEFAULT 'none', UNIQUE(workspace_id,category_id));
CREATE TABLE IF NOT EXISTS sinking_funds(id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, name TEXT NOT NULL, category_id INTEGER, target_amount INTEGER NOT NULL, due_date TEXT NOT NULL, balance INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS goals(id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, name TEXT NOT NULL, type TEXT DEFAULT 'custom',
  target_amount INTEGER NOT NULL, target_date TEXT, linked_account_id INTEGER, current_amount INTEGER DEFAULT 0, status TEXT DEFAULT 'active');
CREATE TABLE IF NOT EXISTS goal_contributions(id INTEGER PRIMARY KEY, goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE, amount INTEGER NOT NULL, date TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS recurring_items(id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'expense',
  amount INTEGER NOT NULL, account_id INTEGER, category_id INTEGER, cadence TEXT NOT NULL, next_due TEXT NOT NULL, end_date TEXT, is_bill INTEGER DEFAULT 1, auto_post INTEGER DEFAULT 0, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS bill_payments(id INTEGER PRIMARY KEY, recurring_id INTEGER NOT NULL REFERENCES recurring_items(id) ON DELETE CASCADE, due_date TEXT NOT NULL, paid_date TEXT, transaction_id INTEGER, UNIQUE(recurring_id,due_date));
CREATE TABLE IF NOT EXISTS manual_assets(id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, name TEXT NOT NULL, kind TEXT NOT NULL, value INTEGER NOT NULL, currency TEXT DEFAULT 'USD', is_liability INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS holdings(id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, symbol TEXT NOT NULL, asset_class TEXT DEFAULT 'stock', quantity REAL NOT NULL, cost_basis INTEGER NOT NULL, price INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS net_worth_snapshots(workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, date TEXT NOT NULL, assets INTEGER, liabilities INTEGER, net_worth INTEGER, PRIMARY KEY(workspace_id,date));
CREATE TABLE IF NOT EXISTS fx_rates(quote TEXT PRIMARY KEY, rate REAL NOT NULL);
CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL, type TEXT, title TEXT, body TEXT, read_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, dedupe_key TEXT, UNIQUE(workspace_id,dedupe_key));
CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY, workspace_id INTEGER, actor_id INTEGER, entity TEXT, entity_id INTEGER, action TEXT, detail TEXT, at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS profiles(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, full_name TEXT, phone TEXT, date_of_birth TEXT, country TEXT, city TEXT,
  occupation TEXT, employment_type TEXT, income_range TEXT, household_size INTEGER, risk_tolerance TEXT, goals_json TEXT NOT NULL DEFAULT '[]',
  personalize_offers INTEGER NOT NULL DEFAULT 1, ai_assistant INTEGER NOT NULL DEFAULT 0, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS offer_actions(workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, offer_id TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(workspace_id,offer_id));
CREATE TABLE IF NOT EXISTS cards(id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  nickname TEXT NOT NULL, kind TEXT NOT NULL, network TEXT NOT NULL DEFAULT 'other', issuer TEXT, last4 TEXT NOT NULL, expiry_month INTEGER, expiry_year INTEGER,
  credit_limit INTEGER, statement_day INTEGER, due_day INTEGER, annual_fee INTEGER DEFAULT 0, fee_waiver_spend INTEGER, rewards TEXT, daily_limit INTEGER,
  status TEXT NOT NULL DEFAULT 'active', color TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS upi_payees(id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, name TEXT NOT NULL, vpa TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL, recurring_id INTEGER REFERENCES recurring_items(id) ON DELETE SET NULL, note TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(workspace_id, vpa));
CREATE TABLE IF NOT EXISTS upi_ids(id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, vpa TEXT NOT NULL, account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL, app TEXT, UNIQUE(workspace_id, vpa));
CREATE TABLE IF NOT EXISTS goal_schedules(id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL, cadence TEXT NOT NULL, next_run TEXT NOT NULL, from_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, active INTEGER NOT NULL DEFAULT 1,
  last_run TEXT, last_status TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(goal_id));
CREATE TABLE IF NOT EXISTS goal_runs(id INTEGER PRIMARY KEY, schedule_id INTEGER NOT NULL REFERENCES goal_schedules(id) ON DELETE CASCADE, run_date TEXT NOT NULL, status TEXT NOT NULL, amount INTEGER, txn_id INTEGER, message TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(schedule_id, run_date));
CREATE TABLE IF NOT EXISTS bank_links(id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, consent_id TEXT NOT NULL, aa_handle TEXT NOT NULL, mobile_masked TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING', created_at TEXT DEFAULT CURRENT_TIMESTAMP, last_sync_at TEXT, last_sync_note TEXT, expires_at TEXT, UNIQUE(consent_id));
CREATE TABLE IF NOT EXISTS linked_accounts(id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, link_id INTEGER NOT NULL REFERENCES bank_links(id) ON DELETE CASCADE,
  fip_id TEXT NOT NULL, fip_name TEXT, link_ref TEXT NOT NULL, masked_acc TEXT, account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL, reported_balance INTEGER, UNIQUE(link_id, link_ref));
CREATE TABLE IF NOT EXISTS credit_consents(id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL, user_id INTEGER NOT NULL, purpose TEXT NOT NULL, text_version TEXT NOT NULL, given_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS credit_reports(id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, provider TEXT NOT NULL, sample INTEGER NOT NULL DEFAULT 1,
  pan_last4 TEXT, score INTEGER, fetched_at TEXT DEFAULT CURRENT_TIMESTAMP, payload_json TEXT NOT NULL);
INSERT OR IGNORE INTO fx_rates(quote,rate) VALUES('USD',1),('EUR',0.92),('GBP',0.79),('INR',83.2),('CAD',1.36),('AUD',1.52),('JPY',150);
`;

export const DEFAULT_CATEGORIES: [string, string, string, number][] = [
  ['Salary', 'income', 'Income', 0], ['Other Income', 'income', 'Income', 0], ['Interest', 'income', 'Income', 0],
  ['Housing', 'expense', 'Needs', 1], ['Groceries', 'expense', 'Needs', 1], ['Utilities', 'expense', 'Needs', 1], ['Transport', 'expense', 'Needs', 1],
  ['Health', 'expense', 'Needs', 1], ['Insurance', 'expense', 'Needs', 1], ['Dining', 'expense', 'Wants', 0], ['Shopping', 'expense', 'Wants', 0],
  ['Entertainment', 'expense', 'Wants', 0], ['Subscriptions', 'expense', 'Wants', 0], ['Travel', 'expense', 'Wants', 0], ['Education', 'expense', 'Wants', 0],
  ['Savings', 'expense', 'Savings', 0], ['Debt Payment', 'expense', 'Needs', 1], ['Gifts & Donations', 'expense', 'Wants', 0], ['Fees & Interest', 'expense', 'Needs', 0], ['Other', 'expense', 'Wants', 0],
];
