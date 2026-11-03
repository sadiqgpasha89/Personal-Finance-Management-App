'use client';
import { useState } from 'react';
import { api, ApiFail, fromMinor, invalidate, toMinor, todayStr, useApi } from '@/lib/client';
import { Empty, ErrorBox, Field, Loading, Modal, Money, PageHeader, Progress, useToast } from '@/components/ui';

const TYPES = [['emergency', 'Emergency fund'], ['vacation', 'Vacation'], ['down_payment', 'Down payment'], ['retirement', 'Retirement'], ['custom', 'Custom']];
export default function Goals() {
  const { data, error, reload } = useApi<any[]>('/goals'); const accts = useApi<any[]>('/accounts'); const [edit, setEdit] = useState<any>(null); const [contrib, setContrib] = useState<any>(null); const [sched, setSched] = useState<any>(null); const toast = useToast();
  if (error) return <ErrorBox msg={error} retry={reload} />; if (!data) return <Loading />;
  return <>
    <PageHeader title="Goals" sub="Know exactly how much to put aside each month." actions={<button className="btn btn-primary" onClick={() => setEdit({})}>+ New goal</button>} />
    {!data.length ? <Empty title="No goals yet" body="Create a goal like an emergency fund or a trip. We'll calculate the monthly amount needed." action={<button className="btn btn-primary" onClick={() => setEdit({})}>Create goal</button>} /> :
      <div className="grid md:grid-cols-2 gap-4">{data.map((g) => (
        <div key={g.id} className="card"><div className="flex justify-between"><div><p className="font-medium">{g.name}</p><p className="text-xs text-mute">{TYPES.find((t) => t[0] === g.type)?.[1]}{g.target_date && ` · by ${g.target_date}`}{g.linked_account_id && ' · linked account'}</p></div><button className="text-xs text-mute underline" onClick={() => setEdit(g)}>Edit</button></div>
          <p className="mt-3 text-sm"><Money v={g.current_amount} className="text-xl font-semibold" /> <span className="text-mute">of <Money v={g.target_amount} /> ({Math.round(g.pct * 100)}%)</span></p><div className="my-2"><Progress pct={g.pct} warn={2} /></div>
          {g.status === 'done' || g.pct >= 1 ? <p className="text-good text-sm font-medium">🎉 Goal reached</p> : g.monthly_required != null && <p className="text-sm text-mute">Save <Money v={g.monthly_required} className="font-medium text-ink" />/month for {g.months_left} month{g.months_left === 1 ? '' : 's'} to get there.</p>}
          {g.schedule?.active && <p className="text-xs text-mute mt-3">⏱ Auto-save <Money v={g.schedule.amount} /> {g.schedule.cadence === 'once' ? 'once' : g.schedule.cadence} from {g.schedule.from_account_name}, next on {g.schedule.next_run}</p>}
          {g.schedule?.runs?.[0] && <p className={`text-xs ${g.schedule.runs[0].status === 'done' ? 'text-good' : 'text-warn'}`}>Last: {g.schedule.runs[0].run_date}, {g.schedule.runs[0].message}</p>}
          <div className="flex gap-2 flex-wrap mt-3">{!g.linked_account_id && <button className="btn" onClick={() => setContrib(g)}>+ Contribution</button>}<button className="btn" onClick={() => setSched(g)}>⏱ {g.schedule ? 'Edit auto-save' : 'Auto-save'}</button></div></div>))}</div>}
    {edit && <GoalModal g={edit} accts={accts.data ?? []} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); invalidate(); }} />}
    {contrib && <Modal open onClose={() => setContrib(null)} title={`Contribute to ${contrib.name}`}><ContribForm g={contrib} onDone={() => { setContrib(null); invalidate(); toast.show('Contribution added'); }} /></Modal>}
    {sched && <ScheduleModal g={sched} accts={accts.data ?? []} onClose={() => setSched(null)} onSaved={(m: string) => { setSched(null); invalidate(); toast.show(m); }} />}
    {toast.node}</>;
}
function ScheduleModal({ g, accts, onClose, onSaved }: any) {
  const s = g.schedule; const cur = accts.find((a: any) => a.id === (s?.from_account_id))?.currency ?? 'USD';
  const spend = accts.filter((a: any) => !a.is_archived && ['checking', 'savings', 'cash', 'wallet'].includes(a.type) && a.id !== g.linked_account_id);
  const [f, setF] = useState({ amount: s ? fromMinor(s.amount, cur) : '', cadence: s?.cadence ?? 'monthly', next_run: s?.next_run ?? todayStr(), from: String(s?.from_account_id ?? spend[0]?.id ?? ''), active: s ? !!s.active : true });
  const [err, setErr] = useState<Record<string, string>>({}); const fromCur = spend.find((a: any) => String(a.id) === f.from)?.currency ?? cur;
  const save = async (e: React.FormEvent) => { e.preventDefault(); setErr({}); try { await api(`/goals/${g.id}/schedule`, { method: 'PUT', body: { amount: toMinor(f.amount, fromCur) ?? 0, cadence: f.cadence, next_run: f.next_run, from_account_id: +f.from, active: f.active } }); onSaved('Auto-save saved'); } catch (x) { setErr((x as ApiFail).fields ?? { _: (x as Error).message }); } };
  return <Modal open onClose={onClose} title={`Auto-save to ${g.name}`}><form noValidate onSubmit={save}>
    <div className="grid grid-cols-2 gap-x-3"><Field label={`Amount (${fromCur})`} error={err.amount}><input className="input num" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
      <Field label="Repeat"><select className="input" value={f.cadence} onChange={(e) => setF({ ...f, cadence: e.target.value })}>{['once', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'].map((c) => <option key={c} value={c}>{c === 'once' ? 'Just once' : c}</option>)}</select></Field>
      <Field label="First date" error={err.next_run}><input type="date" className="input" value={f.next_run} onChange={(e) => setF({ ...f, next_run: e.target.value })} /></Field>
      <Field label="Take from" error={err.from_account_id}><select className="input" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })}>{spend.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field></div>
    <label className="flex gap-2 text-sm mb-2"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active</label>
    <p className="text-xs text-mute mb-3">On each date Ledgerly moves the amount into this goal in your records (a transfer if the goal tracks a savings account). It does not move money at your bank; if the account is short that day it skips and tells you.</p>
    {s?.runs?.length > 0 && <ul className="text-xs text-mute mb-3">{s.runs.map((r: any) => <li key={r.run_date + r.status}>{r.run_date}: {r.status}. {r.message}</li>)}</ul>}
    {err._ && <p role="alert" className="text-bad text-sm mb-2">{err._}</p>}
    <div className="flex justify-between">{s ? <button type="button" className="btn btn-danger" onClick={async () => { await api(`/goals/${g.id}/schedule`, { method: 'DELETE' }); onSaved('Auto-save removed'); }}>Remove</button> : <span />}<div className="flex gap-2"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary">Save</button></div></div></form></Modal>;
}
function ContribForm({ g, onDone }: any) { const [a, setA] = useState(''); const [e, setE] = useState(''); return <form onSubmit={async (ev) => { ev.preventDefault(); const m = toMinor(a); if (!m) return setE('Enter an amount'); try { await api(`/goals/${g.id}/contribute`, { body: { amount: m } }); onDone(); } catch (x) { setE((x as ApiFail).message); } }}><Field label="Amount" error={e}><input className="input num" inputMode="decimal" value={a} onChange={(x) => setA(x.target.value)} /></Field><div className="flex justify-end"><button className="btn btn-primary">Add</button></div></form>; }
function GoalModal({ g, accts, onClose, onSaved }: any) {
  const [f, setF] = useState({ name: g.name ?? '', type: g.type ?? 'custom', target: fromMinor(g.target_amount), date: g.target_date ?? '', linked: String(g.linked_account_id ?? ''), current: fromMinor(g.current_amount ?? 0) }); const [err, setErr] = useState<Record<string, string>>({});
  return <Modal open onClose={onClose} title={g.id ? 'Edit goal' : 'New goal'}><form noValidate onSubmit={async (e) => { e.preventDefault(); const body: any = { name: f.name, type: f.type, target_amount: toMinor(f.target) ?? 0, target_date: f.date || null, linked_account_id: f.linked ? +f.linked : null, current_amount: toMinor(f.current) ?? 0 }; try { g.id ? await api(`/goals/${g.id}`, { method: 'PATCH', body }) : await api('/goals', { body }); onSaved(); } catch (x) { setErr((x as ApiFail).fields ?? {}); } }}>
    <Field label="Name" error={err.name}><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
    <div className="grid grid-cols-2 gap-3"><Field label="Type"><select className="input" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field><Field label="Target amount" error={err.target_amount}><input className="input num" value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} /></Field>
      <Field label="Target date"><input type="date" className="input" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field><Field label="Saved so far"><input className="input num" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} disabled={!!f.linked} /></Field></div>
    <Field label="Track an account balance" hint="Progress follows this account's balance automatically."><select className="input" value={f.linked} onChange={(e) => setF({ ...f, linked: e.target.value })}><option value="">Manual contributions</option>{accts.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
    <div className="flex justify-between">{g.id ? <button type="button" className="btn btn-danger" onClick={async () => { await api(`/goals/${g.id}`, { method: 'DELETE' }); onSaved(); }}>Delete</button> : <span />}<div className="flex gap-2"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary">Save</button></div></div></form></Modal>;
}
