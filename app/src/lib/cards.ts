import { z } from 'zod';
import { all, get, Row } from './db';
import { Ctx } from './auth';
import * as S from './service';
import { addDays, budgetPeriod, today } from './domain/dates';
import { KINDS, NETWORKS, STATUSES, containsCardNumber, expiryState, feeWaiverProgress, nextDayOfMonth, utilization, utilizationBand } from './domain/cards';

const minor = z.number().int().safe();
const day = z.number().int().min(1).max(31);
export const cardSchema = z.object({
  nickname: z.string().trim().min(1).max(40), kind: z.enum(KINDS), network: z.enum(NETWORKS).default('other'), issuer: z.string().trim().max(60).nullish(),
  last4: z.string().regex(/^\d{4}$/, 'Enter only the last 4 digits'), expiry_month: z.number().int().min(1).max(12).nullish(), expiry_year: z.number().int().min(2000).max(2100).nullish(),
  account_id: z.number().int().nullish(), credit_limit: minor.min(0).nullish(), statement_day: day.nullish(), due_day: day.nullish(), annual_fee: minor.min(0).nullish(), fee_waiver_spend: minor.min(0).nullish(),
  rewards: z.string().trim().max(120).nullish(), daily_limit: minor.min(0).nullish(), status: z.enum(STATUSES).default('active'), color: z.string().max(20).nullish(),
}).superRefine((v, ctx) => { for (const k of ['nickname', 'issuer', 'rewards'] as const) if (v[k] && containsCardNumber(v[k]!)) ctx.addIssue({ code: 'custom', path: [k], message: 'Do not enter a full card number. Ledgerly only needs the last 4 digits.' }); });

/** A card's spending: transactions tagged with it, plus untagged ones on its linked account when it is the only active card there. */
const SCOPE = `(t.card_id=? OR (t.card_id IS NULL AND t.account_id=? AND t.account_id IS NOT NULL AND (SELECT COUNT(*) FROM cards k WHERE k.account_id=t.account_id AND k.status='active')=1))`;
const spend = (c: Ctx, k: Row, from: string, to: string) => (get(`SELECT COALESCE(SUM(-t.base_amount),0) s, COUNT(*) n FROM transactions t WHERE t.workspace_id=? AND t.deleted_at IS NULL AND t.kind='expense' AND ${SCOPE} AND t.posted_date BETWEEN ? AND ?`, c.wid, k.id, k.account_id ?? -1, from, to) as Row);

export function listCards(c: Ctx) {
  const now = today(); const per = budgetPeriod(now, c.startDay); const year = now.slice(0, 4) + '-01-01';
  const cards = all('SELECT k.*, a.name account_name, a.type account_type FROM cards k LEFT JOIN accounts a ON a.id=k.account_id WHERE k.workspace_id=? ORDER BY k.status!=\'active\', k.kind, k.id', c.wid);
  const bal = new Map(S.accountsWithBalance(c).map((a) => [a.id, a]));
  const items = cards.map((k): Row => {
    const month = spend(c, k, per.start, per.end), ytd = spend(c, k, year, now);
    const acct = k.account_id ? bal.get(k.account_id) : null;
    const owed = k.kind === 'credit' ? (acct && ['credit_card', 'loan'].includes(acct.type) ? Math.max(0, -acct.balance_base) : month.s) : null;
    const u = k.kind === 'credit' ? utilization(owed ?? 0, k.credit_limit) : null;
    const exp = expiryState(k.expiry_month, k.expiry_year, now);
    return {
      ...k, spent_period: month.s, txn_count_period: month.n, spent_ytd: ytd.s, owed, utilization: u, utilization_band: utilizationBand(u), available_credit: k.kind === 'credit' && k.credit_limit ? Math.max(0, k.credit_limit - (owed ?? 0)) : null,
      next_due: k.kind === 'credit' && k.due_day ? nextDayOfMonth(k.due_day, now) : null, expiry: exp, fee: feeWaiverProgress(ytd.s, k.fee_waiver_spend, k.annual_fee),
    };
  });
  const credit = items.filter((k) => k.kind === 'credit' && k.status === 'active' && k.credit_limit);
  const limit = credit.reduce((a, k) => a + k.credit_limit, 0), used = credit.reduce((a, k) => a + (k.owed ?? 0), 0);
  return {
    base: c.base, items, period: per,
    summary: { total_limit: limit, total_owed: used, utilization: utilization(used, limit), band: utilizationBand(utilization(used, limit)), active: items.filter((k) => k.status === 'active').length, spent_period: items.reduce((a, k) => a + k.spent_period, 0) },
    alerts: [
      ...items.filter((k) => k.status === 'active' && ['expiring', 'expired'].includes(k.expiry.state)).map((k) => ({ type: 'expiry', card_id: k.id, text: `${k.nickname} ${k.expiry.state === 'expired' ? 'has expired' : `expires in ${k.expiry.daysLeft} days`}` })),
      ...items.filter((k) => k.next_due && k.owed && k.status === 'active' && k.next_due <= addDays(now, 7)).map((k) => ({ type: 'due', card_id: k.id, text: `${k.nickname} payment due ${k.next_due}` })),
      ...items.filter((k) => k.utilization_band === 'high' && k.status === 'active').map((k) => ({ type: 'utilization', card_id: k.id, text: `${k.nickname} is ${Math.round((k.utilization ?? 0) * 100)}% utilized` })),
    ],
  };
}
export const cardTransactions = (c: Ctx, id: number, limit = 40) => all(`SELECT t.id,t.posted_date,t.description,t.merchant,t.amount,t.currency,t.payment_method,cat.name category FROM transactions t LEFT JOIN categories cat ON cat.id=t.category_id
  WHERE t.workspace_id=? AND t.deleted_at IS NULL AND ${SCOPE} ORDER BY t.posted_date DESC, t.id DESC LIMIT ?`, c.wid, id, (get('SELECT account_id FROM cards WHERE id=?', id)?.account_id as number | undefined) ?? -1, limit);
