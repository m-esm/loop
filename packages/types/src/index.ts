import type { TaskStatus } from './task-status';
export * from './task-status';

export interface CreateTask {
  title: string;
  owner: string;
  definitionOfDone: string;
}
export interface Task extends CreateTask {
  id: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
}
export interface TaskEventPayloads {
  task_created: { task: Task };
  task_status_changed: { task: Task; previousStatus: TaskStatus };
}
export type EventKind = keyof TaskEventPayloads;
export type TaskEvent = {
  [K in EventKind]: {
    id: number;
    task_id: string;
    ts: string;
    kind: K;
    payload: TaskEventPayloads[K];
  }
}[EventKind];
export interface TaskSnapshot { tasks: Task[]; since: number }
