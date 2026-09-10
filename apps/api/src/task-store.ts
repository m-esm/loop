import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { INITIAL_STATUS, type CreateTask, type TaskSnapshot, type TaskStatus } from '@loop/types';
import { Database } from './database';
import { EventBus } from './bus';
import { tasks } from './schema';
import { roomId } from './field';

@Injectable()
export class TaskStore {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(EventBus) private readonly bus: EventBus,
  ) {}

  list(): TaskSnapshot {
    return this.database.sqlite.transaction(() => ({
      tasks: this.database.db.select().from(tasks).orderBy(desc(tasks.createdAt), desc(tasks.id)).all(),
      since: this.bus.latestId(),
    }))();
  }

  get(id: string) {
    const task = this.database.db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!task) throw new NotFoundException('Task not found');
    return task;
  }

  create(input: CreateTask) {
    const event = this.bus.emitEvent(() => {
      const ts = new Date().toISOString();
      const task = this.database.db.insert(tasks).values({
        ...input, roomId: roomId(input.roomId ?? 'default'), id: randomUUID(), status: INITIAL_STATUS, createdAt: ts, updatedAt: ts,
      }).returning().get();
      return { subject_id: task.id, room_id: task.roomId, ts, kind: 'task_created', payload: { task } };
    });
    if (event.kind !== 'task_created') throw new Error('Unexpected event kind');
    return event.payload.task;
  }

  updateStatus(id: string, status: TaskStatus) {
    const event = this.bus.emitEvent(() => {
      const previousStatus = this.get(id).status;
      const ts = new Date().toISOString();
      const task = this.database.db.update(tasks).set({ status, updatedAt: ts })
        .where(eq(tasks.id, id)).returning().get()!;
      return { subject_id: id, room_id: task.roomId, ts, kind: 'task_status_changed', payload: { task, previousStatus } };
    });
    if (event.kind !== 'task_status_changed') throw new Error('Unexpected event kind');
    return event.payload.task;
  }
}
