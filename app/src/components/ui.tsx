'use client';
import { ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useSession } from '@/lib/client';

export function Money({ v, cur, sign, className = '', colored }: { v: number; cur?: string; sign?: boolean; className?: string; colored?: boolean }) {
  const { fmt } = useSession();
  return <span className={`num ${colored ? (v < 0 ? 'text-bad' : v > 0 ? 'text-good' : '') : ''} ${className}`}>{fmt(v, cur, { sign })}</span>;
}
export function PageHeader({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return <div className="flex flex-wrap items-end justify-between gap-3 mb-5"><div><h1 className="text-2xl font-semibold tracking-tight">{title}</h1>{sub && <p className="text-sm text-mute mt-0.5">{sub}</p>}</div><div className="flex gap-2 flex-wrap">{actions}</div></div>;
}
export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null); const tid = useId();
  useEffect(() => {
    if (!open) return; const prev = document.activeElement as HTMLElement | null;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); if (e.key === 'Tab' && ref.current) { const f = ref.current.querySelectorAll<HTMLElement>('a,button,input,select,textarea,[tabindex]:not([tabindex="-1"])'); if (!f.length) return; const first = f[0], last = f[f.length - 1]; if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } } };
    document.addEventListener('keydown', k); setTimeout(() => ref.current?.querySelector<HTMLElement>('input,select,textarea,button')?.focus(), 30);
    return () => { document.removeEventListener('keydown', k); prev?.focus(); };
  }, [open, onClose]);
  if (!open) return null;
  return <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={tid} className={`bg-card border border-line rounded-t-2xl sm:rounded-2xl w-full ${wide ? 'sm:max-w-2xl' : 'sm:max-w-md'} max-h-[92vh] overflow-auto p-5`}>
      <div className="flex items-center justify-between mb-4"><h2 id={tid} className="text-lg font-semibold">{title}</h2><button className="btn !px-2 !py-1 min-h-0" onClick={onClose} aria-label="Close">✕</button></div>{children}</div></div>;
}
export function Field({ label, error, children, hint }: { label: string; error?: string; children: ReactNode; hint?: string }) {
  return <label className="block mb-3"><span className="label">{label}</span>{children}{hint && !error && <span className="block text-xs text-mute mt-1">{hint}</span>}{error && <span role="alert" className="block text-xs text-bad mt-1">{error}</span>}</label>;
}
export function Progress({ pct, warn = 0.8 }: { pct: number; warn?: number }) {
  const c = pct >= 1 ? 'bg-bad' : pct >= warn ? 'bg-warn' : 'bg-brand';
  return <div className="h-2 rounded-full bg-line overflow-hidden" role="progressbar" aria-valuenow={Math.round(Math.min(pct, 1) * 100)} aria-valuemin={0} aria-valuemax={100}><div className={`h-full ${c}`} style={{ width: `${Math.min(100, pct * 100)}%` }} /></div>;
}
export function Empty({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return <div className="card text-center py-10"><p className="font-medium">{title}</p><p className="text-sm text-mute mt-1 mb-4 max-w-md mx-auto">{body}</p>{action}</div>;
}
export function Loading() { return <div className="card animate-pulse h-32" aria-busy="true" aria-label="Loading" />; }
export function ErrorBox({ msg, retry }: { msg: string; retry?: () => void }) { return <div role="alert" className="card border-bad/40 text-sm">{msg} {retry && <button className="underline ml-2" onClick={retry}>Retry</button>}</div>; }
/** Auto-hides after 10 s. Hovering or focusing it pauses the timer so it can be read (WCAG 2.2.1). */
export const NOTICE_MS = 10_000;
export function Toast({ msg, onUndo, onDone }: { msg: string; onUndo?: () => void; onDone: () => void }) {
  const [paused, setPaused] = useState(false); const done = useRef(onDone); done.current = onDone;
  useEffect(() => { if (paused) return; const t = setTimeout(() => done.current(), NOTICE_MS); return () => clearTimeout(t); }, [paused]);
  return <div role="status" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)} className="fixed bottom-20 md:bottom-6 left-1/2 -translate-x-1/2 z-[60] bg-ink text-bg rounded-lg px-4 py-2.5 text-sm shadow-lg flex gap-4 items-center">{msg}{onUndo && <button className="font-semibold underline" onClick={onUndo}>Undo</button>}<button aria-label="Dismiss" className="opacity-70 hover:opacity-100" onClick={onDone}>✕</button></div>;
}
/** Pops up newly arrived notifications; each batch hides itself after 10 s (paused on hover/focus). */
export function NotificationPopup({ items, onDone }: { items: { id: number; title: string; body?: string }[]; onDone: () => void }) {
  const [paused, setPaused] = useState(false); const done = useRef(onDone); done.current = onDone;
  useEffect(() => { if (paused) return; const t = setTimeout(() => done.current(), NOTICE_MS); return () => clearTimeout(t); }, [paused]);
  return <div role="status" aria-live="polite" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)} className="fixed top-16 right-3 z-[60] w-[min(22rem,calc(100vw-1.5rem))] card shadow-xl">
    <div className="flex justify-between items-start gap-2"><p className="text-sm font-medium">{items[0].title}</p><button aria-label="Dismiss notification" className="text-mute hover:text-ink" onClick={onDone}>✕</button></div>
    {items[0].body && <p className="text-xs text-mute mt-0.5">{items[0].body}</p>}{items.length > 1 && <p className="text-xs text-mute mt-1">+{items.length - 1} more in the bell menu</p>}</div>;
}
export function useToast() {
  const [t, setT] = useState<{ msg: string; undo?: () => void } | null>(null);
  return { show: (msg: string, undo?: () => void) => setT({ msg, undo }), node: t ? <Toast msg={t.msg} onUndo={t.undo ? () => { t.undo!(); setT(null); } : undefined} onDone={() => setT(null)} /> : null };
}
export const Stat = ({ label, children, sub }: { label: string; children: ReactNode; sub?: ReactNode }) => <div className="card"><p className="text-xs text-mute">{label}</p><p className="text-2xl font-semibold mt-1 num">{children}</p>{sub && <p className="text-xs text-mute mt-1">{sub}</p>}</div>;
export const CHART = ['rgb(var(--brand))', '#4f7fd6', '#d9822b', '#9b59b6', '#c0504d', '#3aa6b9', '#8a9a3b', '#b8860b'];
export const grid = 'rgb(var(--line))', axis = { fontSize: 11, fill: 'rgb(var(--mute))' };
