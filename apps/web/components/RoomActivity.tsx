'use client';

import { useEffect, useRef, useState } from 'react';
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
 * scrolls inside it. What that buys is narrower than it first looked: the list
 * bottom stops depending on queue depth as long as the queue itself fits on
 * the page, with no constant to tune. It is not a promise about every queue
 * depth. The "Needs you" queue above is unbounded, so once the queue overflows
 * the page it carries this section off with it: at sixteen parked tasks the
 * whole section sits below the fold (list y=1254.9, toggle bottom 1286.9) at
 * 1440x900, 900x800 and 1440x700 alike. Bounding that queue is the agreed
 * follow up slice, and it is the only thing that can fix that case. Opening
 * the list gives it its natural height and lets Home scroll, which is the opt
 * in the reviewer approved.
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
  const listRef = useRef<HTMLOListElement | null>(null);
  // False until the list has been measured, so the first paint renders no
  // toggle and nothing flashes in and back out again.
  const [overflows, setOverflows] = useState(false);
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
  //
  // Whether there is anything to reveal is a fact about the rendered box, not
  // about the row count, so it is measured rather than guessed: a list that
  // already fits shows every room it names and a toggle over it would promise
  // rooms it is displaying already. The measurement has to be taken against the
  // shut state. Open, the section is `flex: 0 0 auto` and the list runs to its
  // natural height, so it never scrolls and `scrollHeight > clientHeight` reads
  // false; gating on the live reading would delete the control while the human
  // is inside it and strand them in the expanded state with no way back. So the
  // effect declines to re-measure while open, holding the last shut reading,
  // and the render keeps the control whenever the list is open.
  const shape = rows.map((row) => `${row.room.id}:${row.total}:${row.active}:${row.waiting}`).join('|');
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      if (open) return;
      setOverflows(list.scrollHeight > list.clientHeight);
    };
    // Runs after the DOM is in place, so these read the laid out box. The
    // observer covers viewport resize and any queue depth change above that
    // hands this section a different amount of room; `shape` covers room and
    // task data changing under a box that keeps its size.
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => { observer.disconnect(); };
  }, [open, shape]);
  return <section aria-label="Room activity" className="inbox room-activity" data-expanded={open}>
    <h2>Room activity</h2>
    <ol id={listId} ref={listRef} className="inbox-list">
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
    {/* The escape hatch out of the shut list's scrolling box, so it renders
        only when the shut list actually clips something. `open ||` is the way
        back: it keeps the control rendered for as long as the list is open,
        where the overflow condition is false by construction. The label reads
        straight off the room count, and once the list is known to clip, every
        room it names is one the human cannot see all of at once. Same
        disclosure idiom as the Steering toggle. */}
    {(open || overflows) && <button type="button" className="room-activity-toggle"
      aria-expanded={open} aria-controls={listId}
      onClick={() => { setOpen((value) => !value); }}>
      {open ? 'Show fewer rooms' : `Show all ${rows.length} rooms`}
    </button>}
  </section>;
}
