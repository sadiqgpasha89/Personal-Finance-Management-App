import { z } from 'zod';
import { all, get, run, tx, Row } from './db';
import { ApiError, Ctx, audit } from './auth';
import * as S from './service';
import { isDate, today } from './domain/dates';
import { nextOccurrence, Cadence } from './domain/recurrence';
import { formatMoney } from './domain/money';

/**
 * Scheduled goal contributions. On the chosen date the amount is moved from a source account into the goal inside Ledgerly:
 * a transfer when the goal tracks a savings account, otherwise an expense in "Savings" plus a goal contribution.
 * This keeps the ledger accurate; it does NOT move money at your bank (that needs a bank mandate such as UPI AutoPay).
 */
export const CADENCE = ['once', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'] as const;
export const scheduleSchema = z.object({ amount: z.number().int().positive().safe(), cadence: z.enum(CADENCE), next_run: z.string().refine(isDate, 'Use YYYY-MM-DD'), from_account_id: z.number().int(), active: z.boolean().default(true) });
const MAX_CATCHUP = 12;
const SPENDABLE = ['checking', 'savings', 'cash', 'wallet'];

export function getSchedule(c: Ctx, goalId: number) {
  const s = get('SELECT s.*, a.name from_account_name FROM goal_schedules s JOIN accounts a ON a.id=s.from_account_id WHERE s.goal_id=? AND s.workspace_id=?', goalId, c.wid);
  return s ? { ...s, active: !!s.active, runs: all('SELECT run_date,status,amount,message FROM goal_runs WHERE schedule_id=? ORDER BY run_date DESC, id DESC LIMIT 6', s.id) } : null;
}
export function saveSchedule(c: Ctx, goalId: number, b: z.infer<typeof scheduleSchema>) {
  const goal = get('SELECT * FROM goals WHERE id=? AND workspace_id=?', goalId, c.wid); if (!goal) throw new ApiError(404, 'Goal not found');
  const from = S.account(c, b.from_account_id);
  if (!SPENDABLE.includes(from.type) || from.is_archived) throw new ApiError(400, 'Choose a checking, savings, cash or wallet account to take the money from', 'validation', { from_account_id: 'Not a spendable account' });
  if (goal.linked_account_id === b.from_account_id) throw new ApiError(400, 'The source account is the account this goal already tracks', 'validation', { from_account_id: 'Pick a different account' });
  if (b.next_run < today() && b.cadence === 'once') throw new ApiError(400, 'Pick today or a future date', 'validation', { next_run: 'Must not be in the past' });
  run(`INSERT INTO goal_schedules(workspace_id,goal_id,amount,cadence,next_run,from_account_id,active) VALUES(?,?,?,?,?,?,?) ON CONFLICT(goal_id) DO UPDATE SET amount=excluded.amount,cadence=excluded.cadence,next_run=excluded.next_run,from_account_id=excluded.from_account_id,active=excluded.active`,
    c.wid, goalId, b.amount, b.cadence, b.next_run, b.from_account_id, +b.active);
  audit(c, 'goal_schedule', goalId, 'save', { amount: b.amount, cadence: b.cadence }); return getSchedule(c, goalId);
}
export function deleteSchedule(c: Ctx, goalId: number) { run('DELETE FROM goal_schedules WHERE goal_id=? AND workspace_id=?', goalId, c.wid); }

function notify(wid: number, title: string, body: string, key: string) { run('INSERT OR IGNORE INTO notifications(workspace_id,type,title,body,dedupe_key) VALUES(?,?,?,?,?)', wid, 'goal', title, body, key); }

/** Runs every due occurrence (with catch-up for days the app was not open) for one workspace. Idempotent: (schedule, date) runs once. */
export function runDueGoalSchedules(c: Ctx, asOf = today()): { ran: number; skipped: number } {
  let ran = 0, skipped = 0;
  for (const s of all('SELECT * FROM goal_schedules WHERE workspace_id=? AND active=1 AND next_run<=?', c.wid, asOf)) {
    const goal = get('SELECT * FROM goals WHERE id=?', s.goal_id) as Row; let next = s.next_run as string, guard = 0;
    while (next <= asOf && guard++ < MAX_CATCHUP) {
      const date = next; const done = get('SELECT 1 FROM goal_runs WHERE schedule_id=? AND run_date=?', s.id, date);
      if (!done) {
        const from = S.accountsWithBalance(c).find((a) => a.id === s.from_account_id);
        if (!from || from.is_archived) { run('INSERT INTO goal_runs(schedule_id,run_date,status,amount,message) VALUES(?,?,?,?,?)', s.id, date, 'failed', s.amount, 'Source account is missing or archived'); skipped++; }
        else if (from.balance < s.amount) {
          const msg = `Not enough in ${from.name} (${formatMoney(from.balance, from.currency)}) for ${formatMoney(s.amount, from.currency)}`; run('INSERT INTO goal_runs(schedule_id,run_date,status,amount,message) VALUES(?,?,?,?,?)', s.id, date, 'skipped', s.amount, msg); skipped++;
          notify(c.wid, `Auto-save skipped for ${goal.name}`, msg, `goalrun:${s.id}:${date}`);
        } else {
          const txn = tx(() => {
            let tid: number;
            if (goal.linked_account_id) { tid = S.insertTransfer(c, s.from_account_id, goal.linked_account_id, s.amount, date, `Auto-save to ${goal.name}`); }
            else {
              tid = S.insertTxn(c, { account_id: s.from_account_id, posted_date: date, amount: -s.amount, description: `Auto-save to goal: ${goal.name}`, merchant: `Goal: ${goal.name}`, category_id: S.ensureCategory(c.wid, 'Savings'), skipAuto: true });
              run('INSERT INTO goal_contributions(goal_id,amount,date) VALUES(?,?,?)', goal.id, s.amount, date);
              run("UPDATE goals SET current_amount=current_amount+?, status=CASE WHEN current_amount+?>=target_amount THEN 'done' ELSE status END WHERE id=?", s.amount, s.amount, goal.id);
            }
            run('INSERT INTO goal_runs(schedule_id,run_date,status,amount,txn_id,message) VALUES(?,?,?,?,?,?)', s.id, date, 'done', s.amount, tid, `Moved ${formatMoney(s.amount, from.currency)} from ${from.name}`);
            return tid;
          });
          audit(c, 'goal_schedule', goal.id, 'run', { date, txn }); ran++;
          notify(c.wid, `Saved ${formatMoney(s.amount, from.currency)} to ${goal.name}`, `Auto-save on ${date} from ${from.name}.`, `goalrun:${s.id}:${date}`);
        }
      }
      next = s.cadence === 'once' ? '9999-12-31' : nextOccurrence(date, s.cadence as Cadence, Number(date.slice(8, 10)));
    }
    const finished = s.cadence === 'once' || get("SELECT status FROM goals WHERE id=?", goal.id)?.status === 'done';
    run('UPDATE goal_schedules SET next_run=?, active=?, last_run=?, last_status=? WHERE id=?', next === '9999-12-31' ? s.next_run : next, finished ? 0 : 1, asOf, (get('SELECT status FROM goal_runs WHERE schedule_id=? ORDER BY run_date DESC, id DESC LIMIT 1', s.id)?.status as string) ?? null, s.id);
  }
  return { ran, skipped };
}
/** Used by the scheduler service: every workspace that has something due. */
export function runAllDueGoalSchedules(asOf = today()) {
  let ran = 0, skipped = 0;
  for (const w of all('SELECT DISTINCT s.workspace_id wid, w.owner_id, w.base_currency, w.month_start_day FROM goal_schedules s JOIN workspaces w ON w.id=s.workspace_id WHERE s.active=1 AND s.next_run<=?', asOf)) {
    const u = get('SELECT id,email,name FROM users WHERE id=?', w.owner_id); if (!u) continue;
    const r = runDueGoalSchedules({ userId: u.id, wid: w.wid, email: u.email, name: u.name, base: w.base_currency, startDay: w.month_start_day, privacy: false, role: 'owner' }, asOf); ran += r.ran; skipped += r.skipped;
  }
  return { ran, skipped };
}
