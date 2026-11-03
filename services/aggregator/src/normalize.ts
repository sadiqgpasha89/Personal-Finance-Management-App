/** ReBIT DEPOSIT FI → the flat shape the core service imports. Amounts become signed integer paise (money out is negative). */
export interface NormTxn { txn_id: string; date: string; amount: number; mode: string; narration: string; balance: number | null; reference: string | null }
export interface NormAccount { fip_id: string; fip_name: string; link_ref: string; masked_acc: string; kind: 'savings' | 'checking'; holder: string | null; currency: string; balance: number; ifsc: string | null; opening_balance: number; txns: NormTxn[] }
const paise = (s: string | number | undefined) => { const n = Number(s); if (!Number.isFinite(n)) throw new Error(`Bad amount "${s}"`); return Math.round(n * 100); };
export function normalizeDeposit(fipId: string, fipName: string, linkRef: string, fi: any): NormAccount {
  const a = fi?.Account; if (!a?.Summary) throw new Error('Unsupported FI payload');
  const raw: any[] = a.Transactions?.Transaction ?? []; const txns: NormTxn[] = raw.map((t) => {
    const amt = paise(t.amount); const type = String(t.type).toUpperCase(); if (type !== 'DEBIT' && type !== 'CREDIT') throw new Error(`Unknown txn type ${t.type}`);
    return { txn_id: String(t.txnId), date: String(t.valueDate ?? t.transactionTimestamp).slice(0, 10), amount: type === 'DEBIT' ? -amt : amt, mode: String(t.mode ?? 'OTHERS'), narration: String(t.narration ?? '').trim(), balance: t.currentBalance != null ? paise(t.currentBalance) : null, reference: t.reference ? String(t.reference) : null };
  });
  const balance = paise(a.Summary.currentBalance);
  return { fip_id: fipId, fip_name: fipName, link_ref: linkRef, masked_acc: String(a.maskedAccNumber ?? ''), kind: String(a.Summary.type).toUpperCase() === 'CURRENT' ? 'checking' : 'savings',
    holder: a.Profile?.Holders?.Holder?.name ?? null, currency: a.Summary.currency ?? 'INR', balance, ifsc: a.Summary.ifscCode ?? null, opening_balance: balance - txns.reduce((s, t) => s + t.amount, 0), txns };
}
