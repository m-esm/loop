'use client';

import { useState } from 'react';
import { TASK_STATUSES, chipClass, isActiveStatus, statusLabel, type Task } from '@loop/types';
import { actorLabel } from '../lib/api';
import CreateTaskForm from './CreateTaskForm';

export function TaskDetail({ task }: { task: Task }) {
  return <section className="task-detail" aria-label="Task detail">
    <h3>{task.title}</h3><p>Owner: {actorLabel(task.owner, task.ownerPrincipalId)}</p>
    <strong>Done when</strong><p>{task.definitionOfDone}</p>
    {task.log.length > 0 && <details>
      <summary>Log</summary>
      <pre data-task-log>{task.log.join('\n')}</pre>
    </details>}
    {!isActiveStatus(task.status) && task.result && <p data-task-result className="task-result">{task.result}</p>}
    {!isActiveStatus(task.status) && task.error && <p data-task-error className="task-error">{task.error}</p>}
  </section>;
}

export default function TasksPanel({
  tasks, room, onSelectTask,
}: {
  tasks: Task[];
  room: string;
  onSelectTask: (id: string) => void;
}) {
  const [view, setView] = useState<'board' | 'list'>('board');
  return <section aria-label="Tasks">
    <div className="task-heading"><h3>Tasks</h3>
      <div className="task-view-toggle" role="group" aria-label="Task view">
        <button type="button" aria-pressed={view === 'board'} onClick={() => setView('board')}>Board</button>
        <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>List</button>
      </div>
    </div>
    <CreateTaskForm roomId={room} />
    {!tasks.length ? <div className="tasks-empty">
      <p className="inbox-empty-title">No tasks yet</p>
      <p className="inbox-empty-body">Create one to put work on the board. Columns appear once something is running.</p>
      <button type="button" className="inbox-empty-action" onClick={() => {
        const toggle = document.querySelector('.task-create button[aria-expanded="false"]');
        if (toggle instanceof HTMLButtonElement) toggle.click();
      }}>Create a task</button>
    </div> : view === 'board' ? <div className="task-board" role="region" aria-label="Task board" tabIndex={0}>
      {TASK_STATUSES.map((status) => {
        const columnTasks = tasks.filter((task) => task.status === status);
        return <section className="task-board-column" key={status} data-task-status={status} aria-label={statusLabel(status)}>
          <h4>{statusLabel(status)}<span className="muted">{columnTasks.length}</span></h4>
          {columnTasks.map((task) => <button type="button" className="task-board-card" key={task.id}
            data-task-id={task.id} aria-label={task.title} onClick={() => onSelectTask(task.id)}>
            <span className="task-board-title">{task.title}</span>
            <span className="task-board-owner">Owner: {actorLabel(task.owner, task.ownerPrincipalId)}</span>
            <span className={chipClass(task.status)}>{statusLabel(task.status)}</span>
          </button>)}
        </section>;
      })}
    </div> : <div className="table-wrap"><table>
      <thead><tr><th>Task</th><th>Owner</th><th>State</th></tr></thead>
      <tbody>{tasks.map((task) => <tr key={task.id} data-task-id={task.id}>
        <td><button className="task-title" onClick={() => onSelectTask(task.id)}>{task.title}</button></td>
        <td>{actorLabel(task.owner, task.ownerPrincipalId)}</td><td><span className={chipClass(task.status)}>{statusLabel(task.status)}</span></td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
}
