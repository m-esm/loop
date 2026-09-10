'use client';

import { useEffect, useState } from 'react';
import { isActiveStatus, type MessageSnapshot, type TaskSnapshot } from '@loop/types';
import { api } from '../lib/api';
import { applyTaskEvent, needsHumanCount, type RoomFeed } from '../lib/feed';
import TasksFeed from './TasksFeed';
import TasksPanel from './TasksPanel';
import Transcript from './Transcript';
import Composer from './Composer';
import ProjectsRailEntry from './ProjectsRailEntry';

export default function Room() {
  const [state, setState] = useState<RoomFeed>({ tasks: [], messages: [] });
  const [cursors, setCursors] = useState<{ tasks: number; messages: number } | null>(null);
  const [view, setView] = useState('chat');
  const [author, setAuthor] = useState('Human');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const chatCount = needsHumanCount(state.tasks);
  const tasksCount = state.tasks.filter((task) => isActiveStatus(task.status)).length;
  const chatLabel = chatCount === 1 ? '1 task needs a human' : `${chatCount} tasks need a human`;
  const tasksLabel = tasksCount === 1 ? '1 task running' : `${tasksCount} tasks running`;
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
    {/* Room owns the feed; portal the rail entry so page.tsx stays a server shell. */}
    <ProjectsRailEntry count={needsHumanCount(state.tasks)} />
    <nav aria-label="Room views">
      <span className="room-tab">
        <button aria-pressed={view === 'chat'} onClick={() => setView('chat')}>Chat</button>
        {chatCount > 0
          ? <span data-tab-badge="chat" className="needs-human-pill" aria-label={chatLabel}>{chatCount}</span>
          : null}
      </span>
      <span className="room-tab">
        <button aria-pressed={view === 'tasks'} onClick={() => setView('tasks')}>Tasks</button>
        {tasksCount > 0
          ? <span data-tab-badge="tasks" className="tab-running-pill" aria-label={tasksLabel}>{tasksCount}</span>
          : null}
      </span>
      {cursors && <TasksFeed since={Math.min(cursors.tasks, cursors.messages)} onEvent={(event) => {
        const baseline = event.kind === 'message_created' ? cursors.messages : cursors.tasks;
        if (event.room_id === 'default' && event.id > baseline) setState((rows) => applyTaskEvent(rows, event));
      }} />}
    </nav>
    {error && <p role="alert">{error} <button onClick={() => setAttempt((value) => value + 1)}>Retry</button></p>}
    {!cursors && !error && <p>Loading room...</p>}
    {cursors && (view === 'chat' ? <section aria-label="Chat">
      <Transcript tasks={state.tasks} messages={state.messages} author={author} />
      <Composer author={author} onAuthorChange={setAuthor} />
    </section> : <TasksPanel tasks={state.tasks} />)}
  </>;
}
