'use client';

import { useRef, useState, type FormEvent } from 'react';
import { parseComposer } from '@loop/types';
import { api } from '../lib/api';

export default function Composer({ author }: { author: string }) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [error, setError] = useState('');
  async function send(event: FormEvent) {
    event.preventDefault();
    if (sending.current) return;
    const parsed = parseComposer(body);
    if (parsed.kind === 'error') { setError(parsed.message); return; }
    sending.current = true;
    setBusy(true);
    setError('');
    try {
      await api('/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: 'default', body }) });
      setBody('');
    } catch (error) { setError(error instanceof Error ? error.message : 'Message could not be sent.'); }
    finally { sending.current = false; setBusy(false); }
  }
  return <form className="composer" onSubmit={send}>
    <p className="muted wide">Signed in as {author}</p>
    <label className="wide" htmlFor="room-message">Message</label>
    <textarea className="wide" id="room-message" value={body} onChange={(event) => setBody(event.target.value)} rows={3} maxLength={8000} disabled={busy}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }
      }} />
    <p className="muted wide">Enter to send. Shift+Enter for a new line. /task Title :: Done when</p>
    {error && <p className="wide" role="alert">{error}</p>}
    <button type="submit" disabled={busy}>{busy ? 'Sending...' : 'Send'}</button>
  </form>;
}
