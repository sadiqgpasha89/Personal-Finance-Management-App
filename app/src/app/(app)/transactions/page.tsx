'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiFail, fromMinor, invalidate, todayStr, toMinor, useApi, useSession } from '@/lib/client';
import { Empty, ErrorBox, Field, Loading, Modal, Money, PageHeader, useToast } from '@/components/ui';

type Tx = any;
export default function Transactions() {
  const { base } = useSession(); const toast = useToast();
  const accounts = useApi<any[]>('/accounts'); const cats = useApi<any[]>('/categories');
  const [f, setF] = useState({ q: '', account_id: '', category_id: '', kind: '', from: '', to: '', uncategorized: false, status: '' });
  const [items, setItems] = useState<Tx[]>([]); const [next, setNext] = useState<string | null>(null); const [total, setTotal] = useState(0); const [sum, setSum] = useState(0);
  const [loading, setLoading] = useState(true); const [err, setErr] = useState(''); const [edit, setEdit] = useState<Tx | 'new' | null>(null);
  const [sel, setSel] = useState<Set<number>>(new Set()); const [showDeleted, setShowDeleted] = useState(false); const [ver, setVer] = useState(0);
  useEffect(() => { const p = new URLSearchParams(location.search); if (p.get('new')) setEdit('new'); if (p.get('uncategorized')) setF((x) => ({ ...x, uncategorized: true })); }, []);
  const qs = useCallback((cursor?: string) => { const p = new URLSearchParams(); Object.entries(f).forEach(([k, v]) => v && p.set(k, v === true ? '1' : String(v))); if (showDeleted) p.set('deleted', '1'); if (cursor) p.set('cursor', cursor); return p.toString(); }, [f, showDeleted]);
  useEffect(() => { const t = setTimeout(() => { setLoading(true); api<any>('/transactions?' + qs()).then((r) => { setItems(r.items); setNext(r.next); setTotal(r.total); setSum(r.sum_base); setErr(''); setSel(new Set()); }).catch((e) => setErr(e.message)).finally(() => setLoading(false)); }, f.q ? 250 : 0); return () => clearTimeout(t); }, [qs, ver, f.q]);
  const reload = () => { setVer((v) => v + 1); invalidate(); };
  const more = async () => { if (!next) return; const r = await api<any>('/transactions?' + qs(next)); setItems((x) => [...x, ...r.items]); setNext(r.next); };
  const del = async (t: Tx) => { await api(`/transactions/${t.id}`, { method: 'DELETE' }); reload(); toast.show('Transaction deleted', async () => { await api(`/transactions/${t.id}/restore`, { body: {} }); reload(); }); };
  const bulk = async (action: string, extra: any = {}) => { await api('/transactions/bulk', { body: { ids: [...sel], action, ...extra } }); reload(); toast.show(`${sel.size} updated`); };
  const catName = (id: any) => cats.data?.find((c) => c.id === +id)?.name;
  const chips = Object.entries({ Search: f.q, Account: f.account_id && accounts.data?.find((a) => a.id === +f.account_id)?.name, Category: f.category_id && catName(f.category_id), Type: f.kind, From: f.from, To: f.to, Uncategorized: f.uncategorized && 'yes' }).filter(([, v]) => v);
  return (
    <>
      <PageHeader title="Transactions" sub={`${total.toLocaleString()} shown · net `} actions={<><Link className="btn" href="/import">Import CSV</Link><a className="btn" href="/api/export/csv">Export</a><button className="btn btn-primary" onClick={() => setEdit('new')}>+ Add</button></>} />
      <p className="-mt-4 mb-4 text-sm text-mute">Net of shown: <Money v={sum} colored /></p>
      <div className="card mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <input className="input" placeholder="Search description, merchant, notes" aria-label="Search" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <select className="input" aria-label="Account" value={f.account_id} onChange={(e) => setF({ ...f, account_id: e.target.value })}><option value="">All accounts</option>{accounts.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        <select className="input" aria-label="Category" value={f.category_id} onChange={(e) => setF({ ...f, category_id: e.target.value })}><option value="">All categories</option>{cats.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <select className="input" aria-label="Type" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="">All types</option><option value="expense">Expenses</option><option value="income">Income</option><option value="transfer">Transfers</option></select>
        <input className="input" type="date" aria-label="From date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <input className="input" type="date" aria-label="To date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.uncategorized} onChange={(e) => setF({ ...f, uncategorized: e.target.checked })} /> Needs category</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} /> Recently deleted (30 days)</label>
      </div>
      {chips.length > 0 && <div className="flex gap-2 flex-wrap mb-3 items-center">{chips.map(([k, v]) => <span key={k} className="chip">{k}: {String(v)}</span>)}<button className="text-sm text-brand underline" onClick={() => setF({ q: '', account_id: '', category_id: '', kind: '', from: '', to: '', uncategorized: false, status: '' })}>Clear filters</button></div>}
      {sel.size > 0 && <div className="card mb-3 flex gap-2 flex-wrap items-center"><span className="text-sm">{sel.size} selected</span>
        <select className="input !w-auto" aria-label="Set category for selected" defaultValue="" onChange={(e) => e.target.value && bulk('categorize', { category_id: +e.target.value })}><option value="">Set category…</option>{cats.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <button className="btn" onClick={() => { const t = prompt('Tag name'); if (t) bulk('tag', { tag: t }); }}>Add tag</button><button className="btn" onClick={() => bulk('reconcile')}>Mark reconciled</button><button className="btn btn-danger" onClick={() => bulk('delete')}>Delete</button></div>}
      {err ? <ErrorBox msg={err} retry={reload} /> : loading && !items.length ? <Loading /> : !items.length ? (
        <Empty title={chips.length ? 'No transactions match these filters' : 'No transactions yet'} body={chips.length ? 'Try removing a filter or widening the date range.' : 'Add your first transaction or import a CSV from your bank.'} action={<div className="flex gap-2 justify-center"><button className="btn btn-primary" onClick={() => setEdit('new')}>Add transaction</button><Link className="btn" href="/import">Import CSV</Link></div>} />
      ) : (
        <div className="card !p-0 overflow-x-auto"><table className="w-full min-w-[640px]"><thead><tr><th className="th w-8"><input type="checkbox" aria-label="Select all" checked={sel.size === items.length} onChange={(e) => setSel(e.target.checked ? new Set(items.map((i) => i.id)) : new Set())} /></th><th className="th">Date</th><th className="th">Description</th><th className="th">Category</th><th className="th">Account</th><th className="th text-right">Amount</th><th className="th" /></tr></thead>
          <tbody>{items.map((t) => (
            <tr key={t.id} className="hover:bg-line/30">
              <td className="td"><input type="checkbox" aria-label={`Select ${t.description}`} checked={sel.has(t.id)} onChange={() => setSel((s) => { const n = new Set(s); n.has(t.id) ? n.delete(t.id) : n.add(t.id); return n; })} /></td>
              <td className="td whitespace-nowrap num">{t.posted_date}</td>
              <td className="td"><button className="text-left hover:underline" onClick={() => setEdit(t)}>{t.merchant || t.description || '(no description)'}</button>
                <div className="flex gap-1 flex-wrap mt-0.5">{t.status === 'pending' && <span className="chip">Pending</span>}{t.reconciled ? <span className="chip">✓ reconciled</span> : null}{t.auto_categorized ? <span className="chip" title="Categorized automatically">auto</span> : null}{t.split_count > 0 && <span className="chip">split ×{t.split_count}</span>}{t.reimbursable ? <span className="chip">reimbursable</span> : null}{t.tags.map((g: string) => <span key={g} className="chip">#{g}</span>)}</div></td>
              <td className="td">{t.kind === 'transfer' ? <span className="chip">Transfer</span> : t.category ?? <span className="text-warn">Uncategorized</span>}</td>
              <td className="td text-mute">{t.account_name}</td>
              <td className="td text-right whitespace-nowrap"><Money v={t.amount} cur={t.currency} colored={t.kind !== 'transfer'} /></td>
              <td className="td text-right whitespace-nowrap">{showDeleted ? <button className="btn" onClick={async () => { await api(`/transactions/${t.id}/restore`, { body: {} }); reload(); }}>Restore</button> : <button className="btn !px-2" aria-label={`Delete ${t.description}`} onClick={() => del(t)}>🗑</button>}</td>
            </tr>))}</tbody></table>
          {next && <div className="p-3 text-center"><button className="btn" onClick={more}>Load more</button></div>}</div>
      )}
      {edit && accounts.data && cats.data && <TxModal tx={edit === 'new' ? null : edit} accounts={accounts.data.filter((a) => !a.is_archived)} cats={cats.data} onClose={() => setEdit(null)} onSaved={(m) => { setEdit(null); reload(); m && toast.show(m); }} />}
      {toast.node}
    </>
  );
}

function TxModal({ tx, accounts, cats, onClose, onSaved }: { tx: Tx | null; accounts: any[]; cats: any[]; onClose: () => void; onSaved: (msg?: string) => void }) {
  const [mode, setMode] = useState<'expense' | 'income' | 'transfer'>(tx ? (tx.kind === 'transfer' ? 'transfer' : tx.amount > 0 ? 'income' : 'expense') : 'expense');
  const acct0 = tx ? accounts.find((a) => a.id === tx.account_id) ?? accounts[0] : accounts[0];
  const [f, setF] = useState({ account_id: String(tx?.account_id ?? acct0?.id ?? ''), to_account: '', date: tx?.posted_date ?? todayStr(), amount: tx ? fromMinor(Math.abs(tx.amount), tx.currency) : '', description: tx?.description ?? '', category_id: String(tx?.category_id ?? ''), notes: tx?.notes ?? '', tags: (tx?.tags ?? []).join(', '), status: tx?.status ?? 'posted', reimbursable: !!tx?.reimbursable, pay: tx?.card_id ? `card:${tx.card_id}` : tx?.payment_method ?? '' });
  const cards = useApi<any>('/cards'); const [err, setErr] = useState<Record<string, string>>({}); const [msg, setMsg] = useState(''); const [busy, setBusy] = useState(false);
  const [splits, setSplits] = useState<{ category_id: string; amount: string }[] | null>(null); const [links, setLinks] = useState<any>(null);
  const cur = accounts.find((a) => a.id === +f.account_id)?.currency ?? 'USD';
  useEffect(() => { if (tx) { api<any>(`/transactions/${tx.id}`).then((r) => r.splits?.length && setSplits(r.splits.map((s: any) => ({ category_id: String(s.category_id ?? ''), amount: fromMinor(Math.abs(s.amount), cur) })))); api<any>(`/transactions/${tx.id}/links`).then(setLinks).catch(() => {}); } }, [tx, cur]);
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr({}); setMsg('');
    try {
      const m = toMinor(f.amount, cur); if (m == null || m === 0) throw new ApiFail(400, 'Enter a valid amount', { amount: 'Enter an amount like 12.50' });
      const abs = Math.abs(m);
      if (mode === 'transfer' && !tx) { if (!f.to_account) throw new ApiFail(400, 'Choose a destination account', { to_account: 'Required' }); await api('/transactions/transfer', { body: { from_account: +f.account_id, to_account: +f.to_account, amount: abs, date: f.date } }); }
      else {
        const signed = mode === 'expense' ? -abs : abs; const tags = f.tags.split(',').map((x: string) => x.trim()).filter(Boolean);
        const body: any = { account_id: +f.account_id, posted_date: f.date, amount: mode === 'transfer' ? tx.amount : signed, description: f.description, category_id: f.category_id ? +f.category_id : null, notes: f.notes || null, tags, status: f.status, reimbursable: f.reimbursable, card_id: f.pay.startsWith('card:') ? +f.pay.slice(5) : null, payment_method: f.pay.startsWith('card:') ? 'card' : f.pay || null };
        if (tx) { await api(`/transactions/${tx.id}`, { method: 'PATCH', body }); } else { const r = await api<any>('/transactions', { body }); if (r.possible_duplicate_of) { onSaved('Saved. Heads up: this looks like a duplicate of an existing transaction.'); return; } }
        if (tx && splits) { const sp = splits.filter((s) => s.amount).map((s) => ({ category_id: s.category_id ? +s.category_id : null, amount: (signed < 0 ? -1 : 1) * (toMinor(s.amount, cur) ?? 0) })); await api(`/transactions/${tx.id}/splits`, { method: 'PUT', body: { splits: sp } }); }
      }
      onSaved(tx ? 'Saved' : 'Transaction added');
    } catch (x) { const a = x as ApiFail; setErr(a.fields ?? {}); setMsg(a.message); } finally { setBusy(false); }
  };
  const remaining = splits ? Math.abs(toMinor(f.amount, cur) ?? 0) - splits.reduce((a, s) => a + (toMinor(s.amount, cur) ?? 0), 0) : 0;
  return (
    <Modal open onClose={onClose} title={tx ? 'Edit transaction' : 'Add transaction'} wide>
      <form onSubmit={save} noValidate>
        {!tx && <div className="flex gap-1 mb-4" role="tablist">{(['expense', 'income', 'transfer'] as const).map((m) => <button type="button" key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)} className={`btn flex-1 capitalize ${mode === m ? 'btn-primary' : ''}`}>{m}</button>)}</div>}
        <div className="grid sm:grid-cols-2 gap-x-3">
          <Field label={mode === 'transfer' ? 'From account' : 'Account'}><select className="input" value={f.account_id} onChange={(e) => setF({ ...f, account_id: e.target.value })}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
          {mode === 'transfer' && !tx ? <Field label="To account" error={err.to_account}><select className="input" value={f.to_account} onChange={(e) => setF({ ...f, to_account: e.target.value })}><option value="">Choose…</option>{accounts.filter((a) => a.id !== +f.account_id).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
            : <Field label="Category" hint={tx?.auto_categorized ? 'Categorized automatically — change it and we will remember.' : undefined}><select className="input" value={f.category_id} onChange={(e) => setF({ ...f, category_id: e.target.value })} disabled={mode === 'transfer'}><option value="">Uncategorized</option>{cats.filter((c) => mode === 'income' ? c.kind === 'income' : c.kind === 'expense').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>}
          <Field label={`Amount (${cur})`} error={err.amount}><input className="input num" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="0.00" required /></Field>
          <Field label="Date" error={err.posted_date}><input className="input" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} required /></Field>
        </div>
        {mode !== 'transfer' && <Field label="Description / merchant"><input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="e.g. STARBUCKS #1234" maxLength={300} /></Field>}
        {mode !== 'transfer' && <Field label="Paid with"><select className="input" value={f.pay} onChange={(e) => setF({ ...f, pay: e.target.value })}><option value="">Not specified</option><option value="upi">UPI</option><option value="cash">Cash</option><option value="netbanking">Net banking</option>{(cards.data?.items ?? []).map((k: any) => <option key={k.id} value={`card:${k.id}`}>{k.nickname} •••• {k.last4}</option>)}</select></Field>}
        <div className="grid sm:grid-cols-2 gap-x-3"><Field label="Tags (comma separated)"><input className="input" value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} /></Field>
          <Field label="Status"><select className="input" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="posted">Posted</option><option value="pending">Pending</option></select></Field></div>
        <Field label="Notes"><textarea className="input" rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={1000} /></Field>
        {mode === 'expense' && <label className="flex items-center gap-2 text-sm mb-3"><input type="checkbox" checked={f.reimbursable} onChange={(e) => setF({ ...f, reimbursable: e.target.checked })} /> Reimbursable (excluded from budgets once reimbursed)</label>}
        {tx && mode !== 'transfer' && (splits ? <div className="mb-3 border border-line rounded-lg p-3"><p className="text-sm font-medium mb-2">Split across categories</p>
          {splits.map((s, i) => <div key={i} className="flex gap-2 mb-2"><select className="input" aria-label="Split category" value={s.category_id} onChange={(e) => setSplits(splits.map((x, j) => (j === i ? { ...x, category_id: e.target.value } : x)))}><option value="">Uncategorized</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select><input className="input !w-32 num" aria-label="Split amount" value={s.amount} onChange={(e) => setSplits(splits.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} /><button type="button" className="btn" aria-label="Remove split" onClick={() => setSplits(splits.filter((_, j) => j !== i))}>✕</button></div>)}
          <div className="flex justify-between items-center"><button type="button" className="btn" onClick={() => setSplits([...splits, { category_id: '', amount: '' }])}>+ Add line</button><span className={`text-sm ${remaining === 0 ? 'text-good' : 'text-warn'}`}>{remaining === 0 ? 'Balanced' : `Remaining ${(remaining / 100).toFixed(2)}`}</span></div>
          <button type="button" className="text-xs text-mute underline mt-2" onClick={() => setSplits(null)}>Remove splitting</button></div> : <button type="button" className="btn mb-3" onClick={() => setSplits([{ category_id: f.category_id, amount: f.amount }, { category_id: '', amount: '' }])}>Split transaction</button>)}
        {links && (links.transfer?.length > 0 || links.refund?.length > 0) && <div className="mb-3 text-sm border border-line rounded-lg p-3"><p className="font-medium">Suggestions</p>
          {links.transfer?.map((l: any) => <p key={l.id} className="mt-1">Looks like a transfer with “{l.description}” on {l.posted_date}. <button type="button" className="text-brand underline" onClick={async () => { await api(`/transactions/${tx.id}/link-transfer`, { body: { other_id: l.id } }); onSaved('Linked as transfer'); }}>Link as transfer</button></p>)}
          {links.refund?.map((l: any) => <p key={l.id} className="mt-1">Possible refund of “{l.description}” ({l.posted_date}). <button type="button" className="text-brand underline" onClick={async () => { await api(`/transactions/${tx.id}`, { method: 'PATCH', body: { refund_of_id: l.id } }); onSaved('Linked as refund'); }}>Link refund</button></p>)}</div>}
        {msg && !Object.keys(err).length && <p role="alert" className="text-sm text-bad mb-2">{msg}</p>}
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></div>
      </form>
    </Modal>
  );
}
