'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import type { RoomSummary } from '@loop/types';

export default function ProjectsRailEntry({
  count, rooms, selected, onSelect, onCreate,
}: {
  count: number;
  rooms: RoomSummary[];
  selected: string;
  onSelect: (id: string) => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const baseTitle = useRef<string | null>(null);
  useEffect(() => { setHost(document.getElementById('projects-rail')); }, []);
  useEffect(() => {
    if (baseTitle.current == null) {
      baseTitle.current = document.title.replace(/^\(\d+\) /, '') || 'Loop | Tasks';
    }
    const base = baseTitle.current;
    document.title = count > 0 ? `(${count}) ${base}` : base;
  }, [count]);
  useEffect(() => () => {
    if (baseTitle.current) document.title = baseTitle.current;
  }, []);
  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onCreate(name);
      setName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Room could not be created.');
    } finally {
      setBusy(false);
    }
  }
  if (!host) return null;
  const label = count === 1 ? '1 task needs a human' : `${count} tasks need a human`;
  return createPortal(
    <>
      {rooms.map((room) => (
        <button
          key={room.id}
          type="button"
          data-room={room.id}
          aria-current={room.id === selected ? 'page' : undefined}
          onClick={() => onSelect(room.id)}
        >
          {room.name}
          {room.id === selected && count > 0
            ? <span className="needs-human-pill" aria-label={label}>{count}</span>
            : null}
        </button>
      ))}
      <form aria-label="New project" onSubmit={(event) => { void create(event); }}>
        <label htmlFor="new-project-name">Project name</label>
        <input id="new-project-name" value={name} onChange={(event) => setName(event.target.value)}
          maxLength={100} required disabled={busy} />
        <button type="submit" disabled={busy}>New project</button>
        {error ? <p role="alert">{error}</p> : null}
      </form>
    </>,
    host,
  );
}
