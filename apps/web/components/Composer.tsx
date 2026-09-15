'use client';

import { useRef, useState, type FormEvent } from 'react';
import { parseComposer, type RoomSummary } from '@loop/types';
import { api } from '../lib/api';
import RoomSteering from './RoomSteering';

export default function Composer({
  roomId, parentId = null, fieldId = 'room-message', label = 'Message', onRoom,
}: {
  author: string; roomId: string; parentId?: string | null; fieldId?: string; label?: string;
  onRoom?: (room: RoomSummary) => void;
}) {
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
        body: JSON.stringify({ roomId, body, ...(parentId ? { parentId } : {}) }) });
      setBody('');
    } catch (error) { setError(error instanceof Error ? error.message : 'Message could not be sent.'); }
    finally { sending.current = false; setBusy(false); }
  }
  return <form className="composer" data-thread-composer={parentId ? '' : undefined} aria-label={parentId ? 'Reply in thread' : undefined} onSubmit={send}>
    <textarea className="wide" id={fieldId} aria-label={label} placeholder={parentId ? 'Reply in thread...' : 'Message the room, or /task...'} value={body} onChange={(event) => setBody(event.target.value)} rows={2} maxLength={8000} disabled={busy}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }
      }} />
    <p className="muted composer-hint"><kbd>Enter</kbd> to send. <kbd>Shift+Enter</kbd> for a new line. <code>/task Title :: Done when</code></p>
    {error && <p className="wide" role="alert">{error}</p>}
    <div className="composer-actions">
      <button type="submit" disabled={busy}>{busy ? 'Sending...' : 'Send'} <kbd aria-hidden="true">↵</kbd></button>
      {!parentId && <RoomSteering key={roomId} roomId={roomId} onRoom={onRoom} />}
    </div>
  </form>;
}
