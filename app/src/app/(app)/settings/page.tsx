'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, ApiFail, invalidate, useApi, useSession } from '@/lib/client';
import { Field, Loading, Modal, PageHeader, useToast } from '@/components/ui';

export default function Settings() {
  const s = useSession(); const w = s.me.workspace!; const toast = useToast(); const router = useRouter();
  const rules = useApi<any[]>('/rules'); const cats = useApi<any[]>('/categories'); const fx = useApi<any[]>('/fx'); const act = useApi<any[]>('/activity');
  const [name, setName] = useState(w.name); const [cur, setCur] = useState(w.base_currency); const [day, setDay] = useState(String(w.month_start_day)); const [del, setDel] = useState(false); const [rule, setRule] = useState(false);
  const save = async () => { try { await api('/settings', { method: 'PATCH', body: { name, base_currency: cur, month_start_day: +day } }); s.refresh(); invalidate(); toast.show('Settings saved'); } catch (e) { toast.show((e as ApiFail).message); } };
  return <>
    <PageHeader title="Settings" />
    <div className="grid lg:grid-cols-2 gap-4">
      <div className="card"><h2 className="font-medium mb-3">Workspace</h2>
        <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <div className="grid grid-cols-2 gap-3"><Field label="Base currency" hint="Reports convert to this. Past transactions keep their original rate."><select className="input" value={cur} onChange={(e) => setCur(e.target.value)}>{s.me.currencies?.map((c) => <option key={c}>{c}</option>)}</select></Field>
          <Field label="Budget month starts on day" hint="e.g. 25 if you're paid on the 25th."><input className="input" type="number" min={1} max={31} value={day} onChange={(e) => setDay(e.target.value)} /></Field></div>
        <button className="btn btn-primary" onClick={save}>Save</button></div>
      <div className="card"><h2 className="font-medium mb-1">Your data</h2><p className="text-sm text-mute mb-3">You own it. Export everything anytime, or delete your account.</p>
        <div className="flex gap-2 flex-wrap"><a className="btn" href="/api/export/csv">Transactions CSV</a><a className="btn" href="/api/export/json">Full JSON export</a><button className="btn btn-danger" onClick={() => setDel(true)}>Delete account…</button><button className="btn" onClick={async () => { await api('/auth/logout', { method: 'POST', body: {} }); router.replace('/login'); }}>Sign out</button></div></div>
      <div className="card"><div className="flex justify-between items-center mb-2"><h2 className="font-medium">Auto-categorization rules</h2><div className="flex gap-2"><button className="btn" onClick={async () => { const r = await api<any>('/rules/apply', { body: {} }); invalidate(); toast.show(`${r.categorized} transactions categorized`); }}>Apply to uncategorized</button><button className="btn btn-primary" onClick={() => setRule(true)}>+ Rule</button></div></div>
        <p className="text-xs text-mute mb-2">Order: your rules → remembered merchants → built-in merchant dictionary. Corrections you make are remembered automatically.</p>
        {rules.data?.length ? <ul className="divide-y divide-line">{rules.data.map((r) => <li key={r.id} className="py-2 text-sm flex justify-between gap-2"><span>If {r.conditions.map((c: any) => `${c.field} ${c.op} “${c.value}”`).join(' and ')} → {r.actions.category && <b>{r.actions.category}</b>}{r.actions.tag && <> #{r.actions.tag}</>}</span><button className="text-bad underline" onClick={async () => { await api(`/rules/${r.id}`, { method: 'DELETE' }); invalidate(); }}>Remove</button></li>)}</ul> : <p className="text-sm text-mute">No custom rules yet.</p>}</div>
      <div className="card"><h2 className="font-medium mb-2">Exchange rates</h2><p className="text-xs text-mute mb-2">Units per 1 USD. Edit to match your preferred source; rates are frozen onto transactions when saved.</p>
        <div className="grid grid-cols-2 gap-2">{fx.data?.map((r) => <FxRow key={r.quote} r={r} />)}</div></div>
      <div className="card lg:col-span-2"><h2 className="font-medium mb-2">Recent activity</h2>{act.data?.length ? <ul className="text-sm divide-y divide-line max-h-60 overflow-auto">{act.data.slice(0, 30).map((a) => <li key={a.id} className="py-1.5 flex justify-between"><span>{a.action} {a.entity} #{a.entity_id}</span><span className="text-mute">{a.at}</span></li>)}</ul> : <p className="text-sm text-mute">No activity yet.</p>}</div>
    </div>
    {del && <DeleteModal onClose={() => setDel(false)} onDone={() => router.replace('/register')} />}
    {rule && cats.data && <RuleModal cats={cats.data} onClose={() => setRule(false)} onSaved={() => { setRule(false); invalidate(); }} />}
    {toast.node}</>;
}
function FxRow({ r }: { r: any }) { const [v, setV] = useState(String(r.rate)); return <label className="flex items-center gap-2 text-sm"><span className="w-10">{r.quote}</span><input className="input num" value={v} disabled={r.quote === 'USD'} onChange={(e) => setV(e.target.value)} onBlur={() => Number(v) > 0 && Number(v) !== r.rate && api('/fx', { method: 'PUT', body: { quote: r.quote, rate: Number(v) } })} /></label>; }
function RuleModal({ cats, onClose, onSaved }: any) {
  const [f, setF] = useState({ field: 'description', op: 'contains', value: '', category: '', tag: '' }); const [err, setErr] = useState('');
  return <Modal open onClose={onClose} title="New rule"><form noValidate onSubmit={async (e) => { e.preventDefault(); try { await api('/rules', { body: { conditions: [{ field: f.field, op: f.op, value: f.value }], actions: { ...(f.category && { category: f.category }), ...(f.tag && { tag: f.tag }) } } }); onSaved(); } catch (x) { setErr((x as ApiFail).message); } }}>
    <div className="grid grid-cols-3 gap-2"><Field label="When"><select className="input" value={f.field} onChange={(e) => setF({ ...f, field: e.target.value })}><option value="description">Description</option><option value="merchant">Merchant</option></select></Field><Field label="Matches"><select className="input" value={f.op} onChange={(e) => setF({ ...f, op: e.target.value })}><option value="contains">contains</option><option value="startsWith">starts with</option><option value="equals">equals</option><option value="regex">regex</option></select></Field><Field label="Text"><input className="input" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} /></Field></div>
    <Field label="Set category"><select className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="">—</option>{cats.map((c: any) => <option key={c.id}>{c.name}</option>)}</select></Field><Field label="Add tag"><input className="input" value={f.tag} onChange={(e) => setF({ ...f, tag: e.target.value })} /></Field>
    {err && <p role="alert" className="text-sm text-bad mb-2">{err}</p>}<div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!f.value || (!f.category && !f.tag)}>Save rule</button></div></form></Modal>;
}
function DeleteModal({ onClose, onDone }: any) {
  const [pw, setPw] = useState(''); const [c, setC] = useState(''); const [err, setErr] = useState('');
  return <Modal open onClose={onClose} title="Delete your account"><p className="text-sm text-mute mb-3">This permanently deletes your account and all financial data. Export first if you want a copy. This cannot be undone.</p>
    <Field label="Password" error={err}><input type="password" className="input" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" /></Field><Field label="Type DELETE to confirm"><input className="input" value={c} onChange={(e) => setC(e.target.value)} /></Field>
    <div className="flex justify-end gap-2"><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-danger" disabled={c !== 'DELETE' || !pw} onClick={async () => { try { await api('/me/delete', { body: { password: pw, confirm: 'DELETE' } }); onDone(); } catch (x) { setErr((x as ApiFail).message); } }}>Delete everything</button></div></Modal>;
}
