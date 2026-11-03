/**
 * UPI helpers. Ledgerly never moves money: it builds the standard NPCI deep link / QR payload that any UPI app understands,
 * parses UPI payment links and bank narrations, and records payments in the ledger.
 */
export const VPA_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,255}@[a-zA-Z][a-zA-Z0-9]{1,63}$/;
export const isVpa = (s: string) => VPA_RE.test(s.trim());
/** Typical per-transaction UPI ceiling in rupees (₹5 lakh for some categories; ₹1 lakh is the common default). */
export const UPI_DEFAULT_LIMIT = 100_000;

/** PSP handle → app / bank. Informational only: handles are shared and can change. */
export const HANDLES: Record<string, string> = {
  okaxis: 'Google Pay (Axis)', okhdfcbank: 'Google Pay (HDFC)', okicici: 'Google Pay (ICICI)', oksbi: 'Google Pay (SBI)', ybl: 'PhonePe (Yes Bank)', ibl: 'PhonePe (ICICI)', axl: 'PhonePe (Axis)',
  paytm: 'Paytm', pthdfc: 'Paytm (HDFC)', ptsbi: 'Paytm (SBI)', ptyes: 'Paytm (Yes)', apl: 'Amazon Pay', yapl: 'Amazon Pay', upi: 'BHIM', sbi: 'SBI', hdfcbank: 'HDFC Bank', icici: 'ICICI Bank',
  axisbank: 'Axis Bank', kotak: 'Kotak', waicici: 'WhatsApp (ICICI)', waaxis: 'WhatsApp (Axis)', freecharge: 'Freecharge', jupiter: 'Jupiter', fbl: 'Federal Bank', okbizaxis: 'Google Pay Business',
};
export const handleOf = (vpa: string) => vpa.split('@')[1]?.toLowerCase() ?? '';
export const appOf = (vpa: string) => HANDLES[handleOf(vpa)] ?? null;

export interface UpiLinkInput { vpa: string; name?: string; amount?: number; note?: string; ref?: string; merchantCode?: string }
/** Builds upi://pay?... Amount is in rupees with up to 2 decimals. Throws on an invalid VPA or amount. */
export function buildUpiLink(i: UpiLinkInput): string {
  if (!isVpa(i.vpa)) throw new Error('Invalid UPI ID');
  if (i.amount != null && (!(i.amount > 0) || i.amount > 1e7 || Math.round(i.amount * 100) / 100 !== i.amount)) throw new Error('Invalid amount');
  const q: [string, string][] = [['pa', i.vpa.trim()]];
  if (i.name) q.push(['pn', i.name.slice(0, 60)]); if (i.merchantCode) q.push(['mc', i.merchantCode]);
  if (i.ref) q.push(['tr', i.ref.slice(0, 35)]); if (i.note) q.push(['tn', i.note.slice(0, 50)]);
  if (i.amount != null) q.push(['am', i.amount.toFixed(2)]); q.push(['cu', 'INR']);
  return 'upi://pay?' + q.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}
export function parseUpiLink(text: string): UpiLinkInput | null {
  const m = /^upi:\/\/pay\?(.+)$/i.exec(text.trim()); if (!m) return null;
  const p = new URLSearchParams(m[1]); const pa = p.get('pa'); if (!pa || !isVpa(pa)) return null;
  const am = p.get('am'); const amount = am && /^\d+(\.\d{1,2})?$/.test(am) ? Number(am) : undefined;
  return { vpa: pa, name: p.get('pn') ?? undefined, amount, note: p.get('tn') ?? undefined, ref: p.get('tr') ?? undefined, merchantCode: p.get('mc') ?? undefined };
}

export interface UpiNarration { ref: string | null; vpa: string | null; payee: string | null; direction: 'debit' | 'credit' | null; note: string | null; kind: 'P2P' | 'P2M' | null }
const NOISE = /^((to|by) transfer|upi|dr|cr|p2p|p2m|payment|pay|to|from|transfer|by|ref|imps|neft|mob|mobile|debit|credit|collect|mandate|autopay|upiint|upiib|bank|ltd|[a-z]{4}0[a-z0-9]{6})$/i;
export const isUpiNarration = (d: string) => /\bUPI\b/i.test(d) || /@[a-z]{2,}\b/i.test(d) && /\b\d{12}\b/.test(d);
/**
 * Pulls the 12-digit UPI reference (RRN), VPA, payee and direction out of the narration styles used by Indian banks, e.g.
 * "UPI/412345678901/Zomato/zomato@icici/Order", "UPI-RAJESH KUMAR-rajesh@okaxis-HDFC0000123-412345678901-Dinner",
 * "TO TRANSFER-UPI/DR/412345678901/AMAZON/YESB/amazon@yapl/NA".
 */
export function parseUpiNarration(desc: string): UpiNarration | null {
  if (!isUpiNarration(desc)) return null;
  const ref = /\b(\d{12})\b/.exec(desc)?.[1] ?? null;
  // a VPA starts at a delimiter; in hyphen-delimited narrations (UPI-NAME-vpa-IFSC-REF) pick the hyphen segment that has the @
  const hy = desc.split('-').map((x) => x.trim()).find((x) => /^[a-zA-Z0-9][a-zA-Z0-9._]*@[a-zA-Z][a-zA-Z0-9]+$/.test(x)) ?? null;
  const vpa = /^UPI-/i.test(desc) && hy ? hy : /(?:^|[\s/|:])([a-zA-Z0-9][a-zA-Z0-9._-]*@[a-zA-Z][a-zA-Z0-9]+)/.exec(desc)?.[1] ?? hy;
  const direction = /\/DR\/|\bDR\b|DEBIT|\bPAID TO\b|\bTO\b/i.test(desc) ? 'debit' : /\/CR\/|\bCR\b|CREDIT|RECEIVED|\bFROM\b/i.test(desc) ? 'credit' : null;
  const kind = /P2M/i.test(desc) ? 'P2M' : /P2P/i.test(desc) ? 'P2P' : null;
  const segs = desc.split(/[\/|]|-(?=[A-Za-z0-9@])/).map((s) => s.trim()).filter(Boolean);
  const cand = segs.filter((s) => !/^\d+$/.test(s) && !(vpa && s.toLowerCase() === vpa.toLowerCase()) && !/@/.test(s) && !NOISE.test(s) && /[A-Za-z]{3}/.test(s) && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(s));
  const payee = cand[0] ? cand[0].replace(/\s+/g, ' ').slice(0, 60) : vpa ? vpa.split('@')[0] : null;
  const notes = cand.slice(1).filter((x) => !/^[A-Z]{4}$/.test(x)); const note = notes.length ? notes[notes.length - 1].slice(0, 60) : null;
  return { ref, vpa, payee, direction, note: note && note !== payee && !/^na$/i.test(note) ? note : null, kind };
}
