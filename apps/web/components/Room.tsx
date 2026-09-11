'use client';

import { useEffect, useState } from 'react';
import {
  isActiveStatus, type MessageSnapshot, type RoomFile, type RoomFilesSnapshot,
  type RoomsSnapshot, type RoomSummary, type TaskSnapshot,
} from '@loop/types';
import { api, ApiError, type Me } from '../lib/api';
import { applyTaskEvent, needsHumanCount, type RoomFeed } from '../lib/feed';
import TasksFeed from './TasksFeed';
import TasksPanel from './TasksPanel';
import Transcript from './Transcript';
import Composer from './Composer';
import LoginForm from './LoginForm';
import ProjectsRailEntry from './ProjectsRailEntry';
import RoomAgents from './RoomAgents';
import Team from './Team';
import FilesPanel from './FilesPanel';

export default function Room() {
  const [me, setMe] = useState<Me | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [selected, setSelected] = useState('default');
  const [state, setState] = useState<RoomFeed>({ tasks: [], messages: [] });
  const [files, setFiles] = useState<RoomFile[]>([]);
  const [cursors, setCursors] = useState<{ tasks: number; messages: number } | null>(null);
  const [view, setView] = useState('chat');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const chatCount = needsHumanCount(state.tasks);
  const tasksCount = state.tasks.filter((task) => isActiveStatus(task.status)).length;
  const chatLabel = chatCount === 1 ? '1 task needs a human' : `${chatCount} tasks need a human`;
  const tasksLabel = tasksCount === 1 ? '1 task running' : `${tasksCount} tasks running`;
  const selectedName = rooms?.find((room) => room.id === selected)?.name
    ?? (selected === 'default' ? 'Loop' : selected);
  function signedOut() {
    setMe(null);
    setRooms(null);
    setSelected('default');
    setCursors(null);
    setState({ tasks: [], messages: [] });
    setFiles([]);
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
    api<RoomsSnapshot>('/rooms', { signal: controller.signal }).then((listed) => {
      setRooms(listed.rooms);
      setSelected((current) => listed.rooms.some((room) => room.id === current)
        ? current
        : (listed.rooms.find((room) => room.id === 'default')?.id ?? listed.rooms[0]?.id ?? current));
      setError('');
    }).catch((error: Error) => {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) { signedOut(); return; }
      setError(error.message);
    });
    return () => controller.abort();
  }, [me, attempt]);
  useEffect(() => {
    if (!me || rooms === null) return;
    if (!rooms.some((room) => room.id === selected)) return;
    setCursors(null);
    setState({ tasks: [], messages: [] });
    setFiles([]);
    const controller = new AbortController();
    Promise.all([
      api<TaskSnapshot>('/tasks', { signal: controller.signal }),
      api<MessageSnapshot>(`/messages?roomId=${encodeURIComponent(selected)}`, { signal: controller.signal }),
      api<RoomFilesSnapshot>(`/rooms/${encodeURIComponent(selected)}/files`, { signal: controller.signal }),
    ]).then(([tasks, messages, roomFiles]) => {
      setState({
        tasks: tasks.tasks.filter((task) => task.roomId === selected),
        messages: messages.messages,
      });
      setFiles(roomFiles.files);
      setCursors({ tasks: tasks.since, messages: messages.since });
      setError('');
    }).catch((error: Error) => {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) { signedOut(); return; }
      setError(error.message);
    });
    return () => controller.abort();
  }, [me, attempt, selected, rooms]);
  useEffect(() => {
    const heading = document.getElementById('room-heading');
    if (heading) heading.textContent = selectedName;
  }, [selectedName]);
  async function logout() {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* cookie is cleared server-side even if this races */ }
    signedOut();
  }
  async function createRoom(name: string) {
    const created = await api<RoomSummary>('/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    setRooms((current) => {
      if (!current) return [created];
      if (current.some((room) => room.id === created.id)) return current;
      return [...current, created];
    });
    setSelected(created.id);
  }
  if (!authReady) return <p>Loading room...</p>;
  if (!me) return <LoginForm onAuthed={(value) => { setMe(value); setAuthReady(true); }} />;
  return <>
    {/* Room owns the feed; portal the rail entry so page.tsx stays a server shell. */}
    <ProjectsRailEntry
      count={needsHumanCount(state.tasks)}
      rooms={rooms ?? []}
      selected={selected}
      onSelect={setSelected}
      onCreate={createRoom}
    />
    <Team room={selected} />
    <RoomAgents room={selected} />
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
      <span className="room-tab">
        <button aria-pressed={view === 'files'} onClick={() => setView('files')}>Files</button>
      </span>
      {me && <button type="button" className="logout" onClick={() => { void logout(); }}>Log out</button>}
      {cursors && me && <TasksFeed since={Math.min(cursors.tasks, cursors.messages)} onUnauthorized={signedOut} onEvent={(event) => {
        const baseline = event.kind === 'message_created' ? cursors.messages : cursors.tasks;
        if (event.room_id === selected && event.id > baseline) {
          setState((rows) => applyTaskEvent(rows, event));
          if (event.kind === 'message_created' && event.payload.message.body.kind === 'file') {
            void api<RoomFilesSnapshot>(`/rooms/${encodeURIComponent(selected)}/files`).then((snapshot) => setFiles(snapshot.files)).catch(() => { /* next event retries */ });
          }
        }
      }} />}
    </nav>
    {error && <p role="alert">{error} <button onClick={() => setAttempt((value) => value + 1)}>Retry</button></p>}
    {!cursors && !error && me && <p>Loading room...</p>}
    {cursors && me && (view === 'chat' ? <section aria-label="Chat">
      <Transcript tasks={state.tasks} messages={state.messages} files={files} />
      <Composer author={me.displayName} roomId={selected} />
    </section> : view === 'tasks' ? <TasksPanel tasks={state.tasks} room={selected} />
      : <FilesPanel room={selected} files={files} onChange={() => {
        void api<RoomFilesSnapshot>(`/rooms/${encodeURIComponent(selected)}/files`).then((snapshot) => setFiles(snapshot.files)).catch((err: Error) => setError(err.message));
      }} />)}
  </>;
}
