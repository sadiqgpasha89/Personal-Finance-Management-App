/**
 * Offer matching. Pure: takes a metrics snapshot derived from the user's own history and returns
 * which catalog offers fit, with the evidence behind each match. Amounts are minor units of the base currency.
 * The catalog is a SAMPLE – partners are fictional and nothing here is a real product, rate or approval.
 */
export interface OfferMetrics {
  /** Average monthly spend by category name over the lookback window. */
  monthly: Record<string, number>;
  monthlyExpense: number;
  monthlyIncome: number;
  checkingBalance: number;
  savingsBalance: number;
  hasSavingsAccount: boolean;
  cardDebt: { balance: number; aprPct: number; limit: number | null } | null;
  loanMaxApr: { balance: number; aprPct: number } | null;
  subs: { count: number; monthly: number; priceHikes: number };
  fees3m: number;
  foreign: { count: number; spend3m: number };
  emergencyMonths: number | null;
  months: number;
}
export interface OfferProfile { employment_type?: string | null; goals?: string[]; age?: number | null; household_size?: number | null; risk_tolerance?: string | null }
/** Convert a USD threshold to base-currency minor units. */
export type Scale = (usd: number) => number;

export interface CatalogOffer { id: string; title: string; partner: string; category: string; blurb: string; terms: string }
export interface OfferMatch extends CatalogOffer {
  eligible: boolean;
  score: number;
  /** Estimated yearly benefit in base-currency minor units, when it can be quantified. */
  annual_benefit: number | null;
  why: string[];
  assumptions: string[];
  reason_not?: string;
}

const T = (id: string, title: string, partner: string, category: string, blurb: string, terms: string): CatalogOffer => ({ id, title, partner, category, blurb, terms });
export const CATALOG: CatalogOffer[] = [
  T('cashback-food', 'Everyday Cashback Card', 'Northwind Bank', 'Cards', '3% back on dining and groceries, 1% on everything else, no annual fee.', 'Sample offer. Subject to credit approval; rewards capped at $2,000 of bonus-category spend per quarter.'),
  T('travel-rewards', 'Voyager Travel Rewards Card', 'Northwind Bank', 'Cards', '2.5 points per $1 on flights and stays, 60k welcome points.', 'Sample offer. $95 annual fee; points valued at 1.2¢ each; subject to credit approval.'),
  T('fuel-cashback', 'Commuter Cashback', 'Meridian Credit Union', 'Cards', '5% back on fuel, rideshare and transit, 1% elsewhere.', 'Sample offer. 5% on up to $1,200/yr of eligible spend, then 1%.'),
  T('hy-savings', 'High-Yield Savings', 'Harbor Savings', 'Savings', 'A savings account paying 4.0% APY with no minimum balance.', 'Sample offer. Variable rate; 4.0% is illustrative and may change.'),
  T('balance-transfer', '0% Balance Transfer', 'Meridian Credit Union', 'Debt', '0% intro APR for 15 months on balances you move from high-rate cards.', 'Sample offer. 3% transfer fee; regular APR applies after the intro period; subject to credit approval.'),
  T('refi-loan', 'Low-Rate Refinance Loan', 'Harbor Savings', 'Debt', 'Refinance a higher-rate loan into a fixed 7.5% APR loan with no origination fee.', 'Sample offer. Rate depends on credit; compare total cost over the full term before switching.'),
  T('annual-plans', 'Annual Plan Switcher', 'Ledgerly Partners', 'Subscriptions', 'Pay yearly instead of monthly for streaming, music and software and typically save about 15%.', 'Sample offer. Savings vary by service; check cancellation terms before prepaying.'),
  T('energy-switch', 'Energy Bill Check', 'Acme Energy Marketplace', 'Bills', 'Compare fixed-rate electricity and gas plans for your area.', 'Sample offer. Typical savings 8% where competing plans exist; exit fees may apply.'),
  T('insurance-bundle', 'Insurance Bundle Review', 'Sentinel Insurance Partners', 'Bills', 'Bundle auto, home or renters cover for a multi-policy discount.', 'Sample offer. Typical discount 10%; coverage terms differ between insurers.'),
  T('no-fee-account', 'No-Fee Everyday Account', 'Northwind Bank', 'Accounts', 'Checking with no monthly, overdraft or ATM fees inside the network.', 'Sample offer. Direct deposit of $500+/month required.'),
  T('fx-card', 'Zero-FX Travel Card', 'Voyager Money', 'Cards', 'Spend abroad at the mid-market rate with no foreign transaction fee.', 'Sample offer. Typical saving 3% of foreign spend versus a standard card.'),
  T('student-plans', 'Student Discount Bundle', 'Ledgerly Partners', 'Subscriptions', 'Student pricing on music, software and cloud storage.', 'Sample offer. Enrolment verification required.'),
  T('emergency-autosave', 'Auto-Save Emergency Fund', 'Harbor Savings', 'Savings', 'Round-ups and scheduled transfers into a separate savings pot with a 1% bonus on the first $2,000.', 'Sample offer. Bonus paid after 90 days; 1% bonus is illustrative.'),
  T('freelancer-tax', 'Freelancer Tax Set-Aside', 'Ledgerly Partners', 'Accounts', 'A dedicated tax pot and quarterly estimate reminders for self-employed income.', 'Sample offer. Informational tooling only, not tax advice.'),
];
const byId = (id: string) => CATALOG.find((o) => o.id === id)!;
const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Math.round(n)));

export function evaluateOffers(m: OfferMetrics, p: OfferProfile, usd: Scale, fmt: (n: number) => string): OfferMatch[] {
  const mo = (...cats: string[]) => cats.reduce((a, c) => a + (m.monthly[c] ?? 0), 0);
  const out: OfferMatch[] = [];
  const add = (id: string, eligible: boolean, score: number, benefit: number | null, why: string[], assumptions: string[], reason_not?: string) =>
    out.push({ ...byId(id), eligible, score: eligible ? clamp(score) : 0, annual_benefit: eligible && benefit != null ? Math.round(benefit) : null, why: eligible ? why : [], assumptions: eligible ? assumptions : [], reason_not: eligible ? undefined : reason_not });

  const food = mo('Dining', 'Groceries');
  add('cashback-food', food >= usd(150), 40 + (food / usd(600)) * 50, food * 12 * 0.02,
    [`You spend about ${fmt(food)}/month on dining and groceries.`], ['Net gain assumes 3% back versus about 1% on your current card.'],
    `Needs about ${fmt(usd(150))}/month on dining and groceries; you average ${fmt(food)}.`);

  const trav = mo('Travel'), travNet = trav * 12 * 0.03 - usd(95);
  add('travel-rewards', trav >= usd(100) && travNet > usd(25), 35 + (trav / usd(500)) * 50, travNet,
    [`Travel spend averages ${fmt(trav)}/month.`], ['2.5 points per $1 at 1.2¢ each is a 3% return, minus the $95 annual fee.'],
    `Needs travel spend of about ${fmt(usd(100))}/month, enough to beat the $95 fee; you average ${fmt(trav)}.`);

  const fuel = mo('Transport');
  add('fuel-cashback', fuel >= usd(80), 35 + (fuel / usd(300)) * 45, fuel * 12 * 0.04,
    [`Transport (fuel, rideshare, transit) is about ${fmt(fuel)}/month.`], ['Up to 5% back versus about 1% today, within the offer cap.'],
    `Needs about ${fmt(usd(80))}/month on transport; you average ${fmt(fuel)}.`);

  const idle = Math.max(0, m.checkingBalance - Math.round(m.monthlyExpense * 1.5));
  add('hy-savings', idle >= usd(1000), 45 + (idle / usd(10000)) * 45, idle * 0.039,
    [`About ${fmt(idle)} sits in checking beyond a 1.5-month spending cushion.`], ['Compares 4.0% APY against about 0.1% on checking.'],
    m.checkingBalance ? `Only ${fmt(idle)} is above your cushion; this fits once idle cash exceeds ${fmt(usd(1000))}.` : 'No checking balance found.');

  const cd = m.cardDebt;
  add('balance-transfer', !!cd && cd.aprPct >= 15 && cd.balance >= usd(1000), 55 + (cd ? Math.min(35, cd.aprPct) : 0),
    cd ? cd.balance * (cd.aprPct / 100) * (12 / 12) * 0.9 - cd.balance * 0.03 : null,
    cd ? [`Card balance ${fmt(cd.balance)} at ${cd.aprPct}% APR.`] : [], ['Interest avoided over the 15-month intro (12 months counted, at 90% of the balance carried) minus the 3% fee.'],
    cd ? `Needs a card balance of ${fmt(usd(1000))}+ at 15%+ APR; yours is ${fmt(cd.balance)} at ${cd.aprPct}%.` : 'You have no card balance.');

  const ln = m.loanMaxApr;
  add('refi-loan', !!ln && ln.aprPct >= 9 && ln.balance >= usd(2000), 50 + (ln ? (ln.aprPct - 7.5) * 4 : 0),
    ln ? ln.balance * Math.max(0, ln.aprPct - 7.5) / 100 : null,
    ln ? [`A loan of ${fmt(ln.balance)} carries ${ln.aprPct}% APR.`] : [], ['Interest saved in year one on a 7.5% refinance, ignoring term changes.'],
    ln ? `Your loan rate (${ln.aprPct}%) is already close to or under 7.5%.` : 'You have no loans on record.');

  const s = m.subs;
  add('annual-plans', s.count >= 3 && s.monthly >= usd(25), 40 + s.count * 6 + s.priceHikes * 8, s.monthly * 12 * 0.15,
    [`${s.count} subscriptions cost ${fmt(s.monthly)}/month.`, ...(s.priceHikes ? [`${s.priceHikes} had a recent price increase.`] : [])], ['Assumes about 15% off when you switch eligible services to annual billing.'],
    `Needs 3+ subscriptions totalling ${fmt(usd(25))}/month; you have ${s.count} (${fmt(s.monthly)}).`);

  const util = mo('Utilities');
  add('energy-switch', util >= usd(100), 30 + (util / usd(400)) * 40, util * 12 * 0.08,
    [`Utilities cost about ${fmt(util)}/month.`], ['Assumes an 8% saving on the energy portion where a cheaper plan exists.'],
    `Needs about ${fmt(usd(100))}/month in utilities; you average ${fmt(util)}.`);

  const ins = mo('Insurance');
  add('insurance-bundle', ins >= usd(60), 35 + (ins / usd(300)) * 40, ins * 12 * 0.1,
    [`Insurance costs about ${fmt(ins)}/month.`], ['Assumes a 10% multi-policy discount.'],
    `Needs about ${fmt(usd(60))}/month in insurance; you average ${fmt(ins)}.`);

  add('no-fee-account', m.fees3m >= usd(10), 50 + (m.fees3m / usd(60)) * 40, (m.fees3m / 3) * 12,
    [`You paid ${fmt(m.fees3m)} in fees and interest charges over the last 3 months.`], ['Assumes the same charges recur and a no-fee account removes them.'],
    `You paid only ${fmt(m.fees3m)} in fees over 3 months; the threshold is ${fmt(usd(10))}.`);

  add('fx-card', m.foreign.count >= 3, 45 + m.foreign.count * 3, (m.foreign.spend3m / 3) * 12 * 0.03,
    [`${m.foreign.count} purchases in other currencies (${fmt(m.foreign.spend3m)}) in 3 months.`], ['Assumes a 3% foreign transaction fee on your current card.'],
    `Needs 3+ foreign-currency purchases in 3 months; you have ${m.foreign.count}.`);

  const student = p.employment_type === 'student';
  add('student-plans', student, 60, s.monthly * 12 * 0.5,
    ['Your profile says you are a student.'], ['Assumes about 50% off qualifying subscriptions.'], 'Shown when your profile employment type is student.');

  const lowEmergency = m.emergencyMonths != null && m.emergencyMonths < 3 && m.monthlyExpense > 0;
  add('emergency-autosave', lowEmergency || (!!p.goals?.includes('emergency_fund') && (m.emergencyMonths ?? 0) < 6), 55 + (lowEmergency ? 25 : 0), usd(20),
    [m.emergencyMonths != null ? `Liquid savings cover about ${m.emergencyMonths.toFixed(1)} months of spending.` : 'Emergency fund is one of your goals.'], ['Bonus of 1% on the first $2,000 saved.'],
    m.emergencyMonths != null ? `You already hold ${m.emergencyMonths.toFixed(1)} months of spending; this is aimed at under 3 (or under 6 if it is a goal).` : 'Not enough history to judge your cushion.');

  add('freelancer-tax', p.employment_type === 'self_employed', 55, null, ['Your profile says you are self-employed.'], [], 'Shown when your profile employment type is self-employed.');

  return out.sort((a, b) => Number(b.eligible) - Number(a.eligible) || (b.annual_benefit ?? 0) - (a.annual_benefit ?? 0) || b.score - a.score);
}
