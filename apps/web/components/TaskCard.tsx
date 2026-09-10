import { chipClass, isActiveStatus, type Task } from '@loop/types';

export default function TaskCard({ task }: { task: Task }) {
  const terminal = !isActiveStatus(task.status);
  return <div className="chat-task" data-task-id={task.id}>
    <h3>{task.title}</h3><span className={chipClass(task.status)}>{task.status}</span>
    <p>Owner: {task.owner}</p>
    <p className="done-when" title={task.definitionOfDone}>Done when: {task.definitionOfDone}</p>
    {task.log.length > 0 && <details>
      <summary>Log</summary>
      <pre data-task-log>{task.log.join('\n')}</pre>
    </details>}
    {terminal && task.result && <p data-task-result className="task-result">{task.result}</p>}
    {terminal && task.error && <p data-task-error className="task-error">{task.error}</p>}
  </div>;
}
