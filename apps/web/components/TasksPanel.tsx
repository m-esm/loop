'use client';

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { chipClass, isActiveStatus, type Task } from '@loop/types';
import CreateTaskForm from './CreateTaskForm';

export default function TasksPanel({ tasks }: { tasks: Task[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const detail = tasks.find((task) => task.id === selected);
  return <section aria-label="Tasks">
    <div className="task-heading"><h3>Tasks</h3>
    </div>
    <CreateTaskForm />
    <div className="table-wrap"><table>
      <thead><tr><th>Task</th><th>Owner</th><th>State</th></tr></thead>
      <tbody>{tasks.map((task) => <tr key={task.id} data-task-id={task.id}>
        <td><button className="task-title" onClick={() => setSelected(task.id)}>{task.title}</button></td>
        <td>{task.owner}</td><td><span className={chipClass(task.status)}>{task.status}</span></td>
      </tr>)}</tbody>
    </table></div>
    {!tasks.length && <p className="muted">No tasks yet. Create the first task above.</p>}
    {detail && createPortal(<section className="task-detail" aria-label="Task detail">
      <h3>{detail.title}</h3><p>Owner: {detail.owner}</p>
      <strong>Done when</strong><p>{detail.definitionOfDone}</p>
      {detail.log.length > 0 && <details>
        <summary>Log</summary>
        <pre data-task-log>{detail.log.join('\n')}</pre>
      </details>}
      {!isActiveStatus(detail.status) && detail.result && <p data-task-result className="task-result">{detail.result}</p>}
      {!isActiveStatus(detail.status) && detail.error && <p data-task-error className="task-error">{detail.error}</p>}
      <button onClick={() => setSelected(null)}>Close detail</button>
    </section>, document.getElementById('task-context')!)}
  </section>;
}
