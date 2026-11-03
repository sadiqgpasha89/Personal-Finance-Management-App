import { get, run } from './db';
import { z } from 'zod';
import { isDate, today, diffDays } from './domain/dates';

export const EMPLOYMENT = ['employed', 'self_employed', 'student', 'retired', 'unemployed', 'other'] as const;
export const INCOME_RANGES = ['under_25k', '25k_50k', '50k_100k', '100k_200k', 'over_200k', 'prefer_not'] as const;
export const RISK = ['conservative', 'balanced', 'growth'] as const;
export const GOALS = ['emergency_fund', 'debt_free', 'home', 'retirement', 'travel', 'education', 'invest', 'big_purchase'] as const;

const optText = (max: number) => z.string().trim().max(max).nullish().transform((v) => v || null);
export const profileSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  full_name: optText(120), phone: z.string().trim().regex(/^\+?[0-9 ()\-.]{7,20}$/, 'Enter a valid phone number').nullish().or(z.literal('')).transform((v) => v || null),
  date_of_birth: z.string().nullish().or(z.literal('')).transform((v) => v || null).refine((v) => v == null || (isDate(v) && v < today() && diffDays(today(), v) / 365.25 < 120), 'Enter a valid past date'),
  country: optText(60), city: optText(80), occupation: optText(80),
  employment_type: z.enum(EMPLOYMENT).nullish().or(z.literal('')).transform((v) => v || null),
  income_range: z.enum(INCOME_RANGES).nullish().or(z.literal('')).transform((v) => v || null),
  household_size: z.number().int().min(1).max(20).nullish(),
  risk_tolerance: z.enum(RISK).nullish().or(z.literal('')).transform((v) => v || null),
  goals: z.array(z.enum(GOALS)).max(GOALS.length).default([]),
  personalize_offers: z.boolean().default(true), ai_assistant: z.boolean().default(false),
});
export type ProfileInput = z.infer<typeof profileSchema>;

export function getProfile(userId: number) {
  const u = get('SELECT name,email FROM users WHERE id=?', userId)!; const p = get('SELECT * FROM profiles WHERE user_id=?', userId);
  return {
    name: u.name as string, email: u.email as string, full_name: p?.full_name ?? null, phone: p?.phone ?? null, date_of_birth: p?.date_of_birth ?? null, country: p?.country ?? null, city: p?.city ?? null,
    occupation: p?.occupation ?? null, employment_type: (p?.employment_type ?? null) as string | null, income_range: p?.income_range ?? null, household_size: (p?.household_size ?? null) as number | null,
    risk_tolerance: p?.risk_tolerance ?? null, goals: JSON.parse(p?.goals_json ?? '[]') as string[],
    personalize_offers: p ? !!p.personalize_offers : true, ai_assistant: p ? !!p.ai_assistant : false,
  };
}
export function completeness(p: ReturnType<typeof getProfile>) {
  const checks: [string, boolean][] = [['Full name', !!p.full_name], ['Country', !!p.country], ['Date of birth', !!p.date_of_birth], ['Employment', !!p.employment_type], ['Income range', !!p.income_range], ['Household size', p.household_size != null], ['Risk comfort', !!p.risk_tolerance], ['Financial goals', p.goals.length > 0]];
  return { pct: Math.round((checks.filter((c) => c[1]).length / checks.length) * 100), missing: checks.filter((c) => !c[1]).map((c) => c[0]) };
}
export function saveProfile(userId: number, i: ProfileInput) {
  if (i.name) run('UPDATE users SET name=? WHERE id=?', i.name, userId);
  run(`INSERT INTO profiles(user_id,full_name,phone,date_of_birth,country,city,occupation,employment_type,income_range,household_size,risk_tolerance,goals_json,personalize_offers,ai_assistant,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET full_name=excluded.full_name, phone=excluded.phone, date_of_birth=excluded.date_of_birth, country=excluded.country, city=excluded.city,
    occupation=excluded.occupation, employment_type=excluded.employment_type, income_range=excluded.income_range, household_size=excluded.household_size, risk_tolerance=excluded.risk_tolerance,
    goals_json=excluded.goals_json, personalize_offers=excluded.personalize_offers, ai_assistant=excluded.ai_assistant, updated_at=CURRENT_TIMESTAMP`,
    userId, i.full_name, i.phone, i.date_of_birth, i.country, i.city, i.occupation, i.employment_type, i.income_range, i.household_size ?? null, i.risk_tolerance, JSON.stringify(i.goals), +i.personalize_offers, +i.ai_assistant);
}
