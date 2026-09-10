import { relativeAgo, type Message, type RoomFile, type Task } from '@loop/types';
import { API_URL, actorLabel } from '../lib/api';
import TaskCard from './TaskCard';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function MessageCard({ message, task, file, tasks = [] }: {
  message: Message; task?: Task; file?: RoomFile; tasks?: Task[];
}) {
  return <article className="message-card" data-message-id={message.id}>
    <div className="message-meta"><strong>{actorLabel(message.author, message.authorPrincipalId)}</strong> <time dateTime={message.createdAt} title={message.createdAt}>{relativeAgo(message.createdAt)}</time></div>
    {message.body.kind === 'text' ? <p className="message-body">{message.body.text}</p>
      : message.body.kind === 'task'
        ? (task ? <TaskCard task={task} tasks={tasks} /> : <p>Loading task...</p>)
        : (file ? <div className="file-card" data-file-id={file.id}>
          <p data-file-name>{file.name}</p>
          <p className="muted" data-file-size>{formatSize(file.size)}</p>
          <a href={`${API_URL}/rooms/${file.roomId}/files/${file.id}/content`} download={file.name}>Download</a>
        </div> : <p>Loading file...</p>)}
  </article>;
}
