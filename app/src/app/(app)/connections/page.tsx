'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { api, ApiFail, invalidate, useApi } from '@/lib/client';
import { Empty, ErrorBox, Field, Loading, Money, PageHeader, useToast } from '@/components/ui';

export default function Connections() { return <Suspense fallback={<Loading />}><Page /></Suspense>; }
const STATUS: Record<string, string> = { ACTIVE: 'text-good', PENDING: 'text-warn', REJECTED: 'text-bad', REVOKED: 'text-mute', EXPIRED: 'text-mute' };
function Page() {
  const q = useSearchParams(); const links = useApi<{ items: any[] }>('/connections'); const prov = useApi<any>('/connections/providers'); const toast = useToast();
  const [f, setF] = useState({ mobile: '', aa: 'anumati', months: '6' }); const [err, setErr] = useState<Record<string, string>>({}); const [busy, setBusy] = useState<string>('');
  const link = async () => { setErr({}); setBusy('link'); try { const r = await api<{ approval_url: string }>('/connections', { body: { mobile: f.mobile, aa_handle: f.aa, months: +f.months } }); window.location.href = r.approval_url; } catch (e) { const a = e as ApiFail; setErr(a.fields ?? { _: a.message }); setBusy(''); } };
  const sync = async (id: number) => { setBusy('s' + id); try { const r = await api<any>(`/connections/${id}/sync`, { method: 'POST', body: {} }); toast.show(`Synced: ${r.new_transactions} new transactions${r.created_accounts ? `, ${r.created_accounts} new account(s)` : ''}`); invalidate(); } catch (e) { toast.show((e as Error).message); } finally { setBusy(''); } };
  if (links.error) return <ErrorBox msg={links.error} retry={links.reload} />; if (!links.data) return <Loading />;
  const sandbox = prov.data?.mode === 'sandbox';
  return <>
    <PageHeader title="Bank links" sub="Pull accounts and transactions from several banks at once through an RBI-regulated Account Aggregator. You approve each link, and can revoke it any time." />
    {q.get('result') && <div role="status" className={`card mb-4 text-sm ${q.get('result') === 'active' ? 'border-good/40' : 'border-warn/40'}`}>{q.get('result') === 'active' ? 'Consent approved. Press “Sync now” to bring in your accounts.' : 'The link was not approved.'}</div>}
    {sandbox && <div role="note" className="card mb-4 text-sm border-warn/40 bg-warn/5"><b>Sandbox mode.</b> No real bank or Account Aggregator is contacted: the consent screen is a simulator and the accounts are synthetic sample data (HDFC, SBI and ICICI style). Any valid 10-digit mobile works; the OTP is <code>{prov.data.sandbox_otp}</code>. To go live, the operator registers Ledgerly as a Financial Information User and sets the aggregator service to live mode.</div>}
    <section className="card mb-4" aria-labelledby="l-h"><h2 id="l-h" className="font-medium mb-3">Link your banks</h2>
      <div className="grid sm:grid-cols-4 gap-x-3"><Field label="Mobile number registered with your banks" error={err.mobile}><input className="input num" inputMode="numeric" maxLength={10} value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value.replace(/\D/g, '') })} placeholder="9876543210" /></Field>
        <Field label="Account Aggregator"><select className="input" value={f.aa} onChange={(e) => setF({ ...f, aa: e.target.value })}>{(prov.data?.aa_handles ?? [{ handle: 'anumati', name: 'Anumati' }]).map((h: any) => <option key={h.handle} value={h.handle}>{h.name}</option>)}</select></Field>
        <Field label="History to fetch"><select className="input" value={f.months} onChange={(e) => setF({ ...f, months: e.target.value })}>{[3, 6, 12, 24].map((m) => <option key={m} value={m}>{m} months</option>)}</select></Field>
        <div className="flex items-end mb-3"><button className="btn btn-primary w-full" disabled={busy === 'link' || f.mobile.length !== 10} onClick={link}>{busy === 'link' ? 'Opening…' : 'Link banks'}</button></div></div>
      {err._ && <p role="alert" className="text-bad text-sm">{err._}</p>}
      <p className="text-xs text-mute">You will be taken to your Account Aggregator to choose accounts and approve with an OTP. Ledgerly receives only the data you approve, only for the period you approve, and stores no bank credentials.</p></section>
    {!links.data.items.length ? <Empty title="No banks linked yet" body="Link your banks to import accounts, balances and transactions automatically, including UPI payments." /> :
      <div className="space-y-3">{links.data.items.map((l) => <article key={l.id} className="card">
        <div className="flex flex-wrap justify-between gap-2"><div><p className="font-medium">{l.aa_handle} · {l.mobile_masked}</p><p className="text-xs text-mute">Status <b className={STATUS[l.status]}>{l.status.toLowerCase()}</b>{l.last_sync_at && <> · last sync {l.last_sync_at}</>}{l.expires_at && <> · consent until {l.expires_at.slice(0, 10)}</>}</p></div>
          <div className="flex gap-2">{l.status === 'ACTIVE' && <button className="btn" disabled={busy === 's' + l.id} onClick={() => sync(l.id)}>{busy === 's' + l.id ? 'Syncing…' : 'Sync now'}</button>}{!['REVOKED', 'REJECTED'].includes(l.status) && <button className="btn btn-danger" onClick={async () => { await api(`/connections/${l.id}`, { method: 'DELETE' }); invalidate(); toast.show('Link revoked. Imported data stays in Ledgerly.'); }}>Unlink</button>}</div></div>
        {l.accounts.length > 0 && <ul className="mt-3 divide-y divide-line text-sm">{l.accounts.map((a: any) => <li key={a.id} className="py-1.5 flex justify-between gap-2"><span>{a.fip_name} <span className="text-xs text-mute">{a.masked_acc}</span></span><span className="text-right"><Money v={a.local_balance ?? 0} cur="INR" />{a.drift ? <span className="block text-xs text-warn">bank reports <Money v={a.reported_balance} cur="INR" /></span> : <span className="block text-xs text-good">matches bank</span>}</span></li>)}</ul>}
        {l.last_sync_note && <p className="text-xs text-warn mt-2">{l.last_sync_note}</p>}</article>)}</div>}
    {toast.node}</>;
}
