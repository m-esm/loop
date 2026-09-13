'use client';

import { useEffect, useRef, useState } from 'react';
import type { RoomSummary } from '@loop/types';
import { api } from '../lib/api';

export default function RoomSteering({ roomId }: { roomId: string }) {
  const [room, setRoom] = useState<RoomSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const saving = useRef(false);
  const revision = useRef(0);
  const path = `/rooms/${encodeURIComponent(roomId)}`;

  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => {
      if (saving.current) return;
      const version = ++revision.current;
      try {
        const value = await api<RoomSummary>(path, { signal: controller.signal });
        if (!controller.signal.aborted && version === revision.current) setRoom(value);
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

  async function steer(change: { paused?: boolean; wrapUp?: boolean }) {
    if (saving.current) return;
    saving.current = true;
    ++revision.current;
    setBusy(true);
    setError('');
    try {
      setRoom(await api<RoomSummary>(`${path}/steer`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change),
      }));
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Room controls could not be saved.');
    } finally { saving.current = false; setBusy(false); }
  }

  return <div className="room-steering" role="group" aria-label="Room steering">
    <button type="button" disabled={!room || room.role !== 'owner' || busy}
      title={room?.role === 'member' ? 'Only room owners can steer' : 'Pause new agent turns; running turns can finish'}
      onClick={() => { void steer({ paused: !room?.paused }); }}>
      {room?.paused ? 'Resume' : 'Pause'}
    </button>
    <button type="button" disabled={!room || room.role !== 'owner' || busy || room.wrapUp}
      title="Ask the next agent turn to converge on a result"
      onClick={() => { void steer({ wrapUp: true }); }}>Wrap up</button>
    <span className="muted" role="status">{room?.paused ? 'Paused. ' : ''}{room?.wrapUp ? 'Wrap up queued.' : ''}</span>
    {error && <span role="alert">{error}</span>}
  </div>;
}
