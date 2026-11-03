import { all, get, run } from './db';
import { ApiError, Ctx, audit } from './auth';
import { call, ServiceError } from './integrations/services';
import * as S from './service';
import { listCards } from './cards';

export const CONSENT_TEXT_VERSION = 'credit-report-v1';
export const CONSENT_TEXT = 'I authorise Ledgerly to request my credit report and score from a credit information company for the purpose of showing it to me. I understand my PAN is sent for this request and is not stored, and that I can delete the saved report at any time.';

export interface FetchInput { name: string; dob: string; pan: string; mobile: string; consent: boolean }
export async function fetchReport(c: Ctx, b: FetchInput) {
  if (b.consent !== true) throw new ApiError(400, 'Consent is required', 'validation', { consent: 'Please tick to give consent' });
  let r: { report: any };
  try { r = await call('bureau', '/v1/reports', { user: { id: c.userId, wid: c.wid }, body: { name: b.name, dob: b.dob, pan: b.pan, mobile: b.mobile, consent: { given: true, text_version: CONSENT_TEXT_VERSION } }, timeoutMs: 60_000 }); }
  catch (e) { if (e instanceof ServiceError) throw new ApiError(e.status === 503 ? 503 : e.status >= 500 ? 502 : e.status, e.status === 503 ? 'The credit report service is not running.' : e.message, e.code, e.fields); throw e; }
  run('INSERT INTO credit_consents(workspace_id,user_id,purpose,text_version) VALUES(?,?,?,?)', c.wid, c.userId, 'View my own credit report', CONSENT_TEXT_VERSION);
  const rep = r.report; const id = Number(run('INSERT INTO credit_reports(workspace_id,provider,sample,pan_last4,score,payload_json) VALUES(?,?,?,?,?,?)', c.wid, rep.provider, +rep.sample, rep.subject.pan_last4, rep.score.value, JSON.stringify(rep)).lastInsertRowid);
  audit(c, 'credit_report', id, 'fetch', { provider: rep.provider, sample: rep.sample }); return id;
}
export function creditOverview(c: Ctx) {
  const rows = all('SELECT id,provider,sample,pan_last4,score,fetched_at,payload_json FROM credit_reports WHERE workspace_id=? ORDER BY id DESC LIMIT 24', c.wid);
  const latest = rows[0] ? { id: rows[0].id, fetched_at: rows[0].fetched_at, ...JSON.parse(rows[0].payload_json) } : null; const cards = listCards(c).summary;
  return { latest, history: rows.map((r) => ({ id: r.id, score: r.score, fetched_at: r.fetched_at, sample: !!r.sample })).reverse(), consent_text: CONSENT_TEXT, ledgerly_card_utilization: cards.utilization, consents: (get('SELECT COUNT(*) n FROM credit_consents WHERE workspace_id=?', c.wid) as { n: number }).n };
}
export const deleteReports = (c: Ctx) => { run('DELETE FROM credit_reports WHERE workspace_id=?', c.wid); audit(c, 'credit_report', null, 'delete_all'); };
export const providerInfo = (c: Ctx) => call('bureau', '/v1/provider', { user: { id: c.userId, wid: c.wid } }).catch(() => null);
void S;
