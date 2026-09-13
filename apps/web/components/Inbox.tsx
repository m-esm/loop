import { isActiveStatus, relativeAgo, type RoomSummary, type Task } from '@loop/types';

export default function Inbox({ tasks, rooms, onSelect }: {
  tasks: Task[];
  rooms: RoomSummary[];
  onSelect: (task: Task) => void;
}) {
  // Match the parked questions/proposals and unreviewed terminal cards in TaskCard.
  const waiting = tasks.filter((task) => task.status === 'needs_input'
    || (!isActiveStatus(task.status) && !task.verdict))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
  return <section aria-label="Inbox" className="inbox">
    <h2>Needs you</h2>
    {waiting.length === 0 ? <p className="muted">Nothing needs you</p> : <ol className="inbox-list">
      {waiting.map((task) => <li key={task.id}>
        <button type="button" className="inbox-row" data-task-id={task.id} onClick={() => onSelect(task)}>
          <span className="inbox-meta">
            <span>{rooms.find((room) => room.id === task.roomId)?.name ?? task.roomId}</span>
            <time dateTime={task.updatedAt} title={task.updatedAt}>{relativeAgo(task.updatedAt)}</time>
          </span>
          <strong>{task.title}</strong>
          <span className="inbox-reason">{task.status === 'needs_input'
            ? task.proposal?.question ?? task.question ?? 'Input needed'
            : 'Result waiting for review'}</span>
        </button>
      </li>)}
    </ol>}
  </section>;
}
