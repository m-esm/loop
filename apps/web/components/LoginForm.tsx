'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type Me } from '../lib/api';

export default function LoginForm({ onAuthed }: { onAuthed: (me: Me) => void }) {
  const [loginError, setLoginError] = useState('');
  const [registerError, setRegisterError] = useState('');
  const [busy, setBusy] = useState<'login' | 'register' | ''>('');
  // An invite link is an instruction to register, so honour it rather than
  // making the invitee find the second form.
  const [mode, setMode] = useState<'signin' | 'register'>(() => (typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).has('invite') ? 'register' : 'signin'));
  // The signed-out page is not the app: hide the empty rail, header and
  // inspector rather than showing a visitor a shell they cannot use.
  useEffect(() => {
    document.body.dataset.signedOut = '1';
    return () => { delete document.body.dataset.signedOut; };
  }, []);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy('login');
    setLoginError('');
    try {
      const me = await api<Me>('/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: data.get('email'), password: data.get('password') }),
      });
      onAuthed(me);
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : 'Sign in failed.');
    } finally { setBusy(''); }
  }

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy('register');
    setRegisterError('');
    try {
      const inviteToken = new URLSearchParams(window.location.search).get('invite');
      const me = await api<Me>('/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: data.get('displayName'), email: data.get('email'), password: data.get('password'),
          ...(inviteToken ? { inviteToken } : {}),
        }),
      });
      onAuthed(me);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Registration failed.';
      setRegisterError(error instanceof ApiError && error.status === 403
        ? 'Registration is closed. Ask the operator for an account.'
        : message);
    } finally { setBusy(''); }
  }

  return <section className="auth-panel" aria-label="Sign in">
    <p className="auth-brand">Loop</p>
    {mode === 'signin' ? <>
      <h2>Sign in</h2>
      <p className="muted">Project rooms for humans and agents.</p>
      <form aria-label="Sign in" onSubmit={signIn}>
        <label>Email<input name="email" type="email" autoComplete="username" required maxLength={254} disabled={!!busy} /></label>
        <label>Password<input name="password" type="password" autoComplete="current-password" required minLength={8} maxLength={200} disabled={!!busy} /></label>
        {loginError && <p className="wide" role="alert">{loginError}</p>}
        <button type="submit" disabled={!!busy}>{busy === 'login' ? 'Signing in...' : 'Sign in'}</button>
      </form>
      <p className="auth-switch">No account yet?{' '}
        <button type="button" className="auth-link" onClick={() => { setMode('register'); setLoginError(''); }}>Create one</button>
      </p>
    </> : <>
      <h2>Create an account</h2>
      <p className="muted">Open to the first operator, then by invite only.</p>
      <form aria-label="Create account" onSubmit={register}>
        <label>Display name<input name="displayName" required maxLength={100} disabled={!!busy} /></label>
        <label>Email<input name="email" type="email" autoComplete="username" required maxLength={254} disabled={!!busy} /></label>
        <label>Password<input name="password" type="password" autoComplete="new-password" required minLength={8} maxLength={200} disabled={!!busy} /></label>
        {registerError && <p className="wide" role="alert">{registerError}</p>}
        <button type="submit" disabled={!!busy}>{busy === 'register' ? 'Creating...' : 'Create account'}</button>
      </form>
      <p className="auth-switch">Already have an account?{' '}
        <button type="button" className="auth-link" onClick={() => { setMode('signin'); setRegisterError(''); }}>Sign in</button>
      </p>
    </>}
  </section>;
}
