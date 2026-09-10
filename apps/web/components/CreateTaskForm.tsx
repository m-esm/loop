'use client';

import { useState, type FormEvent } from 'react';
import type { Task } from '@loop/types';
import { api } from '../lib/api';

export default function CreateTaskForm() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setError('');
    try {
      await api<Task>('/tasks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(data)),
      });
      form.reset();
    } catch (error) { setError((error as Error).message); }
    finally { setPending(false); }
  }
  return <>
    <form onSubmit={submit} aria-label="Create task">
      <label>Title<input name="title" required maxLength={200} /></label>
      <label className="wide">Definition of done<textarea name="definitionOfDone" required maxLength={8000} rows={2} /></label>
      <button type="submit" disabled={pending}>{pending ? 'Creating...' : 'Create task'}</button>
    </form>
    {error && <p role="alert">{error}</p>}
  </>;
}
