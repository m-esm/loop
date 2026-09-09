'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { chipClass, type TaskSnapshot, type Task } from '@loop/types';
import { api } from '../lib/api';
import { applyTaskEvent } from '../lib/feed';
import TasksFeed from './TasksFeed';
import CreateTaskForm from './CreateTaskForm';

export default function TasksPanel() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [since, setSince] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api<TaskSnapshot>('/tasks', { signal: controller.signal }).then((snapshot) => {
      setTasks(snapshot.tasks);
      setSince(snapshot.since);
      setError('');
    }).catch((error: Error) => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [attempt]);
  const detail = tasks.find((task) => task.id === selected);
  return <section aria-label="Tasks">
    <div className="task-heading"><h3>Tasks</h3>
      {since !== null && <TasksFeed since={since} onEvent={(event) => setTasks((rows) => applyTaskEvent(rows, event))} />}
    </div>
    <CreateTaskForm />
    {error && <p role="alert">{error} <button onClick={() => setAttempt((value) => value + 1)}>Retry</button></p>}
    {since === null && !error && <p>Loading tasks...</p>}
    <div className="table-wrap"><table>
      <thead><tr><th>Task</th><th>Owner</th><th>State</th></tr></thead>
      <tbody>{tasks.map((task) => <tr key={task.id} data-task-id={task.id}>
        <td><button className="task-title" onClick={() => setSelected(task.id)}>{task.title}</button></td>
        <td>{task.owner}</td><td><span className={chipClass(task.status)}>{task.status}</span></td>
      </tr>)}</tbody>
    </table></div>
    {since !== null && !tasks.length && <p className="muted">No tasks yet. Create the first task above.</p>}
    {detail && createPortal(<section className="task-detail" aria-label="Task detail">
      <h3>{detail.title}</h3><p>Owner: {detail.owner}</p>
      <strong>Done when</strong><p>{detail.definitionOfDone}</p>
      <button onClick={() => setSelected(null)}>Close detail</button>
    </section>, document.getElementById('task-context')!)}
  </section>;
}
