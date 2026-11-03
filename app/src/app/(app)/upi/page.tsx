'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api, ApiFail, invalidate, todayStr, useApi } from '@/lib/client';
import { ErrorBox, Field, Loading, Money, PageHeader, Stat, useToast } from '@/components/ui';

export default function UpiPage() { return <Suspense fallback={<Loading />}><Upi /></Suspense>; }
function Upi() {
  const q = useSearchParams(); const sum = useApi<any>('/upi/summary'); const payees = useApi<any[]>('/upi/payees'); const accts = useApi<any[]>('/accounts'); const ids = useApi<any[]>('/upi/ids'); const toast = useToast();
  const inr = (accts.data ?? []).filter((a) => a.currency === 'INR' && !a.is_archived && ['checking', 'savings', 'cash', 'wallet', 'credit_card'].includes(a.type));
  const [f, setF] = useState({ payee: '', vpa: '', name: '', amount: '', note: '', account: '', date: todayStr(), ref: '' }); const [link, setLink] = useState<any>(null); const [err, setErr] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false);
  const bill = q.get('bill') ? { recurring_id: +q.get('bill')!, due: q.get('due') ?? todayStr() } : null;
  useEffect(() => { if (q.get('payee') && payees.data) { const p = payees.data.find((x) => x.id === +q.get('payee')!); if (p) setF((x) => ({ ...x, payee: String(p.id), vpa: p.vpa, name: p.name, amount: q.get('amount') ?? x.amount })); } }, [payees.data, q]);
  useEffect(() => { if (!f.account && inr[0]) setF((x) => ({ ...x, account: String(inr[0].id) })); }, [inr.length]); // eslint-disable-line
  const pick = (id: string) => { const p = payees.data?.find((x) => x.id === +id); setF({ ...f, payee: id, vpa: p?.vpa ?? f.vpa, name: p?.name ?? f.name }); setLink(null); };
  const mk = async () => { setErr({}); setBusy(true); try { setLink(await api('/upi/link', { body: { payee_id: f.payee ? +f.payee : undefined, vpa: f.payee ? undefined : f.vpa, name: f.name || undefined, amount: f.amount ? +f.amount : undefined, note: f.note || undefined } })); } catch (e) { setErr((e as ApiFail).fields ?? { vpa: (e as Error).message }); } finally { setBusy(false); } };
  const rec = async () => { setErr({}); setBusy(true); try { await api('/upi/payments', { body: { account_id: +f.account, vpa: link.vpa, name: f.name || link.name, amount: Math.round(+f.amount * 100), date: f.date, ref: f.ref || undefined, note: f.note || undefined, payee_id: f.payee ? +f.payee : undefined, bill } }); toast.show('Payment recorded'); setLink(null); setF({ ...f, amount: '', note: '', ref: '' }); invalidate(); } catch (e) { setErr((e as ApiFail).fields ?? { _: (e as Error).message }); } finally { setBusy(false); } };
  if (sum.error) return <ErrorBox msg={sum.error} retry={sum.reload} />; if (!sum.data) return <Loading />; const s = sum.data;
  return <>
    <PageHeader title="UPI" sub="Pay anyone through your own UPI app, then record it here. Ledgerly never touches your money." />
    <div className="grid sm:grid-cols-4 gap-3 mb-4"><Stat label="Sent this period" sub={`${s.sent.count} payments`}><Money v={s.sent.total} /></Stat><Stat label="Received" sub={`${s.received.count} credits`}><Money v={s.received.total} /></Stat>
      <Stat label="Sent today (₹)" sub={`typical limit ₹${s.daily_limit_inr.toLocaleString('en-IN')} per payment`}>₹{s.today_inr.toLocaleString('en-IN')}</Stat><Stat label="Saved payees">{payees.data?.length ?? 0}</Stat></div>
    <div className="grid lg:grid-cols-2 gap-4">
      <section className="card" aria-labelledby="pay-h"><h2 id="pay-h" className="font-medium mb-3">Make a payment</h2>
        {bill && <p className="chip mb-3">Settles a bill due {bill.due}</p>}
        <Field label="Saved payee"><select className="input" value={f.payee} onChange={(e) => pick(e.target.value)}><option value="">Enter a UPI ID instead</option>{payees.data?.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.vpa})</option>)}</select></Field>
        {!f.payee && <div className="grid grid-cols-2 gap-x-3"><Field label="UPI ID" error={err.vpa}><input className="input" value={f.vpa} onChange={(e) => { setF({ ...f, vpa: e.target.value }); setLink(null); }} placeholder="name@bank" autoCapitalize="none" /></Field><Field label="Payee name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field></div>}
        <div className="grid grid-cols-2 gap-x-3"><Field label="Amount (₹)" error={err.amount}><input className="input num" inputMode="decimal" value={f.amount} onChange={(e) => { setF({ ...f, amount: e.target.value }); setLink(null); }} /></Field><Field label="Note"><input className="input" maxLength={50} value={f.note} onChange={(e) => { setF({ ...f, note: e.target.value }); setLink(null); }} /></Field></div>
        <button className="btn btn-primary" disabled={busy || (!f.payee && !f.vpa)} onClick={mk}>Create payment link and QR</button>
        {link && <div className="mt-4 border-t border-line pt-4"><div className="flex gap-4 flex-wrap items-start"><div className="bg-white p-2 rounded-lg" aria-label="UPI QR code" dangerouslySetInnerHTML={{ __html: link.qr_svg }} />
          <div className="text-sm space-y-2 min-w-0 flex-1"><p>Pay <b>{link.name ?? link.vpa}</b> <span className="text-mute">{link.app && `· ${link.app}`}</span></p>{link.warnings.map((w: string) => <p key={w} className="text-warn text-xs">{w}</p>)}
            <a className="btn btn-primary" href={link.link}>Open in UPI app</a> <button className="btn" onClick={() => navigator.clipboard?.writeText(link.link).then(() => toast.show('Link copied'))}>Copy link</button><p className="text-xs text-mute">On a phone the button opens your UPI app. On a computer, scan the QR with your phone.</p></div></div>
          <h3 className="text-sm font-medium mt-4 mb-2">After you have paid</h3>
          <div className="grid grid-cols-2 gap-x-3"><Field label="Paid from" error={err.account_id}><select className="input" value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })}>{inr.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field><Field label="Date"><input type="date" className="input" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field></div>
          <Field label="UPI reference (12 digits, optional)" error={err.ref} hint="Stops the same payment being counted twice when your statement arrives."><input className="input num" inputMode="numeric" maxLength={12} value={f.ref} onChange={(e) => setF({ ...f, ref: e.target.value.replace(/\D/g, '') })} /></Field>
          {err._ && <p role="alert" className="text-bad text-sm mb-2">{err._}</p>}{!inr.length && <p className="text-warn text-xs mb-2">UPI payments are in rupees. Add an INR account first.</p>}
          <button className="btn btn-primary" disabled={busy || !f.account || !f.amount} onClick={rec}>I've paid: record it</button></div>}
      </section>
      <div className="space-y-4">
        <Payees payees={payees.data ?? []} onChange={payees.reload} />
        <section className="card"><h2 className="font-medium mb-2">Your UPI IDs</h2><OwnIds ids={ids.data ?? []} accts={inr} onChange={ids.reload} /></section>
        <Reader />
      </div></div>
    <div className="grid lg:grid-cols-2 gap-4 mt-4">
      <section className="card"><h2 className="font-medium mb-2">Top payees this period</h2>{s.top_payees.length ? <ul className="divide-y divide-line text-sm">{s.top_payees.map((p: any) => <li key={p.vpa ?? p.name} className="py-1.5 flex justify-between"><span className="truncate">{p.name} <span className="text-xs text-mute">{p.vpa}</span></span><Money v={p.total} /></li>)}</ul> : <p className="text-sm text-mute">No UPI payments yet. Payments imported from bank statements are detected automatically.</p>}</section>
      <section className="card"><h2 className="font-medium mb-2">Recent UPI activity</h2>{s.recent.length ? <ul className="divide-y divide-line text-sm">{s.recent.map((t: any) => <li key={t.id} className="py-1.5 flex justify-between gap-2"><span className="truncate">{t.posted_date} · {t.merchant ?? t.description}</span><Money v={t.amount} cur={t.currency} colored /></li>)}</ul> : <p className="text-sm text-mute">Nothing yet.</p>}
        {s.by_app.length > 0 && <p className="text-xs text-mute mt-2">By app: {s.by_app.map((a: any) => a.name).join(', ')}</p>}</section></div>
    {toast.node}</>;
}
function Payees({ payees, onChange }: { payees: any[]; onChange: () => void }) {
  const bills = useApi<any[]>('/recurring'); const [f, setF] = useState({ name: '', vpa: '', recurring_id: '' }); const [e, setE] = useState('');
  const add = async () => { setE(''); try { await api('/upi/payees', { body: { name: f.name, vpa: f.vpa, recurring_id: f.recurring_id ? +f.recurring_id : null } }); setF({ name: '', vpa: '', recurring_id: '' }); onChange(); } catch (x) { setE((x as ApiFail).fields?.vpa || (x as Error).message); } };
  return <section className="card"><h2 className="font-medium mb-2">Saved payees</h2>
    {payees.map((p) => <div key={p.id} className="flex justify-between items-center py-1.5 text-sm border-b border-line last:border-0"><span className="min-w-0 truncate">{p.name} <span className="text-xs text-mute">{p.vpa}{p.bill_name && ` · bill: ${p.bill_name}`}</span></span><button className="text-xs text-mute underline" onClick={async () => { await api(`/upi/payees/${p.id}`, { method: 'DELETE' }); onChange(); }}>Remove</button></div>)}
    <div className="grid grid-cols-2 gap-2 mt-3"><input className="input" placeholder="Name" aria-label="Payee name" value={f.name} onChange={(x) => setF({ ...f, name: x.target.value })} /><input className="input" placeholder="name@bank" aria-label="Payee UPI ID" autoCapitalize="none" value={f.vpa} onChange={(x) => setF({ ...f, vpa: x.target.value })} />
      <select className="input" aria-label="Link to bill" value={f.recurring_id} onChange={(x) => setF({ ...f, recurring_id: x.target.value })}><option value="">Not a bill</option>{bills.data?.filter((b) => b.kind === 'expense').map((b) => <option key={b.id} value={b.id}>Bill: {b.name}</option>)}</select><button className="btn" disabled={!f.name || !f.vpa} onClick={add}>Save payee</button></div>{e && <p role="alert" className="text-bad text-xs mt-1">{e}</p>}</section>;
}
function OwnIds({ ids, accts, onChange }: { ids: any[]; accts: any[]; onChange: () => void }) {
  const [f, setF] = useState({ vpa: '', account_id: '' }); const [e, setE] = useState('');
  return <><ul className="text-sm mb-2">{ids.map((i) => <li key={i.id} className="flex justify-between py-1"><span>{i.vpa} <span className="text-xs text-mute">{i.account_name && `→ ${i.account_name}`}</span></span><button className="text-xs text-mute underline" onClick={async () => { await api(`/upi/ids/${i.id}`, { method: 'DELETE' }); onChange(); }}>Remove</button></li>)}</ul>
    <div className="flex gap-2 flex-wrap"><input className="input !w-auto flex-1" placeholder="you@bank" aria-label="Your UPI ID" autoCapitalize="none" value={f.vpa} onChange={(x) => setF({ ...f, vpa: x.target.value })} /><select className="input !w-auto" aria-label="Linked account" value={f.account_id} onChange={(x) => setF({ ...f, account_id: x.target.value })}><option value="">Account</option>{accts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
      <button className="btn" disabled={!f.vpa} onClick={async () => { setE(''); try { await api('/upi/ids', { body: { vpa: f.vpa, account_id: f.account_id ? +f.account_id : null } }); setF({ vpa: '', account_id: '' }); onChange(); } catch (x) { setE((x as ApiFail).fields?.vpa || (x as Error).message); } }}>Add</button></div>{e && <p role="alert" className="text-bad text-xs mt-1">{e}</p>}</>;
}
function Reader() {
  const [t, setT] = useState(''); const [r, setR] = useState<any>(null);
  return <section className="card"><h2 className="font-medium mb-1">Read a UPI link or bank narration</h2><p className="text-xs text-mute mb-2">Paste a upi://pay link or a line from your statement to see the payee, UPI ID and reference.</p>
    <textarea className="input" rows={2} value={t} onChange={(e) => { setT(e.target.value); setR(null); }} aria-label="UPI link or narration" /><button className="btn mt-2" disabled={!t.trim()} onClick={async () => setR(await api('/upi/parse', { body: { text: t } }))}>Read</button>
    {r && (r.type === 'unknown' ? <p className="text-sm text-mute mt-2">That does not look like a UPI link or narration.</p> : <dl className="text-sm mt-2 grid grid-cols-[auto_1fr] gap-x-3">{[['Type', r.type], ['Payee', r.name ?? r.payee], ['UPI ID', r.vpa], ['Reference', r.ref], ['Amount', r.amount && `₹${r.amount}`], ['Note', r.note], ['Direction', r.direction]].filter((x) => x[1]).map(([k, v]) => <><dt key={k + 'k'} className="text-mute">{k}</dt><dd key={k + 'v'}>{v}</dd></>)}</dl>)}</section>;
}
