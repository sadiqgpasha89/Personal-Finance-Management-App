'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, ApiFail } from '@/lib/client';

export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const r = useRouter(); const [f, setF] = useState({ email: '', name: '', password: '' }); const [err, setErr] = useState<string>(''); const [fields, setFields] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(''); setFields({});
    try { await api(`/auth/${mode}`, { body: mode === 'login' ? { email: f.email, password: f.password } : f }); r.replace('/'); r.refresh(); }
    catch (x) { const a = x as ApiFail; setErr(a.message); setFields(a.fields ?? {}); } finally { setBusy(false); }
  };
  const L = mode === 'login';
  return (
    <main className="min-h-screen grid place-items-center p-4">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-3" noValidate>
        <div><h1 className="text-2xl font-semibold text-brand">Ledgerly</h1><p className="text-sm text-mute">{L ? 'Welcome back. Sign in to see where you stand.' : 'Create your account. Your data stays yours — export or delete anytime.'}</p></div>
        {!L && <div><label className="label" htmlFor="n">Name</label><input id="n" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="name" required />{fields.name && <p className="text-xs text-bad mt-1">{fields.name}</p>}</div>}
        <div><label className="label" htmlFor="e">Email</label><input id="e" type="email" className="input" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="email" required />{fields.email && <p className="text-xs text-bad mt-1">{fields.email}</p>}</div>
        <div><label className="label" htmlFor="p">Password</label><input id="p" type="password" className="input" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete={L ? 'current-password' : 'new-password'} required />{!L && <p className="text-xs text-mute mt-1">At least 10 characters with letters and numbers.</p>}{fields.password && <p className="text-xs text-bad mt-1">{fields.password}</p>}</div>
        {err && !Object.keys(fields).length && <p role="alert" className="text-sm text-bad">{err}</p>}
        <button className="btn btn-primary w-full" disabled={busy}>{busy ? 'Please wait…' : L ? 'Sign in' : 'Create account'}</button>
        <p className="text-sm text-mute text-center">{L ? <>New here? <Link className="text-brand underline" href="/register">Create an account</Link></> : <>Have an account? <Link className="text-brand underline" href="/login">Sign in</Link></>}</p>
      </form>
    </main>
  );
}

