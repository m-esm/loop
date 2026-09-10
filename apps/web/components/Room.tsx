'use client';

import { useEffect, useState } from 'react';
import type { MessageSnapshot, TaskSnapshot } from '@loop/types';
import { api } from '../lib/api';
import { applyTaskEvent, type RoomFeed } from '../lib/feed';
import TasksFeed from './TasksFeed';
import TasksPanel from './TasksPanel';
import Transcript from './Transcript';
import Composer from './Composer';

export default function Room() {
  const [state, setState] = useState<RoomFeed>({ tasks: [], messages: [] });
  const [cursors, setCursors] = useState<{ tasks: number; messages: number } | null>(null);
  const [view, setView] = useState('chat');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      api<TaskSnapshot>('/tasks', { signal: controller.signal }),
      api<MessageSnapshot>('/messages?roomId=default', { signal: controller.signal }),
    ]).then(([tasks, messages]) => {
      setState({ tasks: tasks.tasks, messages: messages.messages });
      setCursors({ tasks: tasks.since, messages: messages.since });
      setError('');
    }).catch((error: Error) => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [attempt]);
  return <>
    <nav aria-label="Room views">
      <button aria-pressed={view === 'chat'} onClick={() => setView('chat')}>Chat</button>
      <button aria-pressed={view === 'tasks'} onClick={() => setView('tasks')}>Tasks</button>
      {cursors && <TasksFeed since={Math.min(cursors.tasks, cursors.messages)} onEvent={(event) => {
        const baseline = event.kind === 'message_created' ? cursors.messages : cursors.tasks;
        if (event.room_id === 'default' && event.id > baseline) setState((rows) => applyTaskEvent(rows, event));
      }} />}
    </nav>
    {error && <p role="alert">{error} <button onClick={() => setAttempt((value) => value + 1)}>Retry</button></p>}
    {!cursors && !error && <p>Loading room...</p>}
    {cursors && (view === 'chat' ? <section aria-label="Chat">
      <Transcript tasks={state.tasks} messages={state.messages} />
      <Composer />
    </section> : <TasksPanel tasks={state.tasks} />)}
  </>;
}
