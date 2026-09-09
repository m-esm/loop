import type { Task, TaskEvent } from '@loop/types';

/** Ported from 3DVP TasksFeed.tsx. */
export function sseBackoffDelay(attempt: number): number {
  const base = Math.min(2000 * 2 ** Math.max(0, attempt), 30_000);
  return Math.min(Math.round(base * (0.75 + Math.random() * 0.5)), 30_000);
}

export function applyTaskEvent(tasks: Task[], event: TaskEvent): Task[] {
  const task = event.payload.task;
  const existing = tasks.findIndex((row) => row.id === task.id);
  if (existing === -1) return [task, ...tasks];
  return tasks.map((row, index) => index === existing ? task : row);
}
