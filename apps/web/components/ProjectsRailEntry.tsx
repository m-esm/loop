'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import type { RoomSummary } from '@loop/types';

export default function ProjectsRailEntry({
  count, counts, rooms, selected, onSelect, onCreate,
}: {
  count: number;
  counts: Map<string, number>;
  rooms: RoomSummary[];
  selected: string;
  onSelect: (id: string) => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [name, setName] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const baseTitle = useRef<string | null>(null);
  useEffect(() => { setHost(document.getElementById('projects-rail')); }, []);
  // The rail is a portal host owned by the server-rendered page, so the count
  // lives on the host element rather than on anything this component returns.
  useEffect(() => {
    if (!host) return;
    host.setAttribute('data-needs-human', String(count));
  }, [host, count]);
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
      setExpanded(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Room could not be created.');
    } finally {
      setBusy(false);
    }
  }
  if (!host) return null;
  const roomLabel = (name: string, value: number) => (value === 1
    ? `${name}: 1 task needs a human`
    : `${name}: ${value} tasks need a human`);
  return createPortal(
    <>
      {rooms.map((room) => {
        // Per room, not per selection. Home selects nothing, and a badge gated
        // on the selection is invisible exactly when the rail is the only
        // place that can tell you which room is waiting.
        const waiting = counts.get(room.id) ?? 0;
        return (
          <button
            key={room.id}
            type="button"
            data-room={room.id}
            aria-current={room.id === selected ? 'page' : undefined}
            onClick={() => onSelect(room.id)}
          >
            {room.name}
            {waiting > 0
              ? <span className="needs-human-pill" data-room-badge={room.id} aria-label={roomLabel(room.name, waiting)}>{waiting}</span>
              : null}
          </button>
        );
      })}
      <button type="button" className="rail-create" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Cancel' : 'New project'}</button>
      {expanded && <form aria-label="New project" onSubmit={(event) => { void create(event); }}>
        <label htmlFor="new-project-name">Project name</label>
        <input autoFocus id="new-project-name" value={name} onChange={(event) => setName(event.target.value)}
          maxLength={100} required disabled={busy} />
        <button type="submit" disabled={busy}>New project</button>
        {error ? <p role="alert">{error}</p> : null}
      </form>}
    </>,
    host,
  );
}
