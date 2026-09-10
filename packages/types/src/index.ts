import type { TaskStatus } from './task-status';
export * from './task-status';
export * from './composer';

export type MessageBody = { kind: 'text'; text: string } | { kind: 'task'; taskId: string };
export interface Message { id: string; roomId: string; author: string; body: MessageBody; createdAt: string }
export interface MessageSnapshot { messages: Message[]; since: number }
export interface CreateMessage { roomId: string; author: string; body: string }

export interface CreateTask {
  roomId?: string;
  title: string;
  owner: string;
  definitionOfDone: string;
}
export interface Task extends CreateTask {
  roomId: string;
  id: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
}
export interface TaskEventPayloads {
  message_created: { message: Message };
  task_created: { task: Task };
  task_status_changed: { task: Task; previousStatus: TaskStatus };
}
export type EventKind = keyof TaskEventPayloads;
export type TaskEvent = {
  [K in EventKind]: {
    id: number;
    subject_id: string | null;
    room_id: string;
    ts: string;
    kind: K;
    payload: TaskEventPayloads[K];
  }
}[EventKind];
export interface TaskSnapshot { tasks: Task[]; since: number }
