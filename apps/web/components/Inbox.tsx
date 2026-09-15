import { useRef } from 'react';
import { isFailureStatus, relativeAgo, type RoomSummary, type Task } from '@loop/types';
import { needsHumanTasks } from '../lib/feed';
import { useMeasuredRowPitch } from '../lib/rowPitch';
import RoomActivity from './RoomActivity';

export default function Inbox({ tasks, rooms, onSelect, onOpenRoom }: {
  tasks: Task[];
  rooms: RoomSummary[];
  onSelect: (task: Task) => void;
  onOpenRoom: (id: string) => void;
}) {
  const waiting = needsHumanTasks(tasks)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
  // The floor under both Home lists is measured off a rendered row rather than
  // transcribed from the rules that style one. Both lists render .inbox-row at
  // the same density, so one measurement serves both floors and it is taken
  // here, in the one component that renders both sections, instead of once in
  // each of them. The anchor is the queue section; the hook walks up to the
  // main both sections hang off and publishes the pitch there.
  const homeAnchor = useRef<HTMLElement | null>(null);
  // Re-measure when the rendered rows change identity, which is what an SSE
  // update to the queue or the room list does. A row that stays put and merely
  // changes size is the observer's job, not this signal's.
  useMeasuredRowPitch(homeAnchor, `${waiting.length}:${tasks.length}:${rooms.length}`);
  // Two different empty states. An account that has never produced a task needs
  // telling what the Inbox is for; an emptied queue is a human who cleared their
  // work and wants to know that, not an onboarding pitch.
  const firstRun = tasks.length === 0;
  return <>
    <section aria-label="Inbox" className="inbox" ref={homeAnchor}>
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
