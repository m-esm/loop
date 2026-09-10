'use client';

import { useLayoutEffect, useRef } from 'react';
import type { Message, Task } from '@loop/types';
import MessageCard from './MessageCard';

export default function Transcript({ messages, tasks, author }: { messages: Message[]; tasks: Task[]; author: string }) {
  const container = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useLayoutEffect(() => {
    const element = container.current;
    if (element && follow.current) element.scrollTop = element.scrollHeight;
  }, [messages, tasks]);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return <div className="transcript" ref={container} role="log" aria-label="Room transcript" tabIndex={0}
    onScroll={(event) => {
      const element = event.currentTarget;
      follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    }}>
    {!messages.length && <p className="muted">Start the conversation, or use /task to create a task here.</p>}
    {messages.map((message) => <MessageCard key={message.id} message={message} author={author}
      task={message.body.kind === 'task' ? byId.get(message.body.taskId) : undefined} />)}
  </div>;
}
