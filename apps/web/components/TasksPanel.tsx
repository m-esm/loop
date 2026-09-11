'use client';

import { chipClass, isActiveStatus, type Task } from '@loop/types';
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
  return <section aria-label="Tasks">
    <div className="task-heading"><h3>Tasks</h3>
    </div>
    <CreateTaskForm roomId={room} />
    <div className="table-wrap"><table>
      <thead><tr><th>Task</th><th>Owner</th><th>State</th></tr></thead>
      <tbody>{tasks.map((task) => <tr key={task.id} data-task-id={task.id}>
        <td><button className="task-title" onClick={() => onSelectTask(task.id)}>{task.title}</button></td>
        <td>{actorLabel(task.owner, task.ownerPrincipalId)}</td><td><span className={chipClass(task.status)}>{task.status}</span></td>
      </tr>)}</tbody>
    </table></div>
    {!tasks.length && <p className="muted">No tasks yet. Create the first task above.</p>}
  </section>;
}
