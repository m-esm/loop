'use client';

import { useEffect, useState } from 'react';
import { isActiveStatus, type MessageSnapshot, type TaskSnapshot } from '@loop/types';
import { api, ApiError, type Me } from '../lib/api';
import { applyTaskEvent, needsHumanCount, type RoomFeed } from '../lib/feed';
import TasksFeed from './TasksFeed';
import TasksPanel from './TasksPanel';
import Transcript from './Transcript';
import Composer from './Composer';
import LoginForm from './LoginForm';
import ProjectsRailEntry from './ProjectsRailEntry';

export default function Room() {
  const [me, setMe] = useState<Me | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [state, setState] = useState<RoomFeed>({ tasks: [], messages: [] });
  const [cursors, setCursors] = useState<{ tasks: number; messages: number } | null>(null);
  const [view, setView] = useState('chat');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const chatCount = needsHumanCount(state.tasks);
  const tasksCount = state.tasks.filter((task) => isActiveStatus(task.status)).length;
  const chatLabel = chatCount === 1 ? '1 task needs a human' : `${chatCount} tasks need a human`;
  const tasksLabel = tasksCount === 1 ? '1 task running' : `${tasksCount} tasks running`;
  function signedOut() {
    setMe(null);
    setCursors(null);
    setState({ tasks: [], messages: [] });
    setAuthReady(true);
  }
  useEffect(() => {
    const controller = new AbortController();
    api<Me>('/auth/me', { signal: controller.signal }).then((value) => {
      setMe(value);
      setAuthReady(true);
      setError('');
    }).catch((error: Error) => {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) { signedOut(); return; }
      setAuthReady(true);
      setError(error.message);
    });
    return () => controller.abort();
  }, [attempt]);
  useEffect(() => {
    if (!me) return;
    const controller = new AbortController();
    Promise.all([
      api<TaskSnapshot>('/tasks', { signal: controller.signal }),
      api<MessageSnapshot>('/messages?roomId=default', { signal: controller.signal }),
    ]).then(([tasks, messages]) => {
      setState({ tasks: tasks.tasks, messages: messages.messages });
      setCursors({ tasks: tasks.since, messages: messages.since });
      setError('');
    }).catch((error: Error) => {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) { signedOut(); return; }
      setError(error.message);
    });
    return () => controller.abort();
  }, [me, attempt]);
  async function logout() {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* cookie is cleared server-side even if this races */ }
    signedOut();
  }
  if (!authReady) return <p>Loading room...</p>;
  if (!me) return <LoginForm onAuthed={(value) => { setMe(value); setAuthReady(true); }} />;
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
      {me && <button type="button" className="logout" onClick={() => { void logout(); }}>Log out</button>}
      {cursors && me && <TasksFeed since={Math.min(cursors.tasks, cursors.messages)} onUnauthorized={signedOut} onEvent={(event) => {
        const baseline = event.kind === 'message_created' ? cursors.messages : cursors.tasks;
        if (event.room_id === 'default' && event.id > baseline) setState((rows) => applyTaskEvent(rows, event));
      }} />}
    </nav>
    {error && <p role="alert">{error} <button onClick={() => setAttempt((value) => value + 1)}>Retry</button></p>}
    {!cursors && !error && me && <p>Loading room...</p>}
    {cursors && me && (view === 'chat' ? <section aria-label="Chat">
      <Transcript tasks={state.tasks} messages={state.messages} />
      <Composer author={me.displayName} />
    </section> : <TasksPanel tasks={state.tasks} />)}
  </>;
}
