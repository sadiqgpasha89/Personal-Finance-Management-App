export type Rollover = 'none' | 'surplus' | 'both' | 'reset';
/** Effective available for a category in a period given prior-period leftover. */
export function available(budgeted: number, spent: number, priorLeftover: number, policy: Rollover): { carry: number; available: number; left: number } {
  let carry = 0;
  if (policy === 'both') carry = priorLeftover;
  else if (policy === 'surplus') carry = Math.max(0, priorLeftover);
  const avail = budgeted + carry;
  return { carry, available: avail, left: avail - spent };
}
export const progress = (spent: number, avail: number) => (avail <= 0 ? (spent > 0 ? 2 : 0) : spent / avail);
export const alertLevel = (p: number): 0 | 50 | 80 | 100 => (p >= 1 ? 100 : p >= 0.8 ? 80 : p >= 0.5 ? 50 : 0);
export const TEMPLATES = {
  '50/30/20': { needs: 0.5, wants: 0.3, savings: 0.2 },
} as const;
/** Monthly set-aside for a sinking fund / goal reaching `target` by `dueDate`, given current balance. */
export function monthlyRequired(target: number, current: number, monthsLeft: number): number {
  const remaining = Math.max(0, target - current);
  return monthsLeft <= 0 ? remaining : Math.ceil(remaining / monthsLeft);
}
