import { isActiveStatus, relativeAgo, type RoomSummary, type Task } from '@loop/types';
import { needsHumanCount } from '../lib/feed';

/**
 * UI.md section 7: "Recent activity per room, one line each". Home already
 * holds every room's tasks client side, so this reads the same list the
 * "Needs you" queue reads and never fetches.
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
  // Newest touched room first; a room nobody has used yet sorts last on ''.
  const rows = rooms.map((room) => {
    const owned = tasks.filter((task) => task.roomId === room.id);
    return {
      room,
      total: owned.length,
      active: owned.filter((task) => isActiveStatus(task.status)).length,
      waiting: needsHumanCount(owned),
      newest: owned.reduce((latest, task) => task.updatedAt > latest ? task.updatedAt : latest, ''),
    };
  }).sort((a, b) => b.newest.localeCompare(a.newest) || a.room.name.localeCompare(b.room.name));
  return <section aria-label="Room activity" className="inbox room-activity">
    <h2>Room activity</h2>
    <ol className="inbox-list">
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
  </section>;
}
