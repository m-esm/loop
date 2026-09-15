import { isActiveStatus, type Message, type Task, type TaskEvent } from '@loop/types';

/** Ported from 3DVP TasksFeed.tsx. */
export function sseBackoffDelay(attempt: number): number {
  const base = Math.min(2000 * 2 ** Math.max(0, attempt), 30_000);
  return Math.min(Math.round(base * (0.75 + Math.random() * 0.5)), 30_000);
}

export interface RoomFeed { tasks: Task[]; messages: Message[] }

/** The one definition of "this task is waiting on a human": a parked question
 *  or proposal, or a finished task nobody has accepted or rejected yet. The
 *  Inbox list and the rail badge must agree, so both read this. */
export function needsHumanTasks(tasks: Task[]): Task[] {
  return tasks.filter((task) => task.status === 'needs_input'
    || (!isActiveStatus(task.status) && !task.verdict));
}

/** Count parked tasks, not question cards. One task is one badge. This is the
 *  Chat tab's badge: a question nobody has answered. It is deliberately
 *  narrower than the Home queue, which also surfaces unreviewed results. */
export function needsHumanCount(tasks: Task[]): number {
  return tasks.filter((task) => task.status === 'needs_input').length;
}

/** Per-room counts for the rail. Home has no selected room, so a badge gated
 *  on the selection never renders there. This deliberately uses the same
 *  narrow definition as needsHumanCount (an unanswered question), so the rail
 *  badge and the Chat tab badge agree. The Home queue is broader: it also
 *  lists unreviewed results, so the Inbox can show more rows than the rail
 *  badges sum to. Widening the badge is a product call, not a layout fix. */
export function needsHumanByRoom(tasks: Task[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const task of tasks.filter((row) => row.status === 'needs_input')) {
    counts.set(task.roomId, (counts.get(task.roomId) ?? 0) + 1);
  }
  return counts;
}

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
