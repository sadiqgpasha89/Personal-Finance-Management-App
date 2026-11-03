'use client';
import { useState } from 'react';
import { api, ApiFail, fromMinor, invalidate, toMinor, useApi, useSession } from '@/lib/client';
import { Empty, ErrorBox, Field, Loading, Modal, Money, PageHeader, Progress, Stat, useToast } from '@/components/ui';

const KINDS: [string, string][] = [['credit', 'Credit card'], ['debit', 'Debit card'], ['prepaid', 'Prepaid / wallet card'], ['forex', 'Forex card']];
const NETWORKS = ['visa', 'mastercard', 'rupay', 'amex', 'diners', 'other'];
const GRAD: Record<string, string> = { credit: 'from-[#1b3a5c] to-[#0e2238]', debit: 'from-[#146e5a] to-[#0b4a3b]', prepaid: 'from-[#6b4e9b] to-[#46306b]', forex: 'from-[#9a5b1f] to-[#6b3b0e]' };
const BAND: Record<string, string> = { good: 'text-good', fair: 'text-warn', high: 'text-bad', unknown: 'text-mute' };

export default function Cards() {
  const { data, error, reload } = useApi<any>('/cards'); const accts = useApi<any[]>('/accounts'); const [edit, setEdit] = useState<any>(null); const [open, setOpen] = useState<number | null>(null); const toast = useToast();
  if (error) return <ErrorBox msg={error} retry={reload} />; if (!data) return <Loading />;
  const s = data.summary;
  return <>
    <PageHeader title="Cards" sub="Debit, credit and prepaid cards: limits, spending, due dates and expiry. Only the last 4 digits are ever stored." actions={<button className="btn btn-primary" onClick={() => setEdit({})}>+ Add card</button>} />
    {!data.items.length ? <Empty title="No cards yet" body="Add a card to see spending per card, credit utilization, payment due dates and annual-fee progress." action={<button className="btn btn-primary" onClick={() => setEdit({})}>Add a card</button>} /> : <>
      <div className="grid sm:grid-cols-3 gap-3 mb-4">
        <Stat label="Active cards">{s.active}</Stat>
        <Stat label="Credit utilization" sub={s.total_limit ? <><Money v={s.total_owed} /> of <Money v={s.total_limit} /></> : 'Add a credit limit to track this'}><span className={BAND[s.band]}>{s.utilization != null ? `${Math.round(s.utilization * 100)}%` : '–'}</span></Stat>
        <Stat label="Spent this period"><Money v={s.spent_period} /></Stat></div>
      {data.alerts.length > 0 && <div className="card mb-4 border-warn/40 bg-warn/5" role="status"><p className="text-sm font-medium mb-1">Needs attention</p><ul className="text-sm list-disc pl-5">{data.alerts.map((a: any) => <li key={a.type + a.card_id}>{a.text}</li>)}</ul></div>}
      <div className="grid md:grid-cols-2 gap-4">{data.items.map((k: any) => (
        <article key={k.id} className={`card !p-0 overflow-hidden ${k.status !== 'active' ? 'opacity-70' : ''}`}>
          <div className={`bg-gradient-to-br ${GRAD[k.kind]} text-white p-4`}>
            <div className="flex justify-between text-xs opacity-90"><span>{k.issuer || 'Card'} · {KINDS.find((x) => x[0] === k.kind)?.[1]}</span><span className="uppercase tracking-wide">{k.network}</span></div>
            <p className="mt-5 text-lg tracking-[0.2em] num">•••• •••• •••• {k.last4}</p>
            <div className="flex justify-between mt-3 text-xs"><span>{k.nickname}</span><span>{k.expiry_month ? `${String(k.expiry_month).padStart(2, '0')}/${String(k.expiry_year).slice(-2)}` : ''}{k.status !== 'active' && ` · ${k.status}`}</span></div></div>
          <div className="p-4 text-sm">
            <div className="flex justify-between"><span className="text-mute">Spent this period</span><Money v={k.spent_period} /></div>
            <div className="flex justify-between"><span className="text-mute">This year</span><Money v={k.spent_ytd} /></div>
            {k.kind === 'credit' && k.credit_limit ? <div className="mt-2"><div className="flex justify-between"><span className="text-mute">Used</span><span><Money v={k.owed ?? 0} /> of <Money v={k.credit_limit} /> <b className={BAND[k.utilization_band]}>({Math.round((k.utilization ?? 0) * 100)}%)</b></span></div><div className="my-1.5"><Progress pct={k.utilization ?? 0} warn={0.3} /></div><p className="text-xs text-mute">Available <Money v={k.available_credit} />{k.next_due && <> · payment due {k.next_due}</>}</p></div> : null}
            {k.fee && <p className="text-xs text-mute mt-2">Annual fee <Money v={k.fee.fee} />: {k.fee.waived ? 'waived this year ✓' : <>spend <Money v={k.fee.remaining} /> more to waive</>}</p>}
            {k.expiry.state === 'expiring' && <p className="text-xs text-warn mt-2">Expires in {k.expiry.daysLeft} days</p>}{k.expiry.state === 'expired' && <p className="text-xs text-bad mt-2">Expired</p>}
            {k.rewards && <p className="text-xs text-mute mt-2">Rewards: {k.rewards}</p>}{k.account_name && <p className="text-xs text-mute">Linked to {k.account_name}</p>}
            <div className="flex gap-2 mt-3"><button className="btn" onClick={() => setOpen(open === k.id ? null : k.id)} aria-expanded={open === k.id}>{open === k.id ? 'Hide' : 'Transactions'}</button><button className="btn" onClick={() => setEdit(k)}>Edit</button></div>
            {open === k.id && <CardTxns id={k.id} />}</div></article>))}</div></>}
    {edit && <CardModal k={edit} accts={accts.data ?? []} onClose={() => setEdit(null)} onSaved={(m: string) => { setEdit(null); invalidate(); toast.show(m); }} />}
    {toast.node}</>;
}
function CardTxns({ id }: { id: number }) {
  const { data } = useApi<any[]>(`/cards/${id}/transactions`);
  if (!data) return <p className="text-xs text-mute mt-3">Loading…</p>; if (!data.length) return <p className="text-xs text-mute mt-3">No transactions yet. Tag a transaction with this card when you add or edit it.</p>;
  return <ul className="mt-3 divide-y divide-line text-xs max-h-64 overflow-auto">{data.map((t) => <li key={t.id} className="py-1.5 flex justify-between gap-2"><span className="truncate">{t.posted_date} · {t.merchant ?? t.description}</span><Money v={t.amount} cur={t.currency} colored /></li>)}</ul>;
}
function CardModal({ k, accts, onClose, onSaved }: any) {
  const { base } = useSession();
  const [f, setF] = useState({ nickname: k.nickname ?? '', kind: k.kind ?? 'credit', network: k.network ?? 'visa', issuer: k.issuer ?? '', last4: k.last4 ?? '', expiry_month: String(k.expiry_month ?? ''), expiry_year: String(k.expiry_year ?? ''), account_id: String(k.account_id ?? ''),
    credit_limit: fromMinor(k.credit_limit, base), statement_day: String(k.statement_day ?? ''), due_day: String(k.due_day ?? ''), annual_fee: fromMinor(k.annual_fee, base), fee_waiver_spend: fromMinor(k.fee_waiver_spend, base), rewards: k.rewards ?? '', status: k.status ?? 'active' });
  const [err, setErr] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false); const set = (p: any) => setF({ ...f, ...p });
  const n = (v: string) => (v ? +v : null); const m = (v: string) => (v ? toMinor(v, base) : null);
  const save = async (e: React.FormEvent) => { e.preventDefault(); setBusy(true); setErr({});
    const body = { nickname: f.nickname, kind: f.kind, network: f.network, issuer: f.issuer || null, last4: f.last4, expiry_month: n(f.expiry_month), expiry_year: n(f.expiry_year), account_id: n(f.account_id), credit_limit: f.kind === 'credit' ? m(f.credit_limit) : null, statement_day: n(f.statement_day), due_day: n(f.due_day), annual_fee: m(f.annual_fee), fee_waiver_spend: m(f.fee_waiver_spend), rewards: f.rewards || null, status: f.status };
    try { k.id ? await api(`/cards/${k.id}`, { method: 'PATCH', body }) : await api('/cards', { body }); onSaved(k.id ? 'Card saved' : 'Card added'); } catch (x) { setErr((x as ApiFail).fields ?? { _: (x as Error).message }); } finally { setBusy(false); } };
  return <Modal open onClose={onClose} title={k.id ? 'Edit card' : 'Add card'} wide><form noValidate onSubmit={save}>
    <div className="grid sm:grid-cols-2 gap-x-3">
      <Field label="Nickname" error={err.nickname}><input className="input" value={f.nickname} onChange={(e) => set({ nickname: e.target.value })} placeholder="e.g. HDFC Regalia" /></Field>
      <Field label="Type"><select className="input" value={f.kind} onChange={(e) => set({ kind: e.target.value })}>{KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
      <Field label="Issuer / bank"><input className="input" value={f.issuer} onChange={(e) => set({ issuer: e.target.value })} /></Field>
      <Field label="Network"><select className="input" value={f.network} onChange={(e) => set({ network: e.target.value })}>{NETWORKS.map((v) => <option key={v}>{v}</option>)}</select></Field>
      <Field label="Last 4 digits" error={err.last4} hint="Never enter the full number, expiry-only is fine."><input className="input num" inputMode="numeric" maxLength={4} value={f.last4} onChange={(e) => set({ last4: e.target.value.replace(/\D/g, '') })} /></Field>
      <Field label="Expiry (month / year)"><div className="flex gap-2"><input className="input num" placeholder="MM" inputMode="numeric" maxLength={2} value={f.expiry_month} onChange={(e) => set({ expiry_month: e.target.value })} /><input className="input num" placeholder="YYYY" inputMode="numeric" maxLength={4} value={f.expiry_year} onChange={(e) => set({ expiry_year: e.target.value })} /></div></Field>
      <Field label="Linked account" hint="Credit card account for balance, or the bank account a debit card draws from."><select className="input" value={f.account_id} onChange={(e) => set({ account_id: e.target.value })}><option value="">None</option>{accts.filter((a: any) => !a.is_archived).map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
      <Field label="Status"><select className="input" value={f.status} onChange={(e) => set({ status: e.target.value })}><option value="active">Active</option><option value="blocked">Blocked</option><option value="expired">Expired</option></select></Field>
      {f.kind === 'credit' && <><Field label={`Credit limit (${base})`} error={err.credit_limit}><input className="input num" inputMode="decimal" value={f.credit_limit} onChange={(e) => set({ credit_limit: e.target.value })} /></Field>
        <Field label="Statement day / due day"><div className="flex gap-2"><input className="input num" placeholder="Statement" inputMode="numeric" value={f.statement_day} onChange={(e) => set({ statement_day: e.target.value })} /><input className="input num" placeholder="Due" inputMode="numeric" value={f.due_day} onChange={(e) => set({ due_day: e.target.value })} /></div></Field></>}
      <Field label={`Annual fee (${base})`}><input className="input num" inputMode="decimal" value={f.annual_fee} onChange={(e) => set({ annual_fee: e.target.value })} /></Field>
      <Field label="Spend per year to waive the fee"><input className="input num" inputMode="decimal" value={f.fee_waiver_spend} onChange={(e) => set({ fee_waiver_spend: e.target.value })} /></Field>
    </div>
    <Field label="Rewards" error={err.rewards}><input className="input" value={f.rewards} onChange={(e) => set({ rewards: e.target.value })} placeholder="e.g. 5% on dining, 1% elsewhere" /></Field>
    {err._ && <p role="alert" className="text-bad text-sm mb-2">{err._}</p>}
    <div className="flex justify-between">{k.id ? <button type="button" className="btn btn-danger" onClick={async () => { await api(`/cards/${k.id}`, { method: 'DELETE' }); onSaved('Card removed'); }}>Delete</button> : <span />}<div className="flex gap-2"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy}>Save</button></div></div></form></Modal>;
}
