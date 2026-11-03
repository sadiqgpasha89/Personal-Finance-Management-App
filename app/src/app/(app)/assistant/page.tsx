'use client';
import { Fragment, useEffect, useRef, useState } from 'react';
import { api, ApiFail, useApi } from '@/lib/client';
import { PageHeader } from '@/components/ui';

interface Msg { role: 'user' | 'assistant'; content: string; engine?: string | null; tools?: string[]; note?: string; error?: boolean }
const SUGGEST = ['How much did I spend on eating out last month?', 'What subscriptions am I paying for?', 'Show my 5 biggest purchases this month', 'How is my credit card utilization?', 'How much did I send through UPI this month?', 'What is my credit score?'];
const LABEL: Record<string, string> = { search_transactions: 'transactions', spending_summary: 'spending', list_subscriptions: 'subscriptions', upcoming_bills: 'bills', account_balances: 'accounts', budget_status: 'budgets', safe_to_spend: 'safe to spend', goals: 'goals', goal_schedules: 'auto-saves', debts: 'debts', financial_health: 'health', monthly_trend: 'trend', offers_for_me: 'offers', cards_overview: 'cards', upi_summary: 'UPI', credit_report: 'credit report', linked_banks: 'linked banks' };

/** Minimal, safe renderer: **bold** and "- " bullets only. React escapes everything else. */
function Rich({ text }: { text: string }) {
  const inline = (s: string) => s.split(/(\*\*[^*]+\*\*)/g).map((p, i) => (p.startsWith('**') && p.endsWith('**') ? <strong key={i}>{p.slice(2, -2)}</strong> : <Fragment key={i}>{p}</Fragment>));
  const blocks: React.ReactNode[] = []; let list: string[] = [];
  const flush = () => { if (list.length) blocks.push(<ul key={blocks.length} className="list-disc pl-5 my-1">{list.map((l, i) => <li key={i}>{inline(l)}</li>)}</ul>); list = []; };
  for (const line of text.split('\n')) { const m = /^\s*[-•*]\s+(.*)$/.exec(line); if (m) list.push(m[1]); else { flush(); if (line.trim()) blocks.push(<p key={blocks.length} className="my-1">{inline(line)}</p>); } }
  flush(); return <>{blocks}</>;
}
export default function Assistant() {
  const status = useApi<any>('/chat/status'); const convs = useApi<{ items: any[] }>('/chat/conversations');
  const [active, setActive] = useState<string | null>(null); const [msgs, setMsgs] = useState<Msg[]>([]); const [text, setText] = useState(''); const [busy, setBusy] = useState(false); const [showList, setShowList] = useState(false); const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs, busy]);
  const open = async (id: string) => { try { const r = await api<any>(`/chat/conversations/${id}`); setActive(id); setShowList(false); setMsgs(r.messages.map((m: any) => ({ role: m.role, content: m.content, engine: m.engine, tools: m.tools }))); } catch { convs.reload(); } };
  const fresh = () => { setActive(null); setMsgs([]); setShowList(false); };
  const send = async (q: string) => {
    q = q.trim(); if (!q || busy) return; setMsgs((m) => [...m, { role: 'user', content: q }]); setText(''); setBusy(true);
    try { const r = await api<any>('/chat', { body: { message: q, conversation_id: active } }); setMsgs((m) => [...m, { role: 'assistant', content: r.reply, engine: r.engine, tools: [...new Set<string>(r.tools_used)], note: r.note }]); if (r.conversation_id) { setActive(r.conversation_id); convs.reload(); } }
    catch (e) { setMsgs((m) => [...m, { role: 'assistant', content: (e as ApiFail).message || 'Something went wrong.', error: true }]); } finally { setBusy(false); }
  };
  const s = status.data; const items = convs.data?.items ?? [];
  return <>
    <PageHeader title="Assistant" sub="Ask about your transactions, subscriptions, cards, UPI, credit score and more in plain language." actions={<div className="flex gap-2"><button className="btn md:hidden" onClick={() => setShowList(!showList)} aria-expanded={showList}>History</button><button className="btn" onClick={fresh}>New chat</button></div>} />
    {s && <div className="card mb-3 text-sm" role="status">{s.engine === 'llama-local' ? <>🔒 Running <strong>Llama 3.2 1B</strong> on this server. Your questions, data and chat history never leave it.</> : <>⚪ Using built-in rules. {s.note}</>}</div>}
    <div className="grid md:grid-cols-[14rem_1fr] gap-4">
      <aside className={`card !p-2 max-h-[60vh] overflow-auto ${showList ? '' : 'hidden'} md:block`} aria-label="Chat history">
        <p className="text-xs text-mute px-2 py-1">Saved on this server</p>
        {!items.length && <p className="text-xs text-mute px-2 py-1">No saved chats yet.</p>}
        {items.map((c) => <div key={c.id} className={`group flex items-center rounded-lg ${active === c.id ? 'bg-brand/10' : 'hover:bg-line/50'}`}><button className="flex-1 text-left text-sm px-2 py-2 truncate" onClick={() => open(c.id)} title={c.title}>{c.title}</button>
          <button className="px-2 text-mute hover:text-bad opacity-60 group-hover:opacity-100" aria-label={`Delete chat ${c.title}`} onClick={async () => { await api(`/chat/conversations/${c.id}`, { method: 'DELETE' }); if (active === c.id) fresh(); convs.reload(); }}>✕</button></div>)}
        {items.length > 1 && <button className="text-xs underline text-mute px-2 py-2" onClick={async () => { if (confirm('Delete all saved chats?')) { await api('/chat/conversations', { method: 'DELETE' }); fresh(); convs.reload(); } }}>Delete all chats</button>}</aside>
      <div className="card min-h-[50vh] flex flex-col">
        <div className="flex-1 space-y-3" aria-live="polite" aria-relevant="additions">
          {!msgs.length && <div><p className="text-sm text-mute mb-3">Try one of these, or ask your own:</p><div className="flex flex-wrap gap-2">{SUGGEST.map((q) => <button key={q} className="btn text-left h-auto py-2" onClick={() => send(q)}>{q}</button>)}</div></div>}
          {msgs.map((m, i) => <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : ''}`}>
            <div className={`max-w-[88%] rounded-2xl px-4 py-2.5 text-sm ${m.role === 'user' ? 'bg-brand text-white' : m.error ? 'border border-bad/40 text-bad' : 'bg-line/40'}`}>
              {m.role === 'user' ? m.content : <Rich text={m.content} />}
              {m.role === 'assistant' && !m.error && <p className="mt-1.5 text-[11px] text-mute">{m.engine && m.engine !== 'rules' ? (m.engine.startsWith('llama') ? 'Llama 3.2 1B (on device)' : m.engine === 'ledgerly-local' ? 'Built-in rules' : m.engine) : 'Built-in rules'}{!!m.tools?.length && ` · looked at ${m.tools.map((t) => LABEL[t] ?? t).join(', ')}`}{m.note && ` · ${m.note}`}</p>}</div></div>)}
          {busy && <div className="text-sm text-mute" aria-busy="true">Thinking… (the on-device model takes a few seconds)</div>}
          <div ref={end} /></div>
        <form className="mt-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); send(text); }}>
          <label htmlFor="chat-in" className="sr-only">Ask a question about your finances</label>
          <input id="chat-in" className="input" value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} placeholder="e.g. How much did I spend at Swiggy in October?" autoComplete="off" />
          <button className="btn btn-primary" disabled={busy || !text.trim()}>Send</button></form></div></div>
    <p className="text-xs text-mute mt-2">Read-only: the assistant cannot change anything. It gives general information, not financial advice, and a small model can misread a question, so check important figures on the relevant page.</p></>;
}
