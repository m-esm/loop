'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';
import { isActiveStatus, type Message, type Task } from '@loop/types';
import MessageCard from './MessageCard';

export default function Transcript({ messages, tasks }: { messages: Message[]; tasks: Task[] }) {
  const container = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const pinned = useRef(new Set<string>());
  useLayoutEffect(() => {
    const element = container.current;
    if (element && follow.current) element.scrollTop = element.scrollHeight;
  }, [messages, tasks]);
  // UI.md: a question is pinned until answered. Following alone is not enough.
  // An answered card shrinks when its form unmounts, which leaves `follow` stuck
  // false, so a later parked card never scrolls into view. Re-pin on every
  // render while a question waits: a card ABOVE it can grow later (a verdict
  // form appearing on a finished task) and push the answer form below the fold.
  useEffect(() => {
    // A finished task with no verdict is also waiting on a human: UI.md counts
    // "waiting on human acceptance" alongside questions. Both must stay reachable.
    const waiting = tasks
      .filter((task) => task.status === 'needs_input'
        || (!isActiveStatus(task.status) && !task.verdict))
      .map((task) => task.id);
    const fresh = waiting.length > 0;
    pinned.current = new Set(waiting);
    if (!fresh) return;
    // After paint: the answer form mounts in this same commit, and scrolling to a
    // height measured before it renders lands short of the form.
    const frame = requestAnimationFrame(() => {
      const element = container.current;
      if (!element) return;
      follow.current = true;
      element.scrollTop = element.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [tasks]);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return <div className="transcript" ref={container} role="log" aria-label="Room transcript" tabIndex={0}
    onScroll={(event) => {
      const element = event.currentTarget;
      follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    }}>
    {!messages.length && <p className="muted">Start the conversation, or use /task to create a task here.</p>}
    {messages.map((message) => <MessageCard key={message.id} message={message} tasks={tasks}
      task={message.body.kind === 'task' ? byId.get(message.body.taskId) : undefined} />)}
  </div>;
}
