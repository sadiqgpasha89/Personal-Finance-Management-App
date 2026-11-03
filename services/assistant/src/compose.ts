/** Turning tool results into a short answer, and refusing to ship numbers the data does not contain. */
export const COMPOSE_SYSTEM = `You are Ledgerly's assistant, answering one question about the user's own money using only the FACTS provided. Write one or two plain sentences.
Example FACTS: {"spent":"₹4,250.00","transactions":9,"groups":[{"name":"Dining","amount":"₹4,250.00"}]} Question: how much on dining last month
Example answer: You spent ₹4,250.00 on dining last month, across 9 transactions.
Rules: use only the facts; copy every number, amount, date and name exactly as written; never calculate new numbers; if the facts say nothing useful or contain an error, say so briefly. Answer the question directly in at most two sentences; the details are shown separately, so do not list items. No headings, no tables, no advice beyond the facts.`;
export const composePrompt = (question: string, facts: unknown, history: string[], note: string) =>
  `${history.length ? `Earlier in this chat:\n${history.slice(-4).map((h) => h.slice(0, 200)).join('\n')}\n\n` : ''}Question: ${question.slice(0, 300)}${note ? `\nContext: ${note}` : ''}\n\nFACTS (JSON):\n${JSON.stringify(facts).slice(0, 6000)}\n\nAnswer:`;

const NUM = /\d[\d,]*(?:\.\d+)?/g;
const norm = (s: string) => s.replace(/,/g, '');
/** Every number in `answer` must appear in the facts (small counts up to 12 are allowed, e.g. "3 of them"). Returns the offenders. */
/** A model answer is only used when it is a real sentence, not a list of bare numbers or a repeat. */
export function looksLikeAnAnswer(t: string): boolean {
  const words = t.split(/\s+/).filter((w) => /[A-Za-z]{2,}/.test(w)); if (words.length < 5 || t.length > 400) return false;
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean); if (new Set(lines).size < lines.length) return false;
  return !/^[-•*\s\d₹$.,%:/]+$/.test(t);
}
export function unsupportedNumbers(answer: string, facts: unknown): string[] {
  const hay = norm(JSON.stringify(facts)); const bad: string[] = [];
  for (const m of answer.match(NUM) ?? []) { const n = norm(m).replace(/\.0+$/, ''); if (/^\d+$/.test(n) && Number(n) <= 12) continue; if (!hay.includes(n)) bad.push(m); }
  return bad;
}
const L = (k: string) => k.replace(/_/g, ' ');
/** Hand-written renderings for the common tools: always correct, readable without a model. Returns null to use the generic renderer. */
function renderOne(name: string, r: any, intro: string, intent = ''): string | null {
  if (r?.error) return null;
  switch (name) {
    case 'spending_summary': {
      if (intent === 'income') return `You received **${r.income ?? '₹0.00'}** from ${r.from} to ${r.to}, and spent ${r.spent}.`; const g = (r.groups ?? []).slice(0, 6).map((x: any) => `- ${x.name}: ${x.amount}${x.share ? ` (${x.share})` : ''}`); return [`You spent **${r.spent}** from ${r.from} to ${r.to}${r.transactions ? `, across ${r.transactions} transactions` : ''}${r.income ? `, against ${r.income} of income` : ''}.`, ...g].join('\n'); }
    case 'search_transactions': return r.matches ? [`Found **${r.matches}** matching transactions totalling ${r.total_of_all_matches}${r.shown < r.matches ? `; showing ${r.shown}` : ''}:`, ...r.transactions.map((t: any) => `- ${t.date}: ${t.merchant ?? t.description}, ${t.amount}${t.category ? ` (${t.category})` : ''}`)].join('\n') : 'No matching transactions.';
    case 'list_subscriptions': return r.count ? [`You have **${r.count}** subscriptions costing about **${r.monthly_cost_of_subscriptions}** a month:`, ...r.subscriptions.map((s: any) => `- ${s.merchant}: ${s.amount} ${s.cadence}, next ${s.next_charge}${s.price_increase ? ` (price rose: ${s.price_increase})` : ''}`)].join('\n') : 'No subscriptions detected yet.';
    case 'cards_overview': return [r.overall_utilization ? `Your overall credit utilization is **${r.overall_utilization}** (${r.total_owed} of ${r.total_credit_limit}).` : 'Your cards:', ...r.cards.map((k: any) => `- ${k.name} •••• ${k.last4}${k.utilization ? `: ${k.utilization} used` : ''}${k.limit ? ` of ${k.limit}` : ''}, spent ${k.spent_this_period} this period${k.payment_due ? `, payment due ${k.payment_due}` : ''}`), ...(r.alerts ?? []).map((a: string) => `- ⚠ ${a}`)].join('\n');
    case 'upi_summary': return [`UPI this period: sent **${r.sent}** in ${r.sent_count} payments, received ${r.received} in ${r.received_count}.`, ...(r.top_payees ?? []).slice(0, 5).map((p: any) => `- ${p.payee}: ${p.total} (${p.count} payments)`)].join('\n');
    case 'credit_report': return r.available ? [`Your credit score is **${r.score}** (${String(r.band).replace('_', ' ')})${r.sample_data ? ', from sample data, not a real bureau report' : ''}.`, ...r.factors.map((f: any) => `- ${f.factor}: ${f.value} (${f.status})`)].join('\n') : r.note;
    case 'upcoming_bills': return r.items.length ? [`**${r.items.length}** upcoming items:`, ...r.items.slice(0, 8).map((b: any) => `- ${b.name}: ${b.amount} due ${b.due}${b.overdue ? ' (overdue)' : ''}`)].join('\n') : 'Nothing is due in the next 30 days.';
    case 'account_balances': return [`Net worth **${r.net_worth}** (assets ${r.assets}, liabilities ${r.liabilities}).`, ...r.accounts.map((a: any) => `- ${a.name}: ${a.balance}`)].join('\n');
    case 'safe_to_spend': return `You can safely spend about **${r.value}** until ${r.until ?? 'your next income'}: spendable ${r.spendable}, minus bills ${r.upcomingBills}, set-asides ${r.sinkingSetAside} and essentials ${r.essentialsRemaining}.`;
    default: return null;
  }
}
/** Plain, always-correct rendering of tool results, used when the model's wording cannot be trusted. */
export function renderFacts(results: { name: string; result: any }[], intro = '', intent = ''): string {
  if (results.length === 1) { const one = renderOne(results[0].name, results[0].result, intro, intent); if (one) return one; }
  const lines: string[] = intro ? [intro] : [];
  const scalar = (v: unknown) => (v == null ? '–' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const row = (o: any) => (o && typeof o === 'object' ? Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k.replace(/_/g, ' ')}: ${scalar(v)}`).join(', ') : scalar(o));
  for (const { result } of results) {
    if (result?.error) { lines.push(`I could not get that: ${result.error}`); continue; }
    for (const [k, v] of Object.entries(result ?? {})) {
      if (k === 'currency' || v == null) continue;
      if (Array.isArray(v)) { if (v.length) { lines.push(`${k.replace(/_/g, ' ')}:`); for (const x of v.slice(0, 8)) lines.push(`- ${row(x)}`); } else lines.push(`${k.replace(/_/g, ' ')}: none`); }
      else if (typeof v === 'object') lines.push(`- ${k.replace(/_/g, ' ')}: ${row(v)}`); else lines.push(`- ${k.replace(/_/g, ' ')}: ${scalar(v)}`);
    }
  }
  return lines.join('\n') || 'I could not find anything for that.';
}
export const HELP_TEXT = `I can answer questions about your own money. Try:\n- How much did I spend on dining last month?\n- What subscriptions am I paying for?\n- Show my 5 biggest purchases this month\n- How is my credit card utilization?\n- How much did I send through UPI this month?\n- What is my credit score?\n- Which bills are due soon?`;
