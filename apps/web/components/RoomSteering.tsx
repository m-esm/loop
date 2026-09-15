'use client';

import { useEffect, useRef, useState } from 'react';
import type { RoomSummary } from '@loop/types';
import { api } from '../lib/api';

export default function RoomSteering({ roomId, onRoom }: { roomId: string; onRoom?: (room: RoomSummary) => void }) {
  const [room, setRoom] = useState<RoomSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const onRoomRef = useRef(onRoom);
  useEffect(() => { onRoomRef.current = onRoom; }, [onRoom]);
  const saving = useRef(false);
  const revision = useRef(0);
  const path = `/rooms/${encodeURIComponent(roomId)}`;
  const panelId = 'room-steering-panel';

  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => {
      if (saving.current) return;
      const version = ++revision.current;
      try {
        const value = await api<RoomSummary>(path, { signal: controller.signal });
        if (!controller.signal.aborted && version === revision.current) { setRoom(value); onRoomRef.current?.(value); }
      } catch (error) {
        if (!controller.signal.aborted && version === revision.current) {
          setError(error instanceof Error ? error.message : 'Room controls could not be loaded.');
        }
      }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 2000);
    window.addEventListener('focus', refresh);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [path]);

  async function steer(change: { paused?: boolean; wrapUp?: boolean; verbosity?: RoomSummary['verbosity'] }) {
    if (saving.current) return;
    saving.current = true;
    ++revision.current;
    setBusy(true);
    setError('');
    try {
      const next = await api<RoomSummary>(`${path}/steer`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change),
      });
      setRoom(next);
      onRoomRef.current?.(next);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Room controls could not be saved.');
    } finally { saving.current = false; setBusy(false); }
  }

  const status = `${room?.paused ? 'Paused. ' : ''}${room?.wrapUp ? 'Wrap up queued.' : ''}`;
  return <div className="room-steering" role="group" aria-label="Room steering">
    <button type="button" className="room-steering-toggle" aria-label={`Steering${status ? `. ${status.trim()}` : ''}`} aria-expanded={open} aria-controls={panelId}
      title={status || 'Pause, wrap up, and verbosity'}
      onClick={() => { setOpen((value) => !value); }}>
      Steering{room?.paused ? ' · Paused' : ''}{room?.wrapUp ? ' · Wrap up queued' : ''}
    </button>
    <div id={panelId} className="room-steering-panel" hidden={!open}>
      <button type="button" disabled={!room || room.role !== 'owner' || busy}
        title={room?.role === 'member' ? 'Only room owners can steer' : 'Pause new agent turns; running turns can finish'}
        onClick={() => { void steer({ paused: !room?.paused }); }}>
        {room?.paused ? 'Resume' : 'Pause'}
      </button>
      <button type="button" disabled={!room || room.role !== 'owner' || busy || room.wrapUp}
        title="Ask the next agent turn to converge on a result"
        onClick={() => { void steer({ wrapUp: true }); }}>Wrap up</button>
      <div className="verbosity-dial" role="group" aria-label="Verbosity">
        {(['quiet', 'normal', 'verbose'] as const).map((verbosity) => <button key={verbosity}
          type="button" aria-pressed={room?.verbosity === verbosity}
          disabled={!room || room.role !== 'owner' || busy}
          title={room?.role === 'member' ? 'Only room owners can steer' : `${verbosity} task progress`}
          onClick={() => { void steer({ verbosity }); }}>
          {verbosity[0].toUpperCase() + verbosity.slice(1)}
        </button>)}
      </div>
    </div>
    <span className="muted" role="status">{status}</span>
    {error && <span role="alert">{error}</span>}
  </div>;
}
