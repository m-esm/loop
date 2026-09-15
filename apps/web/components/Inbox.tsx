import { isFailureStatus, relativeAgo, type RoomSummary, type Task } from '@loop/types';
import { needsHumanTasks } from '../lib/feed';
import RoomActivity from './RoomActivity';

export default function Inbox({ tasks, rooms, onSelect, onOpenRoom }: {
  tasks: Task[];
  rooms: RoomSummary[];
  onSelect: (task: Task) => void;
  onOpenRoom: (id: string) => void;
}) {
  const waiting = needsHumanTasks(tasks)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
  // Two different empty states. An account that has never produced a task needs
  // telling what the Inbox is for; an emptied queue is a human who cleared their
  // work and wants to know that, not an onboarding pitch.
  const firstRun = tasks.length === 0;
  return <>
    <section aria-label="Inbox" className="inbox">
    <h2>Needs you</h2>
    {waiting.length === 0 ? <div className="inbox-empty">
      <p className="inbox-empty-title">{firstRun ? 'Nothing needs you yet' : 'Nothing needs you'}</p>
      <p className="muted inbox-empty-body">{firstRun
        ? 'When an agent asks a question, proposes a direction, or finishes a task, it waits for you here instead of scrolling past in a room.'
        : 'Every question and finished task has an answer. New ones land here as they arrive.'}</p>
      {firstRun && <button type="button" className="inbox-empty-action" onClick={() => {
        // One create flow, not two. The rail owns it; the Inbox just points there.
        const create = document.querySelector<HTMLButtonElement>('#projects-rail .rail-create');
        if (create?.getAttribute('aria-expanded') !== 'true') create?.click();
        document.querySelector<HTMLInputElement>('#new-project-name')?.focus();
      }}>
        Create a project
      </button>}
    </div> : <ol className="inbox-list">
      {waiting.map((task) => {
        // A failed task and a successful one are not the same errand. Sending a
        // human to "review a result" that actually failed wastes the trip.
        const failed = isFailureStatus(task.status);
        const reason = task.status === 'needs_input'
          ? task.proposal?.question ?? task.question ?? 'Input needed'
          : failed ? 'Failed. Needs a decision' : 'Result waiting for review';
        return <li key={task.id}>
          <button type="button" className="inbox-row" data-task-id={task.id} onClick={() => onSelect(task)}>
            <strong className="inbox-title">{task.title}</strong>
            <time className="inbox-time" dateTime={task.updatedAt} title={task.updatedAt}>{relativeAgo(task.updatedAt)}</time>
            <span className="inbox-sub">
              <span className="inbox-room">{rooms.find((room) => room.id === task.roomId)?.name ?? task.roomId}</span>
              <span className={failed ? 'inbox-reason failed' : 'inbox-reason'} data-failed={failed ? '' : undefined}>{reason}</span>
            </span>
          </button>
        </li>;
      })}
    </ol>}
    </section>
    <RoomActivity tasks={tasks} rooms={rooms} onOpenRoom={onOpenRoom} />
  </>;
}
