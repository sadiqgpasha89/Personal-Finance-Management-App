'use client';
import { useState } from 'react';
import { api, ApiFail, fromMinor, invalidate, toMinor, useApi, useSession } from '@/lib/client';
import { Empty, ErrorBox, Field, Loading, Modal, Money, PageHeader, Progress, Stat, useToast } from '@/components/ui';

const RO: Record<string, string> = { none: 'No rollover', surplus: 'Carry surplus', both: 'Carry surplus & overspend', reset: 'Reset monthly' };
export default function Budgets() {
  const [period, setPeriod] = useState<string>(''); const { data, error, reload } = useApi<any>('/budgets' + (period ? `?period=${period}` : '')); const cats = useApi<any[]>('/categories');
  const funds = useApi<any[]>('/sinking-funds'); const [edit, setEdit] = useState<any>(null); const [tpl, setTpl] = useState(false); const [fund, setFund] = useState<any>(null); const toast = useToast(); const { fmt } = useSession();
  if (error) return <ErrorBox msg={error} retry={reload} />; if (!data || !cats.data) return <Loading />;
  const shift = (n: number) => { const d = new Date(data.period.start + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); setPeriod(d.toISOString().slice(0, 10)); };
  const t = data.totals; const groups: Record<string, any[]> = {}; data.lines.forEach((l: any) => (groups[l.group ?? 'Other'] ??= []).push(l));
  const unbudgeted = cats.data.filter((c) => c.kind === 'expense' && !data.lines.some((l: any) => l.category_id === c.id));
  return (
    <>
      <PageHeader title="Budgets" sub={`${data.period.start} → ${data.period.end}`} actions={<><button className="btn" onClick={() => shift(-1)} aria-label="Previous period">‹</button><button className="btn" onClick={() => shift(1)} aria-label="Next period">›</button><button className="btn" onClick={() => setTpl(true)}>Templates</button><button className="btn btn-primary" onClick={() => setEdit({})}>+ Budget line</button></>} />
      <div className="grid grid-cols-3 gap-3 mb-4"><Stat label="Budgeted"><Money v={t.budgeted} /></Stat><Stat label="Spent"><Money v={t.spent} /></Stat><Stat label={t.left >= 0 ? 'Left to spend' : 'Over budget'}><Money v={Math.abs(t.left)} className={t.left < 0 ? 'text-warn' : 'text-good'} /></Stat></div>
      {!data.lines.length ? <Empty title="No budget yet" body="Use a template like 50/30/20 for a quick start, or add budget lines category by category." action={<button className="btn btn-primary" onClick={() => setTpl(true)}>Choose a template</button>} /> : Object.entries(groups).map(([g, ls]) => (
        <section key={g} className="mb-5"><h2 className="text-sm font-medium text-mute mb-2">{g}</h2><div className="card divide-y divide-line !p-0">{ls.map((l: any) => (
          <button key={l.id} className="w-full text-left p-4 hover:bg-line/30" onClick={() => setEdit(l)}>
            <div className="flex justify-between gap-2"><span className="font-medium">{l.category}{l.carry !== 0 && <span className="chip ml-2">{l.carry > 0 ? '+' : ''}{fmt(l.carry)} carried</span>}</span><span className="text-sm num"><Money v={l.spent} /> <span className="text-mute">of <Money v={l.available} /></span></span></div>
            <div className="my-2"><Progress pct={l.pct} /></div>
            <p className={`text-xs ${l.left < 0 ? 'text-warn' : 'text-mute'}`}>{l.left < 0 ? `Over by ${fmt(-l.left)}. Move money from another category to cover it.` : `${fmt(l.left)} left`} · {RO[l.rollover]}</p></button>))}</div></section>))}
      <section className="mt-6"><div className="flex justify-between items-center mb-2"><h2 className="text-sm font-medium text-mute">Sinking funds (irregular expenses)</h2><button className="btn" onClick={() => setFund({})}>+ Fund</button></div>
        {funds.data?.length ? <div className="grid sm:grid-cols-2 gap-3">{funds.data.map((f) => <div key={f.id} className="card"><div className="flex justify-between"><p className="font-medium">{f.name}</p><button className="text-xs text-mute underline" onClick={() => setFund(f)}>Edit</button></div><div className="my-2"><Progress pct={f.balance / f.target_amount} warn={2} /></div><p className="text-xs text-mute"><Money v={f.balance} /> of <Money v={f.target_amount} /> by {f.due_date} · set aside <Money v={f.monthly_required} />/month</p></div>)}</div> : <p className="text-sm text-mute">Annual insurance, travel, gifts: set aside a little each month so big bills never ambush you.</p>}</section>
      {edit && <LineModal line={edit} cats={unbudgeted.concat(edit.category_id ? cats.data.filter((c) => c.id === edit.category_id) : [])} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); invalidate(); }} />}
      {tpl && <TemplateModal onClose={() => setTpl(false)} onDone={() => { setTpl(false); invalidate(); toast.show('Budget created'); }} />}
      {fund && <FundModal f={fund} cats={cats.data} onClose={() => setFund(null)} onSaved={() => { setFund(null); invalidate(); }} />}
      {toast.node}
    </>
  );
}
function LineModal({ line, cats, onClose, onSaved }: any) {
  const [cid, setCid] = useState(String(line.category_id ?? '')); const [amt, setAmt] = useState(fromMinor(line.budgeted)); const [ro, setRo] = useState(line.rollover ?? 'none'); const [err, setErr] = useState('');
  return <Modal open onClose={onClose} title={line.id ? `Edit ${line.category}` : 'Add budget line'}>
    <form onSubmit={async (e) => { e.preventDefault(); const m = toMinor(amt); if (m == null || !cid) return setErr('Choose a category and enter an amount'); try { await api('/budgets', { method: 'PUT', body: { category_id: +cid, amount: m, rollover: ro } }); onSaved(); } catch (x) { setErr((x as ApiFail).message); } }}>
      {!line.id && <Field label="Category"><select className="input" value={cid} onChange={(e) => setCid(e.target.value)}><option value="">Choose…</option>{cats.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>}
      <Field label="Monthly amount"><input className="input num" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} /></Field>
      <Field label="Rollover" hint="What happens to unspent (or overspent) money at period end."><select className="input" value={ro} onChange={(e) => setRo(e.target.value)}>{Object.entries(RO).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      {err && <p role="alert" className="text-sm text-bad mb-2">{err}</p>}
      <div className="flex justify-between">{line.id ? <button type="button" className="btn btn-danger" onClick={async () => { await api(`/budgets/${line.id}`, { method: 'DELETE' }); onSaved(); }}>Remove</button> : <span />}<div className="flex gap-2"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary">Save</button></div></div></form></Modal>;
}
function TemplateModal({ onClose, onDone }: any) {
  const [t, setT] = useState('50/30/20'); const [inc, setInc] = useState(''); const [err, setErr] = useState('');
  return <Modal open onClose={onClose} title="Budget templates">
    <p className="text-sm text-mute mb-3">This replaces amounts for matching categories.</p>
    <div className="space-y-2 mb-3">{[['50/30/20', '50/30/20', '50% needs, 30% wants, 20% savings, split across your categories.'], ['average', 'Based on my last 3 months', 'Sets each category to your recent monthly average.']].map(([v, l, d]) => <label key={v} className="card flex gap-3 items-start cursor-pointer"><input type="radio" name="t" checked={t === v} onChange={() => setT(v)} className="mt-1" /><span><span className="font-medium block">{l}</span><span className="text-sm text-mute">{d}</span></span></label>)}</div>
    {t === '50/30/20' && <Field label="Monthly take-home income"><input className="input num" inputMode="decimal" value={inc} onChange={(e) => setInc(e.target.value)} /></Field>}
    {err && <p role="alert" className="text-sm text-bad mb-2">{err}</p>}
    <div className="flex justify-end gap-2"><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={async () => { try { await api('/budgets/template', { body: { template: t, income: toMinor(inc) ?? undefined } }); onDone(); } catch (x) { setErr((x as ApiFail).message); } }}>Apply</button></div></Modal>;
}
function FundModal({ f, cats, onClose, onSaved }: any) {
  const [s, setS] = useState({ name: f.name ?? '', target: fromMinor(f.target_amount), due: f.due_date ?? '', balance: fromMinor(f.balance ?? 0) }); const [err, setErr] = useState<Record<string, string>>({});
  return <Modal open onClose={onClose} title={f.id ? 'Edit fund' : 'New sinking fund'}>
    <form onSubmit={async (e) => { e.preventDefault(); const body = { name: s.name, target_amount: toMinor(s.target) ?? 0, due_date: s.due, balance: toMinor(s.balance) ?? 0 }; try { f.id ? await api(`/sinking-funds/${f.id}`, { method: 'PATCH', body }) : await api('/sinking-funds', { body }); onSaved(); } catch (x) { setErr((x as ApiFail).fields ?? {}); } }}>
      <Field label="Name" error={err.name}><input className="input" value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} /></Field>
      <div className="grid grid-cols-2 gap-3"><Field label="Target" error={err.target_amount}><input className="input num" value={s.target} onChange={(e) => setS({ ...s, target: e.target.value })} /></Field><Field label="Due date" error={err.due_date}><input type="date" className="input" value={s.due} onChange={(e) => setS({ ...s, due: e.target.value })} /></Field></div>
      <Field label="Saved so far"><input className="input num" value={s.balance} onChange={(e) => setS({ ...s, balance: e.target.value })} /></Field>
      <div className="flex justify-between">{f.id ? <button type="button" className="btn btn-danger" onClick={async () => { await api(`/sinking-funds/${f.id}`, { method: 'DELETE' }); onSaved(); }}>Delete</button> : <span />}<div className="flex gap-2"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary">Save</button></div></div></form></Modal>;
}
