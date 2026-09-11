import { relativeAgo, type Message, type RoomFile, type Task } from '@loop/types';
import { API_URL, actorLabel } from '../lib/api';
import TaskCard from './TaskCard';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function initials(name: string): string {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2)
    .map((word) => word[0]!.toUpperCase()).join('');
}

export default function MessageCard({ message, task, file, tasks = [], replyCount = 0, participants = [], onOpenThread, onOpenArtifact }: {
  message: Message; task?: Task; file?: RoomFile; tasks?: Task[];
  replyCount?: number; participants?: string[]; onOpenThread?: (id: string) => void;
  onOpenArtifact?: (file: RoomFile) => void;
}) {
  const countLabel = replyCount === 1 ? '1 reply' : `${replyCount} replies`;
  const visible = participants.slice(0, 3);
  const overflow = participants.length - visible.length;
  return <article className="message-card" data-message-id={message.id}>
    <div className="message-meta"><strong>{actorLabel(message.author, message.authorPrincipalId)}</strong> <time dateTime={message.createdAt} title={message.createdAt}>{relativeAgo(message.createdAt)}</time></div>
    {message.body.kind === 'text' ? <p className="message-body">{message.body.text}</p>
      : message.body.kind === 'task'
        ? (task ? <TaskCard task={task} tasks={tasks} /> : <p>Loading task...</p>)
        : (file ? <div className="file-card" data-file-id={file.id}>
          {onOpenArtifact
            ? <button type="button" className="task-title" data-file-name onClick={() => onOpenArtifact(file)}>{file.name}</button>
            : <p data-file-name>{file.name}</p>}
          <p className="muted" data-file-size>{formatSize(file.size)}</p>
          <a href={`${API_URL}/rooms/${file.roomId}/files/${file.id}/content`} download={file.name}>Download</a>
        </div> : <p>Loading file...</p>)}
    {onOpenThread && <div className="message-thread">
      {replyCount > 0
        ? <button type="button" className="thread-summary" data-thread-summary
            aria-label={countLabel} onClick={() => onOpenThread(message.id)}>
            {visible.map((name) => <span key={name} className="participant" data-participant>{initials(name)}</span>)}
            {overflow > 0 ? <span className="muted">+{overflow}</span> : null}
            <span>{countLabel}</span>
          </button>
        : <button type="button" onClick={() => onOpenThread(message.id)}>Reply</button>}
    </div>}
  </article>;
}
