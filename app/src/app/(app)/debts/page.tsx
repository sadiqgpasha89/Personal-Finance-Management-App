'use client';
import { useEffect, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from 'recharts';
import { api, toMinor, useApi, useSession } from '@/lib/client';
import { Empty, ErrorBox, Loading, Money, PageHeader, Progress, Stat, axis, grid } from '@/components/ui';

export default function Debts() {
  const { data, error, reload } = useApi<any[]>('/debts'); const { fmt } = useSession(); const [extra, setExtra] = useState('100'); const [plan, setPlan] = useState<any>(null);
  useEffect(() => { if (!data?.length) return; const t = setTimeout(() => api('/debts/plan', { body: { extra: toMinor(extra) ?? 0 } }).then(setPlan), 200); return () => clearTimeout(t); }, [extra, data]);
  if (error) return <ErrorBox msg={error} retry={reload} />; if (!data) return <Loading />;
  if (!data.length) return <><PageHeader title="Debt" /><Empty title="Debt-free 🎉" body="Add a credit card or loan account (with its APR) to see payoff plans, interest costs, and statement reminders." /></>;
  const total = data.reduce((a, d) => a + d.balance, 0); const minTotal = data.reduce((a, d) => a + d.minPayment, 0);
  const series = plan ? plan.avalanche.timeline.map((p: any, i: number) => ({ month: p.month, Avalanche: p.total, Snowball: plan.snowball.timeline[i]?.total ?? 0, 'Minimums only': plan.minimum_only.timeline[i]?.total ?? 0 })).filter((_: any, i: number) => i % Math.max(1, Math.floor(plan.minimum_only.months / 40)) === 0) : [];
  const best = plan && (plan.avalanche.totalInterest <= plan.snowball.totalInterest ? 'avalanche' : 'snowball');
  return <>
    <PageHeader title="Debt" sub="Pay it off faster, with fewer surprises." />
    <div className="grid grid-cols-3 gap-3 mb-4"><Stat label="Total debt"><Money v={total} /></Stat><Stat label="Minimum payments / month"><Money v={minTotal} /></Stat><Stat label="Debt-free in">{plan?.avalanche.feasible ? `${Math.floor(plan.avalanche.months / 12)}y ${plan.avalanche.months % 12}m` : '—'}</Stat></div>
    <div className="grid md:grid-cols-2 gap-4 mb-6">{data.map((d) => (
      <div key={d.id} className="card"><div className="flex justify-between"><p className="font-medium">{d.name}</p><span className="chip">{d.aprPct}% APR</span></div>
        <p className="text-2xl font-semibold num mt-2"><Money v={d.balance} /></p><p className="text-xs text-mute">Minimum <Money v={d.minPayment} />/month</p>
        {d.utilization != null && <div className="mt-2"><div className="flex justify-between text-xs text-mute"><span>Utilization</span><span>{Math.round(d.utilization * 100)}%</span></div><Progress pct={d.utilization} warn={0.3} /></div>}
        {d.cycle && <div className="mt-3 text-sm border-t border-line pt-2"><p>Statement closed <b>{d.cycle.lastClose}</b>: balance <Money v={d.cycle.statement_balance} /></p><p className={d.cycle.daysToDue <= 3 ? 'text-warn font-medium' : 'text-mute'}>Pay the statement balance by {d.cycle.due} ({d.cycle.daysToDue} days) to avoid interest.</p>{d.cycle.utilization_at_statement != null && <p className="text-xs text-mute">Utilization at statement date: {Math.round(d.cycle.utilization_at_statement * 100)}%</p>}</div>}
        {d.amortization && !d.amortization.neverPaysOff && <p className="mt-3 text-sm border-t border-line pt-2 text-mute">At the current payment: paid off <b className="text-ink">{d.amortization.payoffDate}</b>, <Money v={d.amortization.totalInterest} /> total interest remaining.</p>}</div>))}</div>
    <div className="card"><h2 className="font-medium mb-1">Payoff planner</h2><p className="text-sm text-mute mb-3">How much extra can you pay on top of minimums each month?</p>
      <div className="max-w-xs mb-4"><label className="label" htmlFor="ex">Extra per month</label><input id="ex" className="input num" inputMode="decimal" value={extra} onChange={(e) => setExtra(e.target.value)} /></div>
      {plan && <>
        <div className="grid sm:grid-cols-3 gap-3 mb-4">{([['avalanche', 'Avalanche', 'Highest interest first'], ['snowball', 'Snowball', 'Smallest balance first']] as const).map(([k, l, s]) => { const r = plan[k]; return <div key={k} className={`rounded-lg border p-3 ${best === k ? 'border-brand bg-brand/5' : 'border-line'}`}><p className="font-medium">{l} {best === k && <span className="chip text-brand">saves most</span>}</p><p className="text-xs text-mute">{s}</p><p className="mt-2 text-sm">Debt-free: <b>{r.payoffDate ?? 'not reachable'}</b></p><p className="text-sm">Interest: <Money v={r.totalInterest} /></p></div>; })}
          <div className="rounded-lg border border-line p-3"><p className="font-medium">Your extra payment</p><p className="mt-2 text-sm">Interest saved: <b className="text-good"><Money v={plan.interest_saved_vs_minimum} /></b></p><p className="text-sm">Time saved: <b>{plan.months_saved} months</b></p></div></div>
        <div className="h-64" role="img" aria-label="Line chart of remaining debt over time for each strategy"><ResponsiveContainer><LineChart data={series}><CartesianGrid stroke={grid} vertical={false} /><XAxis dataKey="month" tick={axis} label={{ value: 'months', position: 'insideBottomRight', offset: -4, fontSize: 11 }} /><YAxis tick={axis} tickFormatter={(v) => fmt(v).replace(/\.00$/, '')} width={80} /><Tooltip formatter={(v: any) => fmt(Number(v))} /><Legend /><Line dataKey="Minimums only" stroke="#999" dot={false} strokeDasharray="4 4" /><Line dataKey="Snowball" stroke="#d9822b" dot={false} /><Line dataKey="Avalanche" stroke="rgb(var(--brand))" dot={false} strokeWidth={2} /></LineChart></ResponsiveContainer></div>
        <p className="text-xs text-mute mt-3">Payoff order ({best}): {plan[best].perDebt.slice().sort((a: any, b: any) => a.paidOffMonth - b.paidOffMonth).map((p: any) => `${p.name} (month ${p.paidOffMonth})`).join(' → ')}</p></>}</div>
  </>;
}
