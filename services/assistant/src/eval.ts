// Measures how well the on-device model picks the intent. Run: node src/eval.ts   (needs the model file)
import { loadLlama } from './llm.ts';
import { PLAN_SCHEMA, PLAN_SYSTEM, guard, normalizePlan, planPrompt } from './planner.ts';

export const CASES: [string, string][] = [
  ['How much did I spend on eating out last month?', 'spending'], ['what did i spend on groceries in october', 'spending'], ['total spending this year', 'spending'], ['how much have I spent at swiggy', 'spending'], ['where is my money going', 'spending'],
  ['show my 5 biggest purchases this month', 'transactions'], ['list my last transactions', 'transactions'], ['find uber rides in august', 'transactions'], ['what was my most expensive purchase', 'transactions'],
  ['how much salary did I get last month', 'income'], ['what am I paying for every month', 'subscriptions'], ['which subscriptions got pricier', 'subscriptions'],
  ['which bills are due soon', 'bills'], ['do I have any overdue payments', 'bills'], ['what is my net worth', 'balances'], ['how much money do I have in my accounts', 'balances'],
  ['am I over budget anywhere', 'budget'], ['how is my grocery budget', 'budget'], ['how much can I safely spend', 'safe_to_spend'], ['can I afford a 20000 purchase', 'safe_to_spend'],
  ['how are my savings goals going', 'goals'], ['when is my next auto-save to the vacation goal', 'auto_save'], ['what loans do I owe', 'debts'], ['what is the interest rate on my credit card debt', 'debts'],
  ['how healthy are my finances', 'health'], ['compare my spending month by month', 'trend'], ['how is my credit card utilization', 'cards'], ['which of my cards expires soon', 'cards'],
  ['how much did I pay through UPI this month', 'upi'], ['who do I send the most money to on gpay', 'upi'], ['what is my cibil score', 'credit_score'], ['show my credit report', 'credit_score'],
  ['any cashback offers for me', 'offers'], ['which banks are linked to my account', 'linked_banks'], ['thanks', 'help'], ['hello there', 'help'], ['what is the weather', 'help'],
];
/** Questions that appear (verbatim) in the planner prompt's examples; reported separately so they do not flatter the score. */
const IN_PROMPT = new Set(['How much did I spend on eating out last month?', 'show my 5 biggest purchases this month', 'what am I paying for every month', 'what is my cibil score', 'thanks']);
if (process.argv[1]?.endsWith('eval.ts')) {
  const llm = await loadLlama({ modelPath: process.env.LLAMA_MODEL_PATH ?? './models/Llama-3.2-1B-Instruct-Q4_K_M.gguf' }); let raw = 0, guarded = 0, hRaw = 0, hGuard = 0, held = 0; const wrong: string[] = []; const t0 = Date.now();
  for (const [q, want] of CASES) { const p = normalizePlan(await llm.plan(PLAN_SYSTEM, planPrompt(q, null, null), PLAN_SCHEMA)); const got = p?.intent ?? 'none'; const g = guard(q, got as any).intent; const h = !IN_PROMPT.has(q); if (h) held++; if (got === want) { raw++; if (h) hRaw++; } if (g === want) { guarded++; if (h) hGuard++; } else wrong.push(`${q}  ->  ${g} (wanted ${want})`); }
  console.log(`all ${CASES.length}: model alone ${raw}, with guards ${guarded}.  Held out of the prompt (${held}): model alone ${hRaw}, with guards ${hGuard}.  avg ${Math.round((Date.now() - t0) / CASES.length)} ms per plan`); console.log(wrong.join('\n')); await llm.close();
}
