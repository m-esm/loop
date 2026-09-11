'use client';

import { useEffect, useState, type FormEvent } from 'react';
import type { CreatedRoomInvite, RoomInvite, RoomMembersSnapshot } from '@loop/types';
import { api } from '../lib/api';

export default function Team({ room }: { room: string }) {
  const [snapshot, setSnapshot] = useState<RoomMembersSnapshot | null>(null);
  const [invites, setInvites] = useState<RoomInvite[]>([]);
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    api<RoomMembersSnapshot>(`/rooms/${room}/members`, { signal: controller.signal })
      .then(async (value) => {
        setSnapshot(value);
        if (value.role === 'owner') {
          const listed = await api<{ invites: RoomInvite[] }>(`/rooms/${room}/invites`, { signal: controller.signal });
          setInvites(listed.invites);
        } else {
          setInvites([]);
        }
        setError('');
      })
      .catch((err: Error) => { if (!controller.signal.aborted) setError(err.message); });
    return () => controller.abort();
  }, [room]);
  async function refresh() {
    const value = await api<RoomMembersSnapshot>(`/rooms/${room}/members`);
    setSnapshot(value);
    if (value.role === 'owner') {
      const listed = await api<{ invites: RoomInvite[] }>(`/rooms/${room}/invites`);
      setInvites(listed.invites);
    } else {
      setInvites([]);
    }
    setError('');
  }
  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError('');
    setLink('');
    try {
      const created = await api<CreatedRoomInvite>(`/rooms/${room}/invites`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: data.get('email'), role: data.get('role') }),
      });
      form.reset();
      const inviteUrl = new URL('/', window.location.origin);
      inviteUrl.searchParams.set('room', room);
      inviteUrl.searchParams.set('invite', created.token);
      setLink(inviteUrl.toString());
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invite could not be created.');
    } finally { setBusy(false); }
  }
  if (!snapshot) {
    if (!error) return null;
    return <p role="alert">{error}</p>;
  }
  const owner = snapshot.role === 'owner';
  return (
    <section aria-label="Team" className="room-team">
      <h2>Team</h2>
      {snapshot.members.length === 0
        ? <p className="muted">No members in this room.</p>
        : <ul>{snapshot.members.map((member) => <li key={member.principalId}>
          <span>{member.displayName}</span>
          <span className="muted">{member.role}</span>
        </li>)}</ul>}
      {owner && invites.length > 0 && <>
        <h3>Pending invites</h3>
        <ul>{invites.map((row) => <li key={row.id}>
          <span>{row.email}</span>
          <span className="muted">{row.role}</span>
        </li>)}</ul>
      </>}
      {owner && <form aria-label="Invite to room" onSubmit={(event) => { void invite(event); }}>
        <label>Email
          <input name="email" type="email" required maxLength={254} disabled={busy} />
        </label>
        <label>Role
          <select name="role" required disabled={busy} defaultValue="member">
            <option value="member">member</option>
            <option value="owner">owner</option>
          </select>
        </label>
        <button type="submit" disabled={busy}>{busy ? 'Inviting...' : 'Invite'}</button>
      </form>}
      {owner && link && <div className="invite-once">
        <p>Copy this link and send it yourself. Loop does not send email. This link is shown only now.</p>
        <label>Invite link
          <input readOnly value={link} className="invite-link" />
        </label>
      </div>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
