'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, invalidate, useApi, useSession } from '@/lib/client';
import { CHART, Empty, ErrorBox, Loading, Money, PageHeader, Stat, axis, grid } from '@/components/ui';

export default function Dashboard() {
  const { data: d, error, reload, loading } = useApi<any>('/dashboard'); const { fmt } = useSession(); const [busy, setBusy] = useState(false);
  if (error) return <ErrorBox msg={error} retry={reload} />;
  if (!d) return <Loading />;
  if (d.accounts === 0) return (
    <>
      <PageHeader title="Welcome to Ledgerly" sub="Let's get you to your first useful insight in under five minutes." />
      <div className="grid md:grid-cols-3 gap-4">
        {[['1. Add an account', 'Start with checking or cash. Balances are tracked from your transactions.', '/accounts', 'Add account'], ['2. Import or add transactions', 'Bring in a bank CSV (we detect columns and duplicates) or add by hand.', '/transactions', 'Open transactions'], ['3. Set a budget', 'Pick a template like 50/30/20 and see how much is safe to spend.', '/budgets', 'Plan budget']].map(([t, b, h, l]) => <div key={t} className="card flex flex-col"><p className="font-medium">{t}</p><p className="text-sm text-mute mt-1 mb-4 flex-1">{b}</p><Link className="btn" href={h}>{l}</Link></div>)}
      </div>
      <div className="card mt-4 flex flex-wrap items-center justify-between gap-3"><div><p className="font-medium">Just exploring?</p><p className="text-sm text-mute">Load six months of realistic sample data. You can delete it all later in Settings.</p></div>
        <button className="btn btn-primary" disabled={busy} onClick={async () => { setBusy(true); await api('/demo', { body: {} }); invalidate(); setBusy(false); }}>{busy ? 'Loading…' : 'Load demo data'}</button></div>
    </>
  );
  const s = d.safe; const pieData = d.categories.categories.slice(0, 7);
  return (
    <>
      <PageHeader title="Dashboard" sub={`Budget period ${d.period.start} → ${d.period.end}`} actions={<Link className="btn btn-primary" href="/transactions?new=1">+ Add transaction</Link>} />
      <div className="card mb-4 bg-brand/5 border-brand/30">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div><p className="text-sm text-mute">Safe to spend until {s.until}</p><p className={`text-4xl font-semibold num mt-1 ${s.value < 0 ? 'text-warn' : 'text-brand'}`}>{s.value < 0 ? <>Over by <Money v={-s.value} /></> : <Money v={s.value} />}</p>
            {s.value < 0 && <p className="text-sm text-mute mt-1">Upcoming bills exceed what's available. Consider moving funds from savings or trimming a flexible category.</p>}</div>
          <details className="text-sm"><summary className="cursor-pointer text-brand">How is this calculated?</summary>
            <table className="mt-2 num"><tbody>
              <tr><td className="pr-6 py-0.5">Spendable balance</td><td className="text-right"><Money v={s.spendable} /></td></tr>
              <tr><td className="py-0.5">− Bills until next income</td><td className="text-right"><Money v={s.upcomingBills} /></td></tr>
              <tr><td className="py-0.5">− Sinking-fund set-asides</td><td className="text-right"><Money v={s.sinkingSetAside} /></td></tr>
              <tr><td className="py-0.5">− Essentials still budgeted</td><td className="text-right"><Money v={s.essentialsRemaining} /></td></tr>
            </tbody></table></details>
        </div>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <Stat label="Net worth"><Money v={d.net_worth.net_worth} /></Stat>
        <Stat label="Income this period"><Money v={d.income} className="text-good" /></Stat>
        <Stat label="Spent this period"><Money v={d.spent} /></Stat>
        <Stat label="Financial health" sub={d.health.score != null ? 'Explainable, see Reports' : 'Needs more data'}>{d.health.score ?? '—'}<span className="text-sm text-mute">{d.health.score != null && ' / 100'}</span></Stat>
      </div>
      {d.uncategorized > 0 && <Link href="/transactions?uncategorized=1" className="card block mb-4 text-sm hover:bg-line/30">📌 {d.uncategorized} transaction{d.uncategorized > 1 ? 's' : ''} need a category. <span className="text-brand underline">Review</span></Link>}
      <div className="grid lg:grid-cols-2 gap-4">
        <div className="card"><h2 className="font-medium mb-3">Income vs. spending</h2>
          <div className="h-56" role="img" aria-label="Bar chart of monthly income and spending for the last six months"><ResponsiveContainer><BarChart data={d.months}><CartesianGrid stroke={grid} vertical={false} /><XAxis dataKey="month" tick={axis} /><YAxis tick={axis} tickFormatter={(v) => fmt(v).replace(/\.00$/, '')} width={70} /><Tooltip formatter={(v: any) => fmt(Number(v))} contentStyle={{ background: 'rgb(var(--card))', border: '1px solid rgb(var(--line))', borderRadius: 8 }} /><Legend /><Bar dataKey="income" name="Income" fill="rgb(var(--good))" radius={[4, 4, 0, 0]} /><Bar dataKey="expense" name="Spending" fill="#d9822b" radius={[4, 4, 0, 0]} /></BarChart></ResponsiveContainer></div></div>
        <div className="card"><h2 className="font-medium mb-3">Where it went</h2>
          {pieData.length ? <div className="flex items-center gap-4 flex-wrap"><div className="h-44 w-44" role="img" aria-label="Donut chart of spending by category"><ResponsiveContainer><PieChart><Pie data={pieData} dataKey="amount" nameKey="name" innerRadius={45} outerRadius={80} paddingAngle={2}>{pieData.map((_: any, i: number) => <Cell key={i} fill={CHART[i % CHART.length]} />)}</Pie><Tooltip formatter={(v: any) => fmt(Number(v))} /></PieChart></ResponsiveContainer></div>
            <ul className="text-sm space-y-1 flex-1 min-w-[160px]">{pieData.map((c: any, i: number) => <li key={c.name} className="flex justify-between gap-2"><span><span className="inline-block w-2.5 h-2.5 rounded-sm mr-2" style={{ background: CHART[i % CHART.length] }} />{c.name}</span><Money v={c.amount} /></li>)}</ul></div> : <p className="text-sm text-mute">No spending yet this period.</p>}</div>
        <div className="card"><div className="flex justify-between mb-2"><h2 className="font-medium">Upcoming bills</h2><Link href="/bills" className="text-sm text-brand">All bills</Link></div>
          {d.upcoming.length ? <ul className="divide-y divide-line">{d.upcoming.map((b: any) => <li key={b.recurring_id + b.due} className="py-2 flex justify-between text-sm"><span>{b.name} <span className="text-mute">· {b.due}</span></span><Money v={b.kind === 'income' ? b.amount : -b.amount} colored /></li>)}</ul> : <p className="text-sm text-mute">Nothing due in the next two weeks.</p>}</div>
        <div className="card"><h2 className="font-medium mb-2">Insights</h2>
          {d.insights.length ? <ul className="space-y-3">{d.insights.map((i: any, k: number) => <li key={k} className="text-sm"><p className={`font-medium ${i.severity === 'warn' ? 'text-warn' : i.severity === 'good' ? 'text-good' : ''}`}>{i.title}</p><p className="text-mute">{i.detail}</p></li>)}</ul> : <p className="text-sm text-mute">Nothing unusual. We'll flag price hikes, duplicates, and spikes here.</p>}</div>
        {d.nw_history.length > 1 && <div className="card lg:col-span-2"><h2 className="font-medium mb-3">Net worth trend</h2><div className="h-48" role="img" aria-label="Area chart of net worth over time"><ResponsiveContainer><AreaChart data={d.nw_history}><CartesianGrid stroke={grid} vertical={false} /><XAxis dataKey="date" tick={axis} /><YAxis tick={axis} tickFormatter={(v) => fmt(v).replace(/\.00$/, '')} width={80} domain={['auto', 'auto']} /><Tooltip formatter={(v: any) => fmt(Number(v))} /><Area dataKey="net_worth" name="Net worth" stroke="rgb(var(--brand))" fill="rgb(var(--brand) / 0.15)" /></AreaChart></ResponsiveContainer></div></div>}
      </div>
    </>
  );
}
