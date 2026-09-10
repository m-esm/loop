import { relativeAgo, type Message, type Task } from '@loop/types';
import { actorLabel } from '../lib/api';
import TaskCard from './TaskCard';

export default function MessageCard({ message, task, tasks = [] }: {
  message: Message; task?: Task; tasks?: Task[];
}) {
  return <article className="message-card" data-message-id={message.id}>
    <div className="message-meta"><strong>{actorLabel(message.author, message.authorPrincipalId)}</strong> <time dateTime={message.createdAt} title={message.createdAt}>{relativeAgo(message.createdAt)}</time></div>
    {message.body.kind === 'text' ? <p className="message-body">{message.body.text}</p>
      : task ? <TaskCard task={task} tasks={tasks} /> : <p>Loading task...</p>}
  </article>;
}
