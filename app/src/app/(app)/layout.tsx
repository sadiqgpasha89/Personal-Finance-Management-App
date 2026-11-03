'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, Me, SessionProvider, useApi, formatMoney } from '@/lib/client';
import { NOTICE_MS, NotificationPopup } from '@/components/ui';
import { Logo } from '@/components/Logo';

const NAV = [['/', 'Dashboard', '▦'], ['/transactions', 'Transactions', '⇄'], ['/accounts', 'Accounts', '▣'], ['/cards', 'Cards', '▭'], ['/upi', 'UPI', '₹'], ['/connections', 'Bank links', '⇌'], ['/budgets', 'Budgets', '◔'], ['/bills', 'Bills', '◷'], ['/goals', 'Goals', '◎'], ['/debts', 'Debt', '↘'], ['/networth', 'Net worth', '△'], ['/reports', 'Reports', '▤'], ['/credit', 'Credit score', '◉'], ['/offers', 'Offers', '％'], ['/assistant', 'Assistant', '✦'], ['/profile', 'Profile', '☺'], ['/settings', 'Settings', '⚙']] as const;

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null); const router = useRouter(); const path = usePathname();
  const refresh = useCallback(() => { api<Me>('/me').then((m) => { if (!m.user) router.replace('/login'); else setMe(m); }).catch(() => router.replace('/login')); }, [router]);
  useEffect(refresh, [refresh]);
  const [dark, setDark] = useState(false);
  useEffect(() => setDark(document.documentElement.classList.contains('dark')), []);
  const notes = useApi<{ unread: number; items: any[] }>(me ? '/notifications' : null);
  const [open, setOpen] = useState(false); const [hover, setHover] = useState(false); const [popup, setPopup] = useState<any[] | null>(null);
  // the bell menu closes itself after 10 s; hovering or focusing it pauses the timer
  useEffect(() => { if (!open || hover) return; const t = setTimeout(() => setOpen(false), NOTICE_MS); return () => clearTimeout(t); }, [open, hover]);
  // pop up notifications that arrived since the last look (ids remembered per tab), auto-hidden after 10 s
  useEffect(() => {
    if (!notes.data) return; let seen = 0; try { seen = Number(sessionStorage.getItem('notes-seen') ?? '-1'); } catch {}
    const unread = notes.data.items.filter((n: any) => !n.read_at); const maxId = Math.max(0, ...notes.data.items.map((n: any) => n.id));
    if (seen >= 0) { const fresh = unread.filter((n: any) => n.id > seen); if (fresh.length) setPopup(fresh); }
    try { sessionStorage.setItem('notes-seen', String(maxId)); } catch {}
  }, [notes.data]);
  useEffect(() => { if (!me) return; const t = setInterval(notes.reload, 60_000); return () => clearInterval(t); }, [me, notes.reload]);
  if (!me) return <div className="min-h-screen grid place-items-center text-mute" aria-busy="true">Loading…</div>;
  const base = me.workspace!.base_currency, privacy = me.workspace!.privacy_mode;
  const fmt = (n: number, cur?: string, o?: { sign?: boolean }) => formatMoney(n, cur ?? base, { mask: privacy, sign: o?.sign });
  const toggleTheme = () => { const d = !dark; setDark(d); document.documentElement.classList.toggle('dark', d); try { localStorage.setItem('theme', d ? 'dark' : 'light'); } catch {} };
  const togglePrivacy = async () => { await api('/settings', { method: 'PATCH', body: { privacy_mode: !privacy } }); refresh(); };
  const active = (h: string) => (h === '/' ? path === '/' : path.startsWith(h));
  return (
    <SessionProvider value={{ me, base, privacy, fmt, refresh }}>
      {popup && !open && <NotificationPopup items={popup} onDone={() => setPopup(null)} />}
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-card focus:p-3">Skip to content</a>
      <div className="min-h-screen md:flex">
        <aside className="hidden md:flex w-56 shrink-0 flex-col border-r border-line bg-card p-3 sticky top-0 h-screen" aria-label="Main">
          <Link href="/" className="px-3 py-2 mb-2 flex items-center gap-2.5 text-lg font-semibold tracking-tight text-brand" aria-label="Ledgerly home"><Logo size={30} />Ledgerly</Link>
          <nav className="flex-1 space-y-0.5">{NAV.map(([h, l, i]) => <Link key={h} href={h} aria-current={active(h) ? 'page' : undefined} className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm ${active(h) ? 'bg-brand/10 text-brand font-medium' : 'text-mute hover:bg-line/50 hover:text-ink'}`}><span aria-hidden className="w-4 text-center">{i}</span>{l}</Link>)}</nav>
          <Link href="/profile" className="text-xs text-mute px-3 pb-1 truncate hover:text-ink" title="Your profile">{me.user!.name} · {me.user!.email}</Link>
        </aside>
        <div className="flex-1 min-w-0">
          <header className="sticky top-0 z-30 bg-bg/90 backdrop-blur border-b border-line px-4 py-2 flex items-center justify-between gap-2">
            <Link href="/" className="md:hidden flex items-center gap-2 font-semibold text-brand" aria-label="Ledgerly home"><Logo size={26} />Ledgerly</Link><span className="hidden md:block" />
            <div className="flex items-center gap-1.5">
              <button className="btn" onClick={togglePrivacy} aria-pressed={privacy} title="Mask balances">{privacy ? '🙈 Hidden' : '👁 Privacy'}</button>
              <button className="btn" onClick={toggleTheme} aria-label="Toggle dark mode">{dark ? '☀' : '☾'}</button>
              <div className="relative" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onFocus={() => setHover(true)} onBlur={() => setHover(false)}>
                <button className="btn" onClick={() => { setOpen(!open); setPopup(null); if (!open) api('/notifications/read', { method: 'POST', body: {} }).then(() => setTimeout(notes.reload, 1500)); }} aria-expanded={open} aria-label={`Notifications, ${notes.data?.unread ?? 0} unread`}>🔔{!!notes.data?.unread && <span className="ml-1 text-xs bg-bad text-white rounded-full px-1.5">{notes.data.unread}</span>}</button>
                {open && <div className="absolute right-0 mt-2 w-80 max-h-96 overflow-auto card shadow-xl z-40">{notes.data?.items.length ? notes.data.items.slice(0, 15).map((n) => <div key={n.id} className="py-2 border-b border-line last:border-0 text-sm"><p className="font-medium">{n.title}</p><p className="text-xs text-mute">{n.body}</p></div>) : <p className="text-sm text-mute">You're all caught up.</p>}</div>}
              </div>
            </div>
          </header>
          <main id="main" className="p-4 md:p-6 max-w-6xl mx-auto pb-24 md:pb-8">{children}</main>
        </div>
      </div>
      <nav className="md:hidden fixed bottom-0 inset-x-0 bg-card border-t border-line flex overflow-x-auto z-30" aria-label="Main mobile">
        {NAV.map(([h, l, i]) => <Link key={h} href={h} aria-current={active(h) ? 'page' : undefined} className={`flex-1 min-w-[72px] py-2 text-center text-[11px] ${active(h) ? 'text-brand font-medium' : 'text-mute'}`}><div aria-hidden className="text-base">{i}</div>{l}</Link>)}
      </nav>
    </SessionProvider>
  );
}
