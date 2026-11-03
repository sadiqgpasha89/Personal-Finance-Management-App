'use client';
import { useEffect, useState } from 'react';
import { api, ApiFail, invalidate, todayStr, useApi, useSession } from '@/lib/client';
import { ErrorBox, Field, Loading, Money, PageHeader, useToast } from '@/components/ui';

const BAND: Record<string, [string, string]> = { poor: ['Poor', '#c0504d'], fair: ['Fair', '#d9822b'], good: ['Good', '#b8a000'], very_good: ['Very good', '#4a9d5a'], excellent: ['Excellent', '#146e5a'] };
const ST: Record<string, string> = { good: 'text-good', fair: 'text-warn', poor: 'text-bad' };
const TYPE: Record<string, string> = { credit_card: 'Credit card', personal_loan: 'Personal loan', auto_loan: 'Auto loan', home_loan: 'Home loan', consumer_loan: 'Consumer loan' };
function Gauge({ score, band }: { score: number; band: string }) {
  const pct = (score - 300) / 600, R = 80, C = Math.PI * R; const [label, color] = BAND[band] ?? ['', '#888'];
  return <svg viewBox="0 0 200 120" role="img" aria-label={`Credit score ${score}, ${label}`} className="w-full max-w-xs mx-auto"><path d="M20 100 A80 80 0 0 1 180 100" fill="none" stroke="rgb(var(--line))" strokeWidth="14" strokeLinecap="round" /><path d="M20 100 A80 80 0 0 1 180 100" fill="none" stroke={color} strokeWidth="14" strokeLinecap="round" strokeDasharray={`${C * pct} ${C}`} />
    <text x="100" y="88" textAnchor="middle" fontSize="38" fontWeight="700" fill="currentColor">{score}</text><text x="100" y="108" textAnchor="middle" fontSize="12" fill={color}>{label}</text><text x="20" y="118" fontSize="9" fill="rgb(var(--mute))">300</text><text x="180" y="118" textAnchor="end" fontSize="9" fill="rgb(var(--mute))">900</text></svg>;
}
export default function Credit() {
  const { data, error, reload } = useApi<any>('/credit'); const prof = useApi<any>('/profile'); const toast = useToast(); const { me } = useSession();
  const [f, setF] = useState({ name: '', dob: '', pan: '', mobile: '', consent: false }); const [err, setErr] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false);
  useEffect(() => { if (prof.data) setF((x) => ({ ...x, name: x.name || prof.data.full_name || me.user?.name || '', dob: x.dob || prof.data.date_of_birth || '' })); }, [prof.data]); // eslint-disable-line
  const go = async (e: React.FormEvent) => { e.preventDefault(); setErr({}); setBusy(true); try { await api('/credit/fetch', { body: f }); setF((x) => ({ ...x, pan: '', consent: false })); invalidate(); toast.show('Credit report fetched'); } catch (x) { const a = x as ApiFail; setErr(a.fields ?? { _: a.message }); } finally { setBusy(false); } };
  if (error) return <ErrorBox msg={error} retry={reload} />; if (!data) return <Loading />; const r = data.latest;
  return <>
    <PageHeader title="Credit score" sub="Your credit report and score, what drives them, and how to improve." actions={r && <button className="btn btn-danger" onClick={async () => { await api('/credit', { method: 'DELETE' }); invalidate(); toast.show('Saved reports deleted'); }}>Delete saved reports</button>} />
    {data.provider?.sample !== false && <div role="note" className="card mb-4 text-sm border-warn/40 bg-warn/5"><b>Sample data.</b> This build is connected to a sandbox bureau that generates a made-up report from the PAN you enter. It is <b>not</b> your real CIBIL report. Real reports need a licensed bureau partner connected by the operator.</div>}
    {r && <>
      <div className="grid md:grid-cols-3 gap-4 mb-4">
        <section className="card md:col-span-1"><Gauge score={r.score.value} band={r.score.band} /><p className="text-xs text-mute text-center mt-1">{r.score.model}{r.sample && ' · sample'}</p><p className="text-xs text-mute text-center">Fetched {r.fetched_at}</p>
          {data.history.length > 1 && <p className="text-xs text-center mt-2">History: {data.history.map((h: any) => h.score).join(' → ')}</p>}</section>
        <section className="card md:col-span-2"><h2 className="font-medium mb-2">What affects your score</h2><ul className="space-y-3">{r.factors.map((x: any) => <li key={x.id}><div className="flex justify-between text-sm"><span>{x.name} <span className="text-xs text-mute">({x.weight}% weight)</span></span><b className={ST[x.status]}>{x.value}</b></div><p className="text-xs text-mute">{x.detail}</p>{x.status !== 'good' && <p className="text-xs">💡 {x.tip}</p>}</li>)}</ul>
          {data.ledgerly_card_utilization != null && <p className="text-xs text-mute mt-3 border-t border-line pt-2">Your cards in Ledgerly are at {Math.round(data.ledgerly_card_utilization * 100)}% utilization; the bureau sees {Math.round(r.summary.utilization * 100)}%. Differences usually mean the bureau has an older balance (lenders report monthly).</p>}</section></div>
      <section className="card !p-0 overflow-x-auto mb-4"><h2 className="font-medium p-3 pb-0">Accounts on your report</h2><table className="w-full min-w-[620px]"><thead><tr><th className="th">Lender</th><th className="th">Type</th><th className="th">Opened</th><th className="th text-right">Limit / amount</th><th className="th text-right">Balance</th><th className="th">Last 12 months</th></tr></thead>
        <tbody>{r.tradelines.map((t: any, i: number) => <tr key={i}><td className="td">{t.lender}{t.status === 'closed' && <span className="chip ml-2">closed</span>}</td><td className="td">{TYPE[t.type] ?? t.type}</td><td className="td num">{t.opened.slice(0, 7)}</td><td className="td text-right"><Money v={t.limit_or_amount} cur="INR" /></td><td className="td text-right"><Money v={t.balance} cur="INR" /></td>
          <td className="td"><span className="inline-flex gap-0.5" aria-label="Payment history, newest first">{t.dpd_history.slice(0, 12).map((d: number, j: number) => <span key={j} title={d ? `${d} days late` : 'On time'} className={`w-2.5 h-4 rounded-sm ${d === 0 ? 'bg-good' : d < 90 ? 'bg-warn' : 'bg-bad'}`} />)}</span></td></tr>)}</tbody></table></section>
      {r.enquiries.length > 0 && <section className="card mb-4"><h2 className="font-medium mb-2">Recent enquiries</h2><ul className="text-sm divide-y divide-line">{r.enquiries.map((e: any, i: number) => <li key={i} className="py-1 flex justify-between"><span>{e.lender} <span className="text-xs text-mute">{e.purpose}</span></span><span className="text-xs text-mute">{e.date.slice(0, 7)}</span></li>)}</ul></section>}</>}
    <section className="card" aria-labelledby="f-h"><h2 id="f-h" className="font-medium mb-3">{r ? 'Refresh your report' : 'Get your credit report'}</h2>
      <form noValidate onSubmit={go}><div className="grid sm:grid-cols-2 gap-x-3"><Field label="Name as on PAN" error={err.name}><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="name" /></Field>
        <Field label="Date of birth" error={err.dob}><input type="date" max={todayStr()} className="input" value={f.dob} onChange={(e) => setF({ ...f, dob: e.target.value })} /></Field>
        <Field label="PAN" error={err.pan} hint="Used for this request only. Not stored; only the last 4 characters are kept."><input className="input uppercase" maxLength={10} value={f.pan} onChange={(e) => setF({ ...f, pan: e.target.value.toUpperCase() })} autoComplete="off" placeholder="ABCPE1234F" /></Field>
        <Field label="Mobile number" error={err.mobile}><input className="input num" inputMode="numeric" maxLength={10} value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value.replace(/\D/g, '') })} /></Field></div>
        <label className="flex gap-2 text-sm mb-1"><input type="checkbox" className="mt-1" checked={f.consent} onChange={(e) => setF({ ...f, consent: e.target.checked })} /><span>{data.consent_text}</span></label>{err.consent && <p role="alert" className="text-bad text-xs mb-2">{err.consent}</p>}
        {err._ && <p role="alert" className="text-bad text-sm mb-2">{err._}</p>}<button className="btn btn-primary mt-2" disabled={busy}>{busy ? 'Fetching…' : 'Fetch report'}</button></form></section>
    {toast.node}</>;
}
