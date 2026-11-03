'use client';
import { useMemo, useState } from 'react';
import { api, ApiFail, fromMinor, invalidate, todayStr, toMinor, useApi } from '@/lib/client';
import { Empty, ErrorBox, Field, Loading, Modal, Money, PageHeader, Stat, useToast } from '@/components/ui';

const CAD = ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'];
export default function Bills() {
  const bills = useApi<any[]>('/bills'); const payees = useApi<any[]>('/upi/payees'); const rec = useApi<any[]>('/recurring'); const accts = useApi<any[]>('/accounts'); const cats = useApi<any[]>('/categories'); const subs = useApi<any>('/subscriptions');
  const [edit, setEdit] = useState<any>(null); const toast = useToast(); const [tab, setTab] = useState<'list' | 'calendar' | 'subs'>('list');
  const upcoming = useMemo(() => (bills.data ?? []).filter((b) => b.kind === 'expense'), [bills.data]);
  if (bills.error) return <ErrorBox msg={bills.error} retry={bills.reload} />; if (!bills.data || !rec.data) return <Loading />;
  const pay = async (b: any) => { try { await api('/bills/pay', { body: { recurring_id: b.recurring_id, due: b.due } }); invalidate(); toast.show(`${b.name} marked paid`, async () => { await api('/bills/unpay', { body: { recurring_id: b.recurring_id, due: b.due } }); invalidate(); }); } catch (x) { toast.show((x as ApiFail).message); } };
  const due30 = upcoming.filter((b) => !b.paid && b.due <= new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10)).reduce((a, b) => a + b.amount, 0);
  const overdue = upcoming.filter((b) => b.overdue);
  return (
    <>
      <PageHeader title="Bills & recurring" actions={<button className="btn btn-primary" onClick={() => setEdit({})}>+ Recurring item</button>} />
      <div className="grid grid-cols-3 gap-3 mb-4"><Stat label="Due in 30 days"><Money v={due30} /></Stat><Stat label="Overdue"><span className={overdue.length ? 'text-bad' : ''}>{overdue.length}</span></Stat><Stat label="Subscriptions / month"><Money v={subs.data?.monthly_total ?? 0} /></Stat></div>
      <div className="flex gap-1 mb-4" role="tablist">{([['list', 'Upcoming'], ['calendar', 'Calendar'], ['subs', 'Detected subscriptions']] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`btn ${tab === k ? 'btn-primary' : ''}`} onClick={() => setTab(k)}>{l}</button>)}</div>
      {tab === 'list' && (!bills.data.length ? <Empty title="No recurring items" body="Add rent, subscriptions, and paychecks to power reminders, forecasts, and safe-to-spend." action={<button className="btn btn-primary" onClick={() => setEdit({})}>Add one</button>} /> :
        <div className="card !p-0 divide-y divide-line">{bills.data.map((b) => (
          <div key={b.recurring_id + b.due} className="p-3 flex items-center gap-3 justify-between">
            <div><p className={`font-medium ${b.paid ? 'line-through text-mute' : ''}`}>{b.name}</p><p className="text-xs text-mute">{b.due} · {b.cadence}{b.account_name ? ` · ${b.account_name}` : ''}{b.overdue && <span className="text-bad ml-2 font-medium">Overdue</span>}</p></div>
            <div className="flex items-center gap-3"><Money v={b.kind === 'income' ? b.amount : -b.amount} colored />{b.paid ? <span className="chip">Paid</span> : <>{b.kind === 'expense' && payees.data?.find((p: any) => p.recurring_id === b.recurring_id) && <a className="btn" href={`/upi?payee=${payees.data.find((p: any) => p.recurring_id === b.recurring_id).id}&amount=${b.amount / 100}&bill=${b.recurring_id}&due=${b.due}`}>Pay via UPI</a>}<button className="btn" onClick={() => pay(b)}>{b.kind === 'income' ? 'Received' : 'Mark paid'}</button></>}</div></div>))}</div>)}
      {tab === 'calendar' && <Calendar bills={bills.data} />}
      {tab === 'subs' && (subs.data?.items.length ? <div className="card !p-0 divide-y divide-line">{subs.data.items.map((s: any) => <div key={s.merchant} className="p-3 flex justify-between gap-3"><div><p className="font-medium">{s.merchant} {s.priceHike && <span className="chip text-warn">price ↑</span>}</p><p className="text-xs text-mute">{s.cadence} · {s.occurrences} charges · next ≈ {s.nextCharge}</p></div><Money v={s.amount} /></div>)}<div className="p-3 text-sm text-mute">≈ <Money v={subs.data.annual_total} /> per year</div></div> : <Empty title="Nothing detected yet" body="We look for charges that repeat at a steady amount and cadence (at least three times)." />)}
      <h2 className="text-sm font-medium text-mute mt-8 mb-2">Manage recurring items</h2>
      <div className="card !p-0 divide-y divide-line">{rec.data.map((r) => <button key={r.id} className="w-full p-3 flex justify-between text-left hover:bg-line/30" onClick={() => setEdit(r)}><span>{r.name} <span className="text-xs text-mute">· {r.cadence} · next {r.next_due}{!r.active && ' · paused'}</span></span><Money v={r.kind === 'income' ? r.amount : -r.amount} colored /></button>)}</div>
      {edit && accts.data && cats.data && <RecModal r={edit} accts={accts.data} cats={cats.data} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); invalidate(); }} />}
      {toast.node}
    </>
  );
}
function Calendar({ bills }: { bills: any[] }) {
  const [off, setOff] = useState(0); const now = new Date(); const d = new Date(now.getFullYear(), now.getMonth() + off, 1); const y = d.getFullYear(), m = d.getMonth();
  const first = d.getDay(), dim = new Date(y, m + 1, 0).getDate(); const key = (n: number) => `${y}-${String(m + 1).padStart(2, '0')}-${String(n).padStart(2, '0')}`;
  const cells = [...Array(first).fill(null), ...Array.from({ length: dim }, (_, i) => i + 1)];
  return <div className="card"><div className="flex justify-between items-center mb-3"><button className="btn" onClick={() => setOff(off - 1)} aria-label="Previous month">‹</button><b>{d.toLocaleString('en', { month: 'long', year: 'numeric' })}</b><button className="btn" onClick={() => setOff(off + 1)} aria-label="Next month">›</button></div>
    <div className="grid grid-cols-7 gap-1 text-xs">{['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((x, i) => <div key={i} className="text-center text-mute">{x}</div>)}
      {cells.map((n, i) => { const items = n ? bills.filter((b) => b.due === key(n)) : []; return <div key={i} className={`min-h-[64px] rounded-md border border-line p-1 ${n && key(n) === todayStr() ? 'bg-brand/10' : ''}`}>{n && <><div className="text-mute">{n}</div>{items.slice(0, 2).map((b) => <div key={b.recurring_id} className={`truncate rounded px-1 mt-0.5 ${b.kind === 'income' ? 'bg-good/20' : b.paid ? 'bg-line' : 'bg-warn/20'}`} title={b.name}>{b.name}</div>)}{items.length > 2 && <div className="text-mute">+{items.length - 2}</div>}</>}</div>; })}</div></div>;
}
function RecModal({ r, accts, cats, onClose, onSaved }: any) {
  const [f, setF] = useState({ name: r.name ?? '', kind: r.kind ?? 'expense', amount: fromMinor(r.amount), account_id: String(r.account_id ?? accts[0]?.id ?? ''), category_id: String(r.category_id ?? ''), cadence: r.cadence ?? 'monthly', next_due: r.next_due ?? todayStr(), active: r.active !== 0 }); const [err, setErr] = useState<Record<string, string>>({});
  return <Modal open onClose={onClose} title={r.id ? 'Edit recurring item' : 'New recurring item'}>
    <form noValidate onSubmit={async (e) => { e.preventDefault(); const body: any = { name: f.name, kind: f.kind, amount: toMinor(f.amount) ?? 0, account_id: +f.account_id || null, category_id: f.category_id ? +f.category_id : null, cadence: f.cadence, next_due: f.next_due, is_bill: f.kind === 'expense', active: f.active }; try { r.id ? await api(`/recurring/${r.id}`, { method: 'PATCH', body }) : await api('/recurring', { body }); onSaved(); } catch (x) { setErr((x as ApiFail).fields ?? {}); } }}>
      <Field label="Name" error={err.name}><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <div className="grid grid-cols-2 gap-3"><Field label="Type"><select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="expense">Bill / expense</option><option value="income">Income</option></select></Field><Field label="Amount" error={err.amount}><input className="input num" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        <Field label="Repeats"><select className="input" value={f.cadence} onChange={(e) => setF({ ...f, cadence: e.target.value })}>{CAD.map((c) => <option key={c}>{c}</option>)}</select></Field><Field label="Next due" error={err.next_due}><input type="date" className="input" value={f.next_due} onChange={(e) => setF({ ...f, next_due: e.target.value })} /></Field>
        <Field label="Pay from"><select className="input" value={f.account_id} onChange={(e) => setF({ ...f, account_id: e.target.value })}>{accts.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field><Field label="Category"><select className="input" value={f.category_id} onChange={(e) => setF({ ...f, category_id: e.target.value })}><option value="">None</option>{cats.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field></div>
      <label className="flex gap-2 text-sm mb-3"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active</label>
      <div className="flex justify-between">{r.id ? <button type="button" className="btn btn-danger" onClick={async () => { await api(`/recurring/${r.id}`, { method: 'DELETE' }); onSaved(); }}>Delete</button> : <span />}<div className="flex gap-2"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary">Save</button></div></div></form></Modal>;
}
