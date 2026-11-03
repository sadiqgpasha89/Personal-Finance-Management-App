import { all, get, run, tx, Row } from './db';
import { ApiError, Ctx, audit, ctxForUser } from './auth';
import * as S from './service';
import { call, ServiceError } from './integrations/services';

const PUBLIC_URL = () => process.env.PUBLIC_URL ?? 'http://localhost:3100';
const wrap = async <T,>(f: () => Promise<T>) => { try { return await f(); } catch (e) { if (e instanceof ServiceError) throw new ApiError(e.status === 503 ? 503 : e.status >= 500 ? 502 : e.status, e.status === 503 ? 'The bank-linking service is not running. Start the aggregator service.' : e.message, e.code, e.fields); throw e; } };
const user = (c: Ctx) => ({ id: c.userId, wid: c.wid });
const METHOD: Record<string, string> = { UPI: 'upi', CARD: 'card', ATM: 'cash', FT: 'netbanking', NEFT: 'netbanking', IMPS: 'netbanking', RTGS: 'netbanking' };

export const providers = (c: Ctx) => wrap(() => call('aggregator', '/v1/providers', { user: user(c) }));
export async function startLink(c: Ctx, b: { mobile: string; aa_handle: string; months?: number }) {
  const r = await wrap(() => call<{ id: string; approval_url: string }>('aggregator', '/v1/consents', { user: user(c), body: { ...b, redirect_url: `${PUBLIC_URL()}/connections` } }));
  run('INSERT INTO bank_links(workspace_id,consent_id,aa_handle,mobile_masked,status) VALUES(?,?,?,?,?)', c.wid, r.id, b.aa_handle, `${b.mobile.slice(0, 2)}XXXXXX${b.mobile.slice(-2)}`, 'PENDING'); audit(c, 'bank_link', null, 'start', { aa: b.aa_handle });
  return { approval_url: r.approval_url };
}
export async function listLinks(c: Ctx) {
  const links = all('SELECT * FROM bank_links WHERE workspace_id=? ORDER BY id DESC', c.wid);
  for (const l of links.filter((x) => x.status === 'PENDING')) { try { const s = await call<{ status: string; expires_at: string }>('aggregator', `/v1/consents/${l.consent_id}`, { user: user(c) }); if (s.status !== l.status) { run('UPDATE bank_links SET status=?, expires_at=? WHERE id=?', s.status, s.expires_at, l.id); l.status = s.status; } } catch { /* the page still renders; status refreshes next time */ } }
  const accts = new Map(S.accountsWithBalance(c).map((a) => [a.id, a]));
  return links.map((l) => ({ ...l, accounts: all('SELECT * FROM linked_accounts WHERE link_id=?', l.id).map((a) => ({ ...a, local_balance: accts.get(a.account_id)?.balance ?? null, drift: a.reported_balance != null && accts.get(a.account_id) ? accts.get(a.account_id)!.balance - a.reported_balance : null })) }));
}
export async function syncLink(c: Ctx, id: number) {
  const l = get('SELECT * FROM bank_links WHERE id=? AND workspace_id=?', id, c.wid); if (!l) throw new ApiError(404, 'Link not found');
  const data = await wrap(() => call<{ accounts: any[]; fetched_at: string }>('aggregator', `/v1/consents/${l.consent_id}/fetch`, { user: user(c), body: {}, timeoutMs: 60_000 }));
  let created = 0, added = 0, skipped = 0; const notes: string[] = [];
  tx(() => {
    for (const a of data.accounts) {
      let la = get('SELECT * FROM linked_accounts WHERE link_id=? AND link_ref=?', l.id, a.link_ref);
      if (!la) {
        const name = `${a.fip_name} ${a.masked_acc}`.trim().slice(0, 60); const aid = Number(run(`INSERT INTO accounts(workspace_id,name,type,currency,opening_balance,spending) VALUES(?,?,?,?,?,?)`, c.wid, name, a.kind, a.currency, a.opening_balance, +(a.kind === 'checking')).lastInsertRowid);
        const lid = Number(run('INSERT INTO linked_accounts(workspace_id,link_id,fip_id,fip_name,link_ref,masked_acc,account_id,reported_balance) VALUES(?,?,?,?,?,?,?,?)', c.wid, l.id, a.fip_id, a.fip_name, a.link_ref, a.masked_acc, aid, a.balance).lastInsertRowid); la = get('SELECT * FROM linked_accounts WHERE id=?', lid)!; created++;
      }
      const rules = S.loadRules(c.wid), mem = S.loadMemory(c.wid); const seen = new Set(all('SELECT external_id FROM transactions WHERE account_id=? AND external_id IS NOT NULL', la.account_id).map((r) => r.external_id as string));
      for (const t of a.txns as any[]) {
        if (seen.has(t.txn_id)) { skipped++; continue; }
        S.insertTxn(c, { account_id: la.account_id, posted_date: t.date, amount: t.amount, description: t.narration || t.mode, external_id: t.txn_id, payment_method: METHOD[t.mode] ?? null }, rules, mem); added++;
      }
      run('UPDATE linked_accounts SET reported_balance=? WHERE id=?', a.balance, la.id);
      const mine = S.accountsWithBalance(c).find((x) => x.id === la!.account_id)!; if (mine.balance !== a.balance) notes.push(`${a.fip_name}: Ledgerly shows ${(mine.balance / 100).toFixed(2)} but the bank reports ${(a.balance / 100).toFixed(2)}`);
    }
    run("UPDATE bank_links SET last_sync_at=datetime('now'), last_sync_note=?, status='ACTIVE' WHERE id=?", notes.join('; ') || null, l.id);
  });
  audit(c, 'bank_link', id, 'sync', { added, accounts: data.accounts.length }); return { accounts: data.accounts.length, created_accounts: created, new_transactions: added, already_imported: skipped, drift_notes: notes };
}
export async function unlink(c: Ctx, id: number) {
  const l = get('SELECT * FROM bank_links WHERE id=? AND workspace_id=?', id, c.wid); if (!l) throw new ApiError(404, 'Link not found');
  await wrap(() => call('aggregator', `/v1/consents/${l.consent_id}`, { user: user(c), method: 'DELETE' })).catch(() => {}); run("UPDATE bank_links SET status='REVOKED' WHERE id=?", id); audit(c, 'bank_link', id, 'revoke');
}
/** Scheduler hook: refreshes every active link that has not synced in 24 hours. Imported data stays; only new transactions are added. */
export async function syncStaleLinks(maxAgeHours = 24) {
  let synced = 0, failed = 0;
  for (const l of all(`SELECT l.*, w.owner_id FROM bank_links l JOIN workspaces w ON w.id=l.workspace_id WHERE l.status='ACTIVE' AND (l.last_sync_at IS NULL OR l.last_sync_at < datetime('now', ?))`, `-${maxAgeHours} hours`) as Row[]) {
    const c = ctxForUser(l.owner_id, l.workspace_id); if (!c) continue; try { await syncLink(c, l.id); synced++; } catch { failed++; }
  }
  return { synced, failed };
}
