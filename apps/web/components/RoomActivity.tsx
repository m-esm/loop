'use client';

import { useState } from 'react';
import { isRunningStatus, relativeAgo, type RoomSummary, type Task } from '@loop/types';
import { needsHumanCount } from '../lib/feed';

/**
 * UI.md section 7: "Recent activity per room, one line each". Home already
 * holds every room's tasks client side, so this reads the same list the
 * "Needs you" queue reads and never fetches.
 */

/**
 * A row count cannot answer "does this list fit". The "Needs you" queue sits
 * above this section and pushes it down, and that queue is as deep as the
 * human's day happens to be, so any constant tuned against one queue depth is
 * coupled to a variable it never reads: six rows ended at y=862 under a four
 * deep queue and at y=1121 under an eight deep one, in the same 900 viewport.
 *
 * So the list bounds its own box instead of counting rows. While it is shut
 * the section takes the space the queue leaves (`flex: 1 1 auto`) and the list
 * scrolls inside it, which puts the list bottom and the toggle inside the
 * viewport at every queue depth and every viewport height, with no constant to
 * tune. Opening it gives the list its natural height and lets Home scroll,
 * which is the opt in the reviewer approved.
 */

function summarise(total: number, active: number, waiting: number): string {
  if (total === 0) return 'No activity yet';
  const parts: string[] = [];
  if (active > 0) parts.push(active === 1 ? '1 task running' : `${active} tasks running`);
  if (waiting > 0) parts.push(waiting === 1 ? '1 task needs a human' : `${waiting} tasks need a human`);
  if (parts.length === 0) return 'No tasks running';
  return parts.join(' \u00b7 ');
}

export default function RoomActivity({ tasks, rooms, onOpenRoom }: {
  tasks: Task[];
  rooms: RoomSummary[];
  onOpenRoom: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const listId = 'room-activity-list';
  // Newest touched room first; a room nobody has used yet sorts last on ''.
  const rows = rooms.map((room) => {
    const owned = tasks.filter((task) => task.roomId === room.id);
    return {
      room,
      total: owned.length,
      active: owned.filter((task) => isRunningStatus(task.status)).length,
      waiting: needsHumanCount(owned),
      newest: owned.reduce((latest, task) => task.updatedAt > latest ? task.updatedAt : latest, ''),
    };
  }).sort((a, b) => b.newest.localeCompare(a.newest) || a.room.name.localeCompare(b.room.name));
  // Every room renders in both states. Shut, the list is a scrolling box; open,
  // it runs to its natural height. Nothing is held back either way, so the
  // label counts rooms rather than a hidden remainder it would have to measure.
  return <section aria-label="Room activity" className="inbox room-activity" data-expanded={open}>
    <h2>Room activity</h2>
    <ol id={listId} className="inbox-list">
      {rows.map((row) => <li key={row.room.id}>
        {/* The rail owns data-room. This list is a second surface for the same
            rooms, so it carries its own attribute and a rail query stays exact. */}
        <button type="button" className="inbox-row room-activity-row" data-activity-room={row.room.id}
          onClick={() => onOpenRoom(row.room.id)}>
          <strong className="inbox-title room-activity-name">{row.room.name}</strong>
          {row.newest
            ? <time className="inbox-time" dateTime={row.newest} title={row.newest}>{relativeAgo(row.newest)}</time>
            : null}
          <span className="inbox-sub">
            <span className="room-activity-summary">{summarise(row.total, row.active, row.waiting)}</span>
          </span>
        </button>
      </li>)}
    </ol>
    {/* The escape hatch out of the shut list's scrolling box. Its label reads
        straight off the room count, so it stays honest without measuring
        anything. Same disclosure idiom as the Steering toggle. */}
    {rows.length > 1 && <button type="button" className="room-activity-toggle"
      aria-expanded={open} aria-controls={listId}
      onClick={() => { setOpen((value) => !value); }}>
      {open ? 'Show fewer rooms' : `Show all ${rows.length} rooms`}
    </button>}
  </section>;
}
