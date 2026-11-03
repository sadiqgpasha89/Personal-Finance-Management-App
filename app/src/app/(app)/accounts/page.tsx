'use client';
import { useState } from 'react';
import { api, ApiFail, fromMinor, invalidate, toMinor, useApi, useSession } from '@/lib/client';
import { Empty, ErrorBox, Field, Loading, Modal, Money, PageHeader, useToast } from '@/components/ui';

const TYPES: [string, string][] = [['checking', 'Checking'], ['savings', 'Savings'], ['cash', 'Cash'], ['credit_card', 'Credit card'], ['loan', 'Loan'], ['wallet', 'Wallet'], ['investment', 'Investment']];
export default function Accounts() {
  const { data, error, reload } = useApi<any[]>('/accounts'); const { base, me } = useSession() as any; const [edit, setEdit] = useState<any | 'new' | null>(null); const [rec, setRec] = useState<any>(null); const toast = useToast();
  const s = useSession();
  if (error) return <ErrorBox msg={error} retry={reload} />; if (!data) return <Loading />;
  const act = data.filter((a) => !a.is_archived), arch = data.filter((a) => a.is_archived);
  const total = act.reduce((x, a) => x + a.balance_base, 0);
  return (
    <>
      <PageHeader title="Accounts" sub={<>Total across accounts: <Money v={total} /></>} actions={<button className="btn btn-primary" onClick={() => setEdit('new')}>+ Add account</button>} />
      {!data.length ? <Empty title="No accounts yet" body="Add a checking, savings, cash, or credit card account to start tracking." action={<button className="btn btn-primary" onClick={() => setEdit('new')}>Add account</button>} /> : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">{act.map((a) => (
          <div key={a.id} className="card">
            <div className="flex justify-between items-start"><div><p className="font-medium">{a.name}</p><p className="text-xs text-mute capitalize">{a.type.replace('_', ' ')} · {a.currency} · {a.txn_count} txns</p></div><button className="btn !px-2 !py-1 min-h-0" onClick={() => setEdit(a)} aria-label={`Edit ${a.name}`}>✎</button></div>
            <p className="text-2xl font-semibold mt-3 num"><Money v={a.balance} cur={a.currency} colored={a.balance < 0} /></p>
            {a.currency !== s.base && <p className="text-xs text-mute">≈ <Money v={a.balance_base} /></p>}
            {a.type === 'credit_card' && a.credit_limit && <p className="text-xs text-mute mt-1">Utilization {Math.round((-a.balance / a.credit_limit) * 100)}% of <Money v={a.credit_limit} cur={a.currency} /></p>}
            <div className="mt-3 flex gap-2"><button className="btn" onClick={() => setRec(a)}>Reconcile</button></div>
          </div>))}</div>)}
      {arch.length > 0 && <details className="mt-6"><summary className="text-sm text-mute cursor-pointer">Archived ({arch.length})</summary><div className="grid sm:grid-cols-3 gap-3 mt-2">{arch.map((a) => <div key={a.id} className="card flex justify-between"><span>{a.name}</span><button className="text-brand text-sm underline" onClick={async () => { await api(`/accounts/${a.id}`, { method: 'PATCH', body: { is_archived: false } }); invalidate(); }}>Unarchive</button></div>)}</div></details>}
      {edit && <AcctModal a={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); invalidate(); }} />}
      {rec && <Reconcile a={rec} onClose={() => setRec(null)} onDone={(m) => { setRec(null); invalidate(); toast.show(m); }} />}
      {toast.node}
    </>
  );
}
function AcctModal({ a, onClose, onSaved }: { a: any | null; onClose: () => void; onSaved: () => void }) {
  const { base } = useSession(); const curs = ['USD', 'EUR', 'GBP', 'INR', 'CAD', 'AUD', 'JPY'];
  const [f, setF] = useState({ name: a?.name ?? '', type: a?.type ?? 'checking', currency: a?.currency ?? base, opening: fromMinor(a?.opening_balance ?? 0, a?.currency ?? base), close: String(a?.statement_close_day ?? ''), due: String(a?.payment_due_day ?? ''), limit: fromMinor(a?.credit_limit, a?.currency ?? base), apr: String(a?.apr ?? ''), min: fromMinor(a?.min_payment, a?.currency ?? base), principal: fromMinor(a?.loan_principal, a?.currency ?? base), term: String(a?.loan_term_months ?? '') });
  const [err, setErr] = useState<Record<string, string>>({}); const [msg, setMsg] = useState(''); const liab = f.type === 'credit_card' || f.type === 'loan';
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setErr({}); setMsg('');
    const m = (s: string) => (s ? toMinor(s, f.currency) : null); const n = (s: string) => (s ? Number(s) : null);
    let open = m(f.opening) ?? 0; if (liab && open > 0) open = -open; // users type what they owe as a positive number
    const body: any = { name: f.name, type: f.type, currency: f.currency, opening_balance: open, statement_close_day: n(f.close), payment_due_day: n(f.due), credit_limit: m(f.limit), apr: n(f.apr), min_payment: m(f.min), loan_principal: m(f.principal), loan_term_months: n(f.term) };
    try { if (a) { delete body.currency; await api(`/accounts/${a.id}`, { method: 'PATCH', body }); } else await api('/accounts', { body }); onSaved(); } catch (x) { setErr((x as ApiFail).fields ?? {}); setMsg((x as ApiFail).message); }
  };
  const archive = async () => { await api(`/accounts/${a.id}`, { method: 'PATCH', body: { is_archived: true } }); onSaved(); };
  const remove = async () => { if (confirm(`Delete "${a.name}" and all its ${a.txn_count} transactions? This cannot be undone. Consider archiving instead.`)) { await api(`/accounts/${a.id}`, { method: 'DELETE' }); onSaved(); } };
  return (
    <Modal open onClose={onClose} title={a ? 'Edit account' : 'Add account'}>
      <form onSubmit={save} noValidate>
        <Field label="Name" error={err.name}><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={60} /></Field>
        <div className="grid grid-cols-2 gap-3"><Field label="Type"><select className="input" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
          <Field label="Currency"><select className="input" value={f.currency} disabled={!!a} onChange={(e) => setF({ ...f, currency: e.target.value })}>{curs.map((c) => <option key={c}>{c}</option>)}</select></Field></div>
        <Field label={liab ? 'Current amount owed' : 'Current balance'} hint={liab ? 'Enter what you owe as a positive number.' : 'Starting point; later transactions adjust it.'}><input className="input num" inputMode="decimal" value={f.opening.replace(/^-/, '')} onChange={(e) => setF({ ...f, opening: e.target.value })} /></Field>
        {f.type === 'credit_card' && <div className="grid grid-cols-3 gap-3"><Field label="Statement day"><input className="input" type="number" min={1} max={31} value={f.close} onChange={(e) => setF({ ...f, close: e.target.value })} /></Field><Field label="Due day"><input className="input" type="number" min={1} max={31} value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} /></Field><Field label="Credit limit"><input className="input num" value={f.limit} onChange={(e) => setF({ ...f, limit: e.target.value })} /></Field></div>}
        {liab && <div className="grid grid-cols-2 gap-3"><Field label="APR %"><input className="input num" inputMode="decimal" value={f.apr} onChange={(e) => setF({ ...f, apr: e.target.value })} /></Field><Field label="Minimum payment"><input className="input num" value={f.min} onChange={(e) => setF({ ...f, min: e.target.value })} /></Field></div>}
        {f.type === 'loan' && <div className="grid grid-cols-2 gap-3"><Field label="Original principal"><input className="input num" value={f.principal} onChange={(e) => setF({ ...f, principal: e.target.value })} /></Field><Field label="Term (months)"><input className="input" type="number" value={f.term} onChange={(e) => setF({ ...f, term: e.target.value })} /></Field></div>}
        {msg && !Object.keys(err).length && <p role="alert" className="text-sm text-bad mb-2">{msg}</p>}
        <div className="flex justify-between gap-2 mt-2"><div className="flex gap-2">{a && <><button type="button" className="btn" onClick={archive}>Archive</button><button type="button" className="btn btn-danger" onClick={remove}>Delete</button></>}</div><div className="flex gap-2"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary">Save</button></div></div>
      </form>
    </Modal>
  );
}
function Reconcile({ a, onClose, onDone }: { a: any; onClose: () => void; onDone: (m: string) => void }) {
  const [bal, setBal] = useState(''); const [d, setD] = useState(new Date().toISOString().slice(0, 10)); const [res, setRes] = useState<any>(null);
  return (
    <Modal open onClose={onClose} title={`Reconcile ${a.name}`}>
      <p className="text-sm text-mute mb-3">Enter the ending balance from your bank statement. If it matches, all transactions up to that date are marked reconciled.</p>
      <Field label="Statement date"><input className="input" type="date" value={d} onChange={(e) => setD(e.target.value)} /></Field>
      <Field label="Statement ending balance"><input className="input num" value={bal} onChange={(e) => setBal(e.target.value)} inputMode="decimal" /></Field>
      {res && !res.reconciled && <p role="alert" className="text-sm text-warn mb-2">Off by {(Math.abs(res.difference) / 100).toFixed(2)}. Your ledger shows {(res.ledger_balance / 100).toFixed(2)} on that date. Look for a missing or duplicate transaction.</p>}
      <div className="flex justify-end gap-2"><button className="btn" onClick={onClose}>Close</button><button className="btn btn-primary" onClick={async () => { const m = toMinor(bal, a.currency); if (m == null) return; const r = await api<any>(`/accounts/${a.id}/reconcile`, { body: { statement_balance: m, up_to: d } }); setRes(r); if (r.reconciled) onDone('Reconciled ✓'); }}>Check</button></div>
    </Modal>
  );
}
