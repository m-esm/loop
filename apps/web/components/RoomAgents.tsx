'use client';

import { useEffect, useState, type FormEvent } from 'react';
import type { RoomAgent, RoomAgentsSnapshot } from '@loop/types';
import { api } from '../lib/api';

export function AgentProfile({
  agent, room, role, onUpdated,
}: {
  agent: RoomAgent;
  room: string;
  role: 'owner' | 'member';
  onUpdated: (agent: RoomAgent) => void;
}) {
  const [draft, setDraft] = useState(agent.mandate);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setDraft(agent.mandate); }, [agent.id, agent.mandate]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const updated = await api<RoomAgent>(`/rooms/${room}/agents/${agent.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mandate: draft }),
      });
      setDraft(updated.mandate);
      onUpdated(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Mandate could not be saved.');
    } finally { setBusy(false); }
  }
  const owner = role === 'owner';
  return (
    <section className="task-detail" aria-label="Agent profile">
      <p>@{agent.name}</p>
      <p className="muted">{agent.catalogId}</p>
      {owner
        ? <form aria-label="Edit mandate" onSubmit={(event) => { void save(event); }}>
          <label className="wide">Mandate
            <textarea
              name="mandate"
              maxLength={2000}
              value={draft}
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          <button type="submit" disabled={busy}>{busy ? 'Saving...' : 'Save'}</button>
        </form>
        : <p>{agent.mandate}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

export default function RoomAgents({
  room, onSelectAgent,
}: {
  room: string;
  onSelectAgent: (agent: RoomAgent) => void;
}) {
  const [snapshot, setSnapshot] = useState<RoomAgentsSnapshot | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    api<RoomAgentsSnapshot>(`/rooms/${room}/agents`, { signal: controller.signal })
      .then((value) => { setSnapshot(value); setError(''); })
      .catch((err: Error) => { if (!controller.signal.aborted) setError(err.message); });
    return () => controller.abort();
  }, [room]);
  async function refresh() {
    const value = await api<RoomAgentsSnapshot>(`/rooms/${room}/agents`);
    setSnapshot(value);
    setError('');
  }
  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError('');
    try {
      await api<RoomAgent>(`/rooms/${room}/agents`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ catalogId: data.get('catalogId'), name: data.get('name') }),
      });
      form.reset();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Agent could not be added.');
    } finally { setBusy(false); }
  }
  async function remove(id: string) {
    setBusy(true);
    setError('');
    try {
      await api(`/rooms/${room}/agents/${id}`, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Agent could not be removed.');
    } finally { setBusy(false); }
  }
  if (!snapshot) {
    if (!error) return null;
    return <p role="alert">{error}</p>;
  }
  const owner = snapshot.role === 'owner';
  return (
    <section aria-label="Room agents" className="room-agents">
      <h2>Agents</h2>
      {snapshot.agents.length === 0
        ? <p className="muted">No agents in this room.</p>
        : <ul>{snapshot.agents.map((agent) => <li key={agent.id}>
          <button type="button" className="task-title" onClick={() => onSelectAgent(agent)}>@{agent.name}</button>
          <span className="muted">{agent.catalogId}</span>
          {owner
            ? <button type="button" disabled={busy} onClick={() => { void remove(agent.id); }}>Remove</button>
            : null}
        </li>)}</ul>}
      {owner && <form aria-label="Add agent" onSubmit={(event) => { void add(event); }}>
        <label>Catalog
          <select name="catalogId" required disabled={busy}>
            {snapshot.catalog.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label>Name
          <input name="name" required maxLength={100} pattern="[A-Za-z0-9_-]+" disabled={busy} />
        </label>
        <button type="submit" disabled={busy}>{busy ? 'Saving...' : 'Add'}</button>
      </form>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
