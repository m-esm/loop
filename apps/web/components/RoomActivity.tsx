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
 * Rows the list keeps while it is shut. Measured on Home at 1440x900 with a
 * four deep "Needs you" queue, the tallest queue that still leaves the
 * activity list a usable share of the page: the list starts at y=476 and each
 * row occupies 64.89px, so row six ends at y=862 and row seven would end at
 * y=926, past the 900 viewport. Six rows plus the toggle are the most that
 * stay on screen, so an uncapped ninth row ending at y=1056 is the bug this
 * number fixes.
 */
const COLLAPSED_ROWS = 6;

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
  // The cap trims the tail of that sorted list, so a shut list can only ever
  // hold back rooms older than every row it shows.
  const hidden = Math.max(0, rows.length - COLLAPSED_ROWS);
  const shown = open || hidden === 0 ? rows : rows.slice(0, COLLAPSED_ROWS);
  return <section aria-label="Room activity" className="inbox room-activity">
    <h2>Room activity</h2>
    <ol id={listId} className="inbox-list">
      {shown.map((row) => <li key={row.room.id}>
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
    {/* A shut list names what it is holding back, so the cap never reads as
        the whole story. Same disclosure idiom as the Steering toggle. */}
    {hidden > 0 && <button type="button" className="room-activity-toggle"
      aria-expanded={open} aria-controls={listId}
      onClick={() => { setOpen((value) => !value); }}>
      {open ? 'Show fewer rooms' : `Show ${hidden} more ${hidden === 1 ? 'room' : 'rooms'}`}
    </button>}
  </section>;
}
