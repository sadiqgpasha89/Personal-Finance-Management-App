'use client';
import { useEffect, useState } from 'react';
import { api, ApiFail, invalidate, useApi, useSession } from '@/lib/client';
import { ErrorBox, Field, Loading, PageHeader, Progress, useToast } from '@/components/ui';

const L: Record<string, string> = {
  employed: 'Employed', self_employed: 'Self-employed', student: 'Student', retired: 'Retired', unemployed: 'Between jobs', other: 'Other',
  under_25k: 'Under 25k', '25k_50k': '25k – 50k', '50k_100k': '50k – 100k', '100k_200k': '100k – 200k', over_200k: 'Over 200k', prefer_not: 'Prefer not to say',
  conservative: 'Conservative: protect what I have', balanced: 'Balanced', growth: 'Growth: comfortable with ups and downs',
  emergency_fund: 'Build an emergency fund', debt_free: 'Become debt-free', home: 'Buy a home', retirement: 'Retirement', travel: 'Travel', education: 'Education', invest: 'Start investing', big_purchase: 'A big purchase',
};
const blank = { name: '', full_name: '', phone: '', date_of_birth: '', country: '', city: '', occupation: '', employment_type: '', income_range: '', household_size: '', risk_tolerance: '', goals: [] as string[], personalize_offers: true, ai_assistant: false };

export default function Profile() {
  const { data, error, reload } = useApi<any>('/profile'); const { refresh, me } = useSession(); const toast = useToast();
  const [f, setF] = useState(blank); const [err, setErr] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false); const [dirty, setDirty] = useState(false);
  useEffect(() => { if (data) { setF({ ...blank, ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v ?? (typeof blank[k as keyof typeof blank] === 'boolean' ? false : '')])) as any, household_size: data.household_size != null ? String(data.household_size) : '' }); setDirty(false); } }, [data]);
  if (error) return <ErrorBox msg={error} retry={reload} />; if (!data) return <Loading />;
  const set = (k: keyof typeof blank, v: any) => { setF((x) => ({ ...x, [k]: v })); setDirty(true); };
  const text = (k: keyof typeof blank, label: string, extra: Record<string, any> = {}) => <Field label={label} error={err[k]}><input className="input" value={f[k] as string} onChange={(e) => set(k, e.target.value)} {...extra} /></Field>;
  const select = (k: keyof typeof blank, label: string, opts: string[]) => <Field label={label} error={err[k]}><select className="input" value={f[k] as string} onChange={(e) => set(k, e.target.value)}><option value="">Not set</option>{opts.map((o) => <option key={o} value={o}>{L[o]}</option>)}</select></Field>;
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr({});
    try {
      await api('/profile', { method: 'PUT', body: { ...f, household_size: f.household_size ? Number(f.household_size) : null } });
      toast.show('Profile saved'); setDirty(false); reload(); refresh(); invalidate();
    } catch (x) { setErr((x as ApiFail).fields ?? { _: (x as Error).message }); } finally { setBusy(false); }
  };
  const c = data.completeness;
  return <>
    <PageHeader title="Profile" sub="Tell us a little about you. It makes offers and answers more relevant, and you control what is used." />
    <form noValidate onSubmit={save} className="grid lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2 space-y-4">
        <section className="card" aria-labelledby="p-personal"><h2 id="p-personal" className="font-medium mb-3">Personal details</h2>
          <div className="grid sm:grid-cols-2 gap-x-3">
            {text('name', 'Display name')}{text('full_name', 'Full legal name', { autoComplete: 'name' })}
            <Field label="Email" hint="Your sign-in email can't be changed here."><input className="input" value={data.email} disabled /></Field>{text('phone', 'Phone', { type: 'tel', autoComplete: 'tel', placeholder: '+1 555 123 4567' })}
            <Field label="Date of birth" error={err.date_of_birth}><input type="date" className="input" value={f.date_of_birth} onChange={(e) => set('date_of_birth', e.target.value)} /></Field>{text('country', 'Country', { autoComplete: 'country-name' })}
            {text('city', 'City', { autoComplete: 'address-level2' })}
          </div></section>
        <section className="card" aria-labelledby="p-fin"><h2 id="p-fin" className="font-medium mb-3">Work and household</h2>
          <div className="grid sm:grid-cols-2 gap-x-3">
            {select('employment_type', 'Employment', data.options.employment)}{text('occupation', 'Occupation')}
            {select('income_range', 'Yearly income range', data.options.income_ranges)}
            <Field label="People in your household" error={err.household_size}><input type="number" min={1} max={20} className="input num" value={f.household_size} onChange={(e) => set('household_size', e.target.value)} /></Field>
            <div className="sm:col-span-2">{select('risk_tolerance', 'Comfort with investment risk', data.options.risk)}</div>
          </div>
          <fieldset className="mt-1"><legend className="label">Your financial goals</legend>
            <div className="grid sm:grid-cols-2 gap-1">{data.options.goals.map((g: string) => <label key={g} className="flex items-center gap-2 text-sm py-1"><input type="checkbox" checked={f.goals.includes(g)} onChange={(e) => set('goals', e.target.checked ? [...f.goals, g] : f.goals.filter((x) => x !== g))} />{L[g]}</label>)}</div></fieldset>
        </section>
        <section className="card" aria-labelledby="p-priv"><h2 id="p-priv" className="font-medium mb-3">Privacy choices</h2>
          <label className="flex gap-3 text-sm py-2"><input type="checkbox" className="mt-1" checked={f.personalize_offers} onChange={(e) => set('personalize_offers', e.target.checked)} /><span><span className="font-medium">Use my profile to personalise offers</span><br /><span className="text-mute">Offers always use your transaction history on this server. This also lets them use your employment, goals and age.</span></span></label>
          <label className="flex gap-3 text-sm py-2"><input type="checkbox" className="mt-1" checked={f.ai_assistant} onChange={(e) => set('ai_assistant', e.target.checked)} /><span><span className="font-medium">Allow an external AI model, if your operator has enabled one</span><br /><span className="text-mute">By default the assistant is Llama 3.2 1B running on this server, so nothing leaves it and you do not need this. It only matters if the operator has switched on an external provider, in which case your questions and the figures needed would be sent to it.</span></span></label>
        </section>
        {err._ && <p role="alert" className="text-bad text-sm">{err._}</p>}
        <div className="flex items-center gap-3"><button className="btn btn-primary" disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save profile'}</button>{dirty && <span className="text-xs text-mute">Unsaved changes</span>}</div>
      </div>
      <aside className="space-y-4">
        <div className="card"><p className="text-xs text-mute">Profile completeness</p><p className="text-2xl font-semibold num mt-1">{c.pct}%</p><div className="my-2"><Progress pct={c.pct / 100} warn={2} /></div>
          {c.missing.length ? <p className="text-xs text-mute">Still missing: {c.missing.join(', ')}.</p> : <p className="text-xs text-good">All set.</p>}</div>
        <div className="card text-sm text-mute"><p className="font-medium text-ink mb-1">How we use this</p><p>Your profile stays in this app's database and is included in your data export. Deleting your account removes it. Contact details are never shared with the assistant or used for offers.</p><p className="mt-2">Signed in as {me.user!.email}.</p></div>
      </aside>
    </form>
    {toast.node}</>;
}
