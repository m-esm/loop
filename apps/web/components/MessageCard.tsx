import { relativeAgo, type Message, type Task } from '@loop/types';
import TaskCard from './TaskCard';

export default function MessageCard({ message, task }: { message: Message; task?: Task }) {
  return <article className="message-card" data-message-id={message.id}>
    <div className="message-meta"><strong>{message.author}</strong> <time dateTime={message.createdAt} title={message.createdAt}>{relativeAgo(message.createdAt)}</time></div>
    {message.body.kind === 'text' ? <p className="message-body">{message.body.text}</p>
      : task ? <TaskCard task={task} /> : <p>Loading task...</p>}
  </article>;
}
