/** Deterministic synthetic bank data in the ReBIT DEPOSIT schema for the sandbox FIPs. Not real data. */
export interface Fip { id: string; name: string; ifsc: string; type: 'SAVINGS' | 'CURRENT' }
export const SANDBOX_FIPS: Fip[] = [{ id: 'HDFC-FIP', name: 'HDFC Bank', ifsc: 'HDFC0000123', type: 'SAVINGS' }, { id: 'SBI-FIP', name: 'State Bank of India', ifsc: 'SBIN0001234', type: 'SAVINGS' }, { id: 'ICICI-FIP', name: 'ICICI Bank', ifsc: 'ICIC0000456', type: 'CURRENT' }];
export const AA_HANDLES = [{ handle: 'anumati', name: 'Anumati (CAMS Finserv)' }, { handle: 'finvu', name: 'Finvu' }, { handle: 'onemoney', name: 'OneMoney' }];

function rng(seed: string) { let h = 2166136261; for (const ch of seed) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } let s = h >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
const d2 = (n: number) => (n / 100).toFixed(2); const iso = (d: Date) => d.toISOString().slice(0, 10);
const MERCH = [['UPI', 'Swiggy', 'swiggy@icici', 250, 900], ['UPI', 'Zomato', 'zomato@icici', 200, 800], ['UPI', 'BigBasket', 'bigbasket@hdfcbank', 800, 3500], ['UPI', 'Uber India', 'uber@axisbank', 120, 600], ['CARD', 'AMAZON PAY INDIA', '', 400, 6000],
  ['UPI', 'Reliance Fresh', 'relfresh@okaxis', 300, 2500], ['UPI', 'Ravi Kumar', 'ravi.k@okhdfcbank', 100, 2000], ['CARD', 'SHELL PETROL', '', 1500, 3500], ['UPI', 'Netflix', 'netflix@ybl', 649, 649], ['ATM', 'ATM WDL', '', 2000, 10000]] as const;

/** One FIP's DEPOSIT FI for a customer. `today` is injectable for tests. */
export function depositFI(mobile: string, fip: Fip, today = new Date(), days = 120) {
  const r = rng(`${mobile}:${fip.id}`); const salaryDay = 25; const salary = fip.type === 'SAVINGS' ? 6_500_000 + Math.floor(r() * 3_000_000) : 0; // paise
  const start = new Date(today.getTime() - days * 86400000); let bal = 2_500_000 + Math.floor(r() * 4_000_000); const opening = bal; const txns: any[] = []; let n = 0;
  for (let d = new Date(start); d <= today; d = new Date(d.getTime() + 86400000)) {
    const day = d.getUTCDate(); const stamp = (h: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, Math.floor(r() * 59))).toISOString();
    const push = (type: 'DEBIT' | 'CREDIT', mode: string, amt: number, narration: string) => { amt = Math.max(100, Math.round(amt)); bal += type === 'CREDIT' ? amt : -amt; if (bal < 0) { bal += amt; return; }
      n++; txns.push({ txnId: `${fip.id.slice(0, 4)}${String(n).padStart(6, '0')}`, type, mode, amount: d2(amt), currentBalance: d2(bal), transactionTimestamp: stamp(9 + (n % 12)), valueDate: iso(d), narration, reference: String(400000000000 + Math.floor(r() * 99999999999)) }); };
    if (day === salaryDay && salary) push('CREDIT', 'OTHERS', salary, 'NEFT-ACME TECHNOLOGIES PVT LTD-SALARY');
    if (day === 1 && fip.id === 'HDFC-FIP') push('DEBIT', 'FT', 2_200_000, 'NEFT-RENT PAYMENT-OWNER');
    if (day === 5 && fip.id === 'SBI-FIP') push('DEBIT', 'OTHERS', 1_850_000, 'ECS-HOME LOAN EMI');
    if (day === 10 && fip.id === 'ICICI-FIP') push('DEBIT', 'OTHERS', 450_000, 'ACH D-LIC PREMIUM');
    const k = Math.floor(r() * 3); // 0-2 everyday spends a day
    for (let i = 0; i < k; i++) { const m = MERCH[Math.floor(r() * MERCH.length)]; const amt = (m[3] + r() * (m[4] - m[3])) * 100;
      const ref = String(400000000000 + Math.floor(r() * 99999999999));
      const nar = m[0] === 'UPI' ? `UPI/${ref}/${m[1]}/${m[2]}/Payment` : m[0] === 'ATM' ? 'ATM WDL 7TH CROSS' : `POS ${m[1]} CARD XX${fip.id === 'HDFC-FIP' ? '4821' : '9034'}`;
      push('DEBIT', m[0], amt, nar); }
    if (fip.type === 'SAVINGS' && r() < 0.04) push('CREDIT', 'UPI', (500 + r() * 4000) * 100, `UPI/${String(400000000000 + Math.floor(r() * 99999999999))}/Anita Sharma/anita.s@oksbi/Dinner split`);
  }
  const last = txns[txns.length - 1];
  return { opening, closing: bal, fi: { Account: { linkedAccRef: `${fip.id}-${mobile.slice(-4)}`, maskedAccNumber: `XXXXXXXX${(1000 + Math.floor(rng(mobile + fip.id)() * 8999))}`, type: 'deposit', version: '1.1',
    Profile: { Holders: { type: 'SINGLE', Holder: { name: 'SAMPLE CUSTOMER', dob: '1990-01-01', mobile, nominee: 'REGISTERED', email: '', pan: 'XXXXX0000X', ckycCompliance: 'true' } } },
    Summary: { currentBalance: d2(bal), currency: 'INR', exchgeRate: '', balanceDateTime: last?.transactionTimestamp ?? today.toISOString(), type: fip.type, branch: 'SANDBOX', facility: 'OD', ifscCode: fip.ifsc, micrCode: '', openingDate: iso(new Date(today.getTime() - 900 * 86400000)), currentODLimit: '0', drawingLimit: '0', status: 'ACTIVE' },
    Transactions: { startDate: iso(start), endDate: iso(today), Transaction: txns } } } };
}
