'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  isActiveStatus, type MessageSnapshot, type RoomFile, type RoomFilesSnapshot,
  type RoomsSnapshot, type RoomSummary, type Task, type TaskSnapshot,
} from '@loop/types';
import { api, ApiError, type Me } from '../lib/api';
import { applyTaskEvent, needsHumanCount, type RoomFeed } from '../lib/feed';
import TasksFeed from './TasksFeed';
import TasksPanel, { TaskDetail } from './TasksPanel';
import Transcript from './Transcript';
import Composer from './Composer';
import LoginForm from './LoginForm';
import ProjectsRailEntry from './ProjectsRailEntry';
import RoomAgents from './RoomAgents';
import Team from './Team';
import FilesPanel from './FilesPanel';

type InspectorKind = 'closed' | 'task' | 'team' | 'agents';

const ROOM_ID = /^[A-Za-z0-9_-]+$/;

function queryRoom(): string | null {
  const value = new URLSearchParams(window.location.search).get('room');
  if (!value || value.length > 100 || !ROOM_ID.test(value)) return null;
  return value;
}

function writeRoomQuery(id: string, mode: 'push' | 'replace') {
  const url = new URL(window.location.href);
  url.searchParams.set('room', id);
  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next === current) return;
  if (mode === 'push') window.history.pushState(null, '', next);
  else window.history.replaceState(null, '', next);
}

function membershipRoom(rooms: RoomSummary[], wanted: string | null): string {
  if (wanted && rooms.some((room) => room.id === wanted)) return wanted;
  return rooms.find((room) => room.id === 'default')?.id ?? rooms[0]?.id ?? 'default';
}

export default function Room() {
  const [me, setMe] = useState<Me | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [selected, setSelected] = useState('default');
  const [state, setState] = useState<RoomFeed>({ tasks: [], messages: [] });
  const [files, setFiles] = useState<RoomFile[]>([]);
  const [cursors, setCursors] = useState<{ tasks: number; messages: number } | null>(null);
  const [view, setView] = useState('chat');
  const [inspector, setInspector] = useState<InspectorKind>('closed');
  const [inspectTaskId, setInspectTaskId] = useState<string | null>(null);
  const [inspectorHost, setInspectorHost] = useState<HTMLElement | null>(null);
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
    setInspector('closed');
    setInspectTaskId(null);
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
    const wanted = queryRoom();
    if (wanted) setSelected(wanted);
    api<RoomsSnapshot>('/rooms', { signal: controller.signal }).then((listed) => {
      setRooms(listed.rooms);
      const next = membershipRoom(listed.rooms, wanted);
      setSelected(next);
      writeRoomQuery(next, 'replace');
      setError('');
    }).catch((error: Error) => {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) { signedOut(); return; }
      setError(error.message);
    });
    return () => controller.abort();
  }, [me, attempt]);
  useEffect(() => {
    function onPop() {
      const wanted = queryRoom();
      setSelected((current) => rooms ? membershipRoom(rooms, wanted) : (wanted ?? current));
    }
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [rooms]);
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
  useEffect(() => { setInspectorHost(document.getElementById('inspector')); }, []);
  useEffect(() => {
    setInspectTaskId(null);
    setInspector((kind) => (kind === 'task' ? 'closed' : kind));
  }, [selected]);
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
    writeRoomQuery(created.id, 'push');
  }
  function selectRoom(id: string) {
    setSelected(id);
    writeRoomQuery(id, 'push');
  }
  if (!authReady) return <p>Loading room...</p>;
  if (!me) return <LoginForm onAuthed={(value) => { setMe(value); setAuthReady(true); }} />;
  return <>
    {/* Room owns the feed; portal the rail entry so page.tsx stays a server shell. */}
    <ProjectsRailEntry
      count={needsHumanCount(state.tasks)}
      rooms={rooms ?? []}
      selected={selected}
      onSelect={selectRoom}
      onCreate={createRoom}
    />
    {inspectorHost && <Inspector
      host={inspectorHost}
      kind={inspector}
      room={selected}
      roomName={selectedName}
      task={state.tasks.find((row) => row.id === inspectTaskId)}
      onKind={setInspector}
      onClose={() => { setInspector('closed'); setInspectTaskId(null); }}
    />}
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
    </section> : view === 'tasks' ? <TasksPanel
      tasks={state.tasks}
      room={selected}
      onSelectTask={(id) => { setInspectTaskId(id); setInspector('task'); }}
    />
      : <FilesPanel room={selected} files={files} onChange={() => {
        void api<RoomFilesSnapshot>(`/rooms/${encodeURIComponent(selected)}/files`).then((snapshot) => setFiles(snapshot.files)).catch((err: Error) => setError(err.message));
      }} />)}
  </>;
}

function Inspector({
  host, kind, room, roomName, task, onKind, onClose,
}: {
  host: HTMLElement;
  kind: InspectorKind;
  room: string;
  roomName: string;
  task: Task | undefined;
  onKind: (kind: InspectorKind) => void;
  onClose: () => void;
}) {
  const open = kind !== 'closed';
  const title = kind === 'task' ? (task?.title ?? 'Task') : kind === 'closed' ? '' : roomName;
  const kindLabel = kind === 'task' ? 'Task' : kind === 'team' ? 'Team' : kind === 'agents' ? 'Agents' : '';
  return createPortal(
    <div className="inspector" data-inspector={kind}>
      {open && <div className="inspector-head">
        <span className="inspector-kind">{kindLabel}</span>
        <h2 className="inspector-title">{title}</h2>
        <button type="button" onClick={onClose}>Close</button>
      </div>}
      <div className="inspector-tabs" role="tablist" aria-label="Inspector">
        <button type="button" aria-pressed={kind === 'task'} onClick={() => onKind('task')}>Task</button>
        <button type="button" aria-pressed={kind === 'team'} onClick={() => onKind('team')}>Team</button>
        <button type="button" aria-pressed={kind === 'agents'} onClick={() => onKind('agents')}>Agents</button>
      </div>
      <div className="inspector-body" data-inspector-body={kind}>
        {kind === 'closed' && <p className="inspector-empty">Pick a task, Team, or Agents.</p>}
        {kind === 'task' && (task
          ? <TaskDetail task={task} />
          : <p className="inspector-empty">Select a task to see its owner and definition of done.</p>)}
        {kind === 'team' && <Team room={room} />}
        {kind === 'agents' && <RoomAgents room={room} />}
      </div>
    </div>,
    host,
  );
}
