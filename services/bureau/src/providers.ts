import { createHash } from 'node:crypto';
import { analyze, bandOf } from './analysis.ts';
import type { AccountType, Enquiry, Tradeline } from './analysis.ts';

export interface ReportRequest { name: string; dob: string; pan: string; mobile: string }
export interface BureauReport { provider: string; sample: boolean; report_id: string; generated_at: string; score: { value: number; band: string; model: string; estimated: boolean }; subject: { name: string; pan_last4: string; dob_year: number };
  tradelines: Tradeline[]; enquiries: Enquiry[]; factors: ReturnType<typeof analyze>['factors']; summary: ReturnType<typeof analyze>['summary'] }
export interface Provider { name: string; sample: boolean; fetch(r: ReportRequest, today: string): Promise<{ score?: number; tradelines: Tradeline[]; enquiries: Enquiry[] }> }

function rng(seed: string) { let s = createHash('sha256').update(seed).digest().readUInt32LE(0); return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
const LENDERS = ['HDFC Bank', 'ICICI Bank', 'SBI Card', 'Axis Bank', 'Kotak Mahindra Bank', 'Bajaj Finance', 'IDFC First Bank'];
const addMonths = (d: string, n: number) => { const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7)) - 1 + n; const yy = y + Math.floor(m / 12), mm = ((m % 12) + 12) % 12; return `${yy}-${String(mm + 1).padStart(2, '0')}-01`; };

/** Synthetic but internally consistent report, deterministic per PAN, so demos are repeatable. Nothing here is real credit data. */
export const sandboxProvider: Provider = {
  name: 'sandbox', sample: true,
  async fetch(req, today) {
    const r = rng(req.pan); const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]; const careful = r(); const lines: Tradeline[] = []; const n = 2 + Math.floor(r() * 3);
    const types: AccountType[] = ['credit_card', 'credit_card', 'personal_loan', 'auto_loan', 'home_loan', 'consumer_loan'];
    for (let i = 0; i < n; i++) {
      const type = i === 0 ? 'credit_card' : pick(types); const age = 6 + Math.floor(r() * 90); const isCard = type === 'credit_card'; const limit = isCard ? (50_000 + Math.floor(r() * 450_000)) * 100 : (100_000 + Math.floor(r() * (type === 'home_loan' ? 4_000_000 : 800_000))) * 100;
      const util = isCard ? (careful > 0.5 ? 0.05 + r() * 0.25 : 0.4 + r() * 0.55) : 0.2 + r() * 0.7; const dpd = Array.from({ length: Math.min(36, age) }, () => (careful > 0.35 ? (r() < 0.01 ? 30 : 0) : r() < 0.12 ? pick([30, 30, 60, 90]) : 0));
      lines.push({ type, lender: pick(LENDERS), opened: addMonths(today, -age), limit_or_amount: limit, balance: Math.round(limit * util), overdue: dpd[0] > 0 ? Math.round(limit * 0.02) : 0, status: r() < 0.9 ? 'active' : 'closed', dpd_history: dpd });
    }
    const enquiries: Enquiry[] = Array.from({ length: Math.floor(r() * (careful > 0.5 ? 3 : 7)) }, () => ({ date: addMonths(today, -Math.floor(r() * 20)), lender: pick(LENDERS), purpose: pick(['Credit card', 'Personal loan', 'Auto loan']) }));
    return { tradelines: lines, enquiries };
  },
};

/** Calls a licensed partner's API. The partner must return this service's tradeline shape; add a mapping layer per vendor (CIBIL itself is reachable only through member institutions or authorised partners). */
export const httpProvider = (baseUrl: string, apiKey: string): Provider => ({
  name: 'http', sample: false,
  async fetch(req) {
    const r = await fetch(baseUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }, body: JSON.stringify(req), signal: AbortSignal.timeout(45_000) });
    if (!r.ok) throw Object.assign(new Error(`Bureau partner returned ${r.status}`), { status: 502, code: 'provider_error' });
    const j: any = await r.json(); if (!Array.isArray(j.tradelines)) throw Object.assign(new Error('Unexpected partner response'), { status: 502, code: 'provider_error' });
    return { score: typeof j.score === 'number' ? j.score : undefined, tradelines: j.tradelines, enquiries: j.enquiries ?? [] };
  },
});

export async function buildReport(p: Provider, req: ReportRequest, today: string): Promise<BureauReport> {
  const raw = await p.fetch(req, today); const a = analyze(raw.tradelines, raw.enquiries, today); const value = raw.score ?? a.estimate;
  return { provider: p.name, sample: p.sample, report_id: createHash('sha256').update(req.pan + today + p.name).digest('hex').slice(0, 12), generated_at: new Date().toISOString(),
    score: { value, band: bandOf(value), model: raw.score != null ? 'Bureau score' : p.sample ? 'Sample estimate (not a real CIBIL score)' : 'Ledgerly estimate', estimated: raw.score == null },
    subject: { name: req.name, pan_last4: req.pan.slice(-4), dob_year: Number(req.dob.slice(0, 4)) }, tradelines: raw.tradelines, enquiries: raw.enquiries, factors: a.factors, summary: a.summary };
}
