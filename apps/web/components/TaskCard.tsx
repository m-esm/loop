import { chipClass, type Task } from '@loop/types';

export default function TaskCard({ task }: { task: Task }) {
  return <div className="chat-task" data-task-id={task.id}>
    <h3>{task.title}</h3><span className={chipClass(task.status)}>{task.status}</span>
    <p>Owner: {task.owner}</p>
    <p className="done-when" title={task.definitionOfDone}>Done when: {task.definitionOfDone}</p>
  </div>;
}
