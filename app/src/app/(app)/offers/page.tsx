'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api, invalidate, useApi, useSession } from '@/lib/client';
import { Empty, ErrorBox, Loading, Money, PageHeader, useToast } from '@/components/ui';

export default function Offers() {
  const { data, error, reload } = useApi<any>('/offers'); const { fmt } = useSession(); const toast = useToast();
  const [tab, setTab] = useState<'for_you' | 'saved' | 'other'>('for_you'); const [cat, setCat] = useState('All');
  if (error) return <ErrorBox msg={error} retry={reload} />; if (!data) return <Loading />;
  const set = async (id: string, status: string, msg: string) => { await api(`/offers/${id}/status`, { method: 'PUT', body: { status } }); invalidate(); toast.show(msg); };
  const live = data.eligible.filter((o: any) => o.status === 'new'), saved = data.eligible.filter((o: any) => o.status === 'saved'), hidden = data.eligible.filter((o: any) => o.status === 'dismissed');
  const cats = ['All', ...new Set<string>(live.map((o: any) => o.category))];
  const list = tab === 'for_you' ? live.filter((o: any) => cat === 'All' || o.category === cat) : tab === 'saved' ? saved : data.other;
  return <>
    <PageHeader title="Offers" sub={`Matched to your last ${data.lookback_months} months of transactions${data.personalized_with_profile ? ' and your profile' : ''}.`} actions={<Link href="/profile" className="btn">Improve matches</Link>} />
    <div role="note" className="card mb-4 text-sm border-warn/40 bg-warn/5">These offers come from a <strong>sample catalogue</strong> with fictional partners, so no real approvals, rates or sign-ups happen here. The estimates show how Ledgerly would match and value offers from your own spending.</div>
    {!data.has_history ? <Empty title="No transactions yet" body="Add or import some transactions, or load the demo data from the dashboard, and offers will appear here." action={<Link className="btn btn-primary" href="/import">Import transactions</Link>} /> : <>
      <div className="grid sm:grid-cols-3 gap-3 mb-4">
        <div className="card"><p className="text-xs text-mute">Offers that fit you</p><p className="text-2xl font-semibold mt-1 num">{live.length + saved.length}</p></div>
        <div className="card sm:col-span-2"><p className="text-xs text-mute">Estimated yearly benefit if you took them all</p><p className="text-2xl font-semibold mt-1 num text-good"><Money v={data.total_potential} /></p><p className="text-xs text-mute mt-1">Illustrative; individual estimates overlap and depend on approval and your future spending.</p></div>
      </div>
      <div role="tablist" className="flex gap-1 mb-3 flex-wrap">{([['for_you', `For you (${live.length})`], ['saved', `Saved (${saved.length})`], ['other', `Not a fit yet (${data.other.length})`]] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`btn ${tab === k ? 'btn-primary' : ''}`} onClick={() => setTab(k)}>{l}</button>)}</div>
      {tab === 'for_you' && cats.length > 2 && <div className="flex gap-1.5 flex-wrap mb-3" aria-label="Filter by category">{cats.map((c) => <button key={c} className={`chip ${cat === c ? 'bg-brand/10 text-brand border-brand' : ''}`} aria-pressed={cat === c} onClick={() => setCat(c)}>{c}</button>)}</div>}
      {!list.length ? <Empty title={tab === 'for_you' ? 'Nothing new right now' : tab === 'saved' ? 'No saved offers' : 'Everything fits you'} body={tab === 'for_you' ? 'As your history grows, new matches will show up here.' : tab === 'saved' ? 'Save an offer to keep it handy.' : 'Every catalogue offer matches your history.'} /> :
        <div className="grid md:grid-cols-2 gap-4">{list.map((o: any) => <article key={o.id} className="card flex flex-col">
          <div className="flex justify-between gap-2"><div><p className="font-medium">{o.title}</p><p className="text-xs text-mute">{o.partner} · {o.category}</p></div>{o.eligible && <span className="chip shrink-0" title="How strongly this matches your history">{o.score}% match</span>}</div>
          <p className="text-sm mt-2">{o.blurb}</p>
          {o.eligible ? <>
            {o.annual_benefit != null && <p className="mt-3 text-sm">Estimated benefit <Money v={o.annual_benefit} className="font-semibold text-good" /> <span className="text-mute">per year</span></p>}
            <div className="mt-3"><p className="text-xs font-medium text-mute">Why you're seeing this</p><ul className="text-sm list-disc pl-5">{o.why.map((w: string) => <li key={w}>{w}</li>)}</ul></div>
            {!!o.assumptions.length && <p className="text-xs text-mute mt-2">How it's estimated: {o.assumptions.join(' ')}</p>}
          </> : <p className="mt-3 text-sm text-mute">{o.reason_not}</p>}
          <details className="mt-3 text-xs text-mute"><summary className="cursor-pointer">Terms</summary><p className="mt-1">{o.terms}</p></details>
          {o.eligible && <div className="mt-auto pt-3 flex gap-2">
            {o.status === 'saved' ? <button className="btn" onClick={() => set(o.id, 'new', 'Removed from saved')}>Unsave</button> : <button className="btn btn-primary" onClick={() => set(o.id, 'saved', 'Saved. We have not contacted anyone.')}>Save offer</button>}
            {o.status === 'new' && <button className="btn" onClick={() => set(o.id, 'dismissed', 'Hidden')}>Not interested</button>}</div>}
        </article>)}</div>}
      {!!hidden.length && tab === 'for_you' && <p className="text-xs text-mute mt-4">{hidden.length} hidden. <button className="underline" onClick={async () => { for (const o of hidden) await api(`/offers/${o.id}/status`, { method: 'PUT', body: { status: 'new' } }); invalidate(); }}>Restore</button></p>}
    </>}
    {toast.node}</>;
}
