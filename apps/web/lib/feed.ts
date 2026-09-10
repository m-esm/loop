import type { Message, Task, TaskEvent } from '@loop/types';

/** Ported from 3DVP TasksFeed.tsx. */
export function sseBackoffDelay(attempt: number): number {
  const base = Math.min(2000 * 2 ** Math.max(0, attempt), 30_000);
  return Math.min(Math.round(base * (0.75 + Math.random() * 0.5)), 30_000);
}

export interface RoomFeed { tasks: Task[]; messages: Message[] }

export function applyTaskEvent(state: RoomFeed, event: TaskEvent): RoomFeed {
  if (event.kind === 'message_created') {
    const message = event.payload.message;
    if (state.messages.some((row) => row.id === message.id)) return state;
    return { ...state, messages: [...state.messages, message] };
  }
  const task = event.payload.task;
  const { tasks } = state;
  const existing = tasks.findIndex((row) => row.id === task.id);
  if (existing === -1) return { ...state, tasks: [task, ...tasks] };
  return { ...state, tasks: tasks.map((row, index) => index === existing ? task : row) };
}
