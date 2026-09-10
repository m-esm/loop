'use client';

import { useState, type FormEvent } from 'react';
import { api, ApiError, type Me } from '../lib/api';

export default function LoginForm({ onAuthed }: { onAuthed: (me: Me) => void }) {
  const [loginError, setLoginError] = useState('');
  const [registerError, setRegisterError] = useState('');
  const [busy, setBusy] = useState<'login' | 'register' | ''>('');

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
      const me = await api<Me>('/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: data.get('displayName'), email: data.get('email'), password: data.get('password'),
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
    <h2>Sign in to Loop</h2>
    <p className="muted">Identity is a session cookie. The author box is gone; attribution comes from who signed in.</p>
    <form aria-label="Sign in" onSubmit={signIn}>
      <label>Email<input name="email" type="email" autoComplete="username" required maxLength={254} disabled={!!busy} /></label>
      <label>Password<input name="password" type="password" autoComplete="current-password" required minLength={8} maxLength={200} disabled={!!busy} /></label>
      {loginError && <p className="wide" role="alert">{loginError}</p>}
      <button type="submit" disabled={!!busy}>{busy === 'login' ? 'Signing in...' : 'Sign in'}</button>
    </form>
    <h2>Create an account</h2>
    <p className="muted">The first operator registers on an empty database. After that, registration closes.</p>
    <form aria-label="Create account" onSubmit={register}>
      <label>Display name<input name="displayName" required maxLength={100} disabled={!!busy} /></label>
      <label>Email<input name="email" type="email" autoComplete="username" required maxLength={254} disabled={!!busy} /></label>
      <label>Password<input name="password" type="password" autoComplete="new-password" required minLength={8} maxLength={200} disabled={!!busy} /></label>
      {registerError && <p className="wide" role="alert">{registerError}</p>}
      <button type="submit" disabled={!!busy}>{busy === 'register' ? 'Creating...' : 'Create account'}</button>
    </form>
  </section>;
}
