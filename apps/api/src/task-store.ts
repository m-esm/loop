import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { INITIAL_STATUS, type CreateTask, type TaskSnapshot, type TaskStatus } from '@loop/types';
import { Database } from './database';
import { EventBus } from './bus';
import { tasks } from './schema';

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
    return this.bus.emitEvent(() => {
      const ts = new Date().toISOString();
      const task = this.database.db.insert(tasks).values({
        ...input, id: randomUUID(), status: INITIAL_STATUS, createdAt: ts, updatedAt: ts,
      }).returning().get();
      return { task_id: task.id, ts, kind: 'task_created', payload: { task } };
    }).payload.task;
  }

  updateStatus(id: string, status: TaskStatus) {
    return this.bus.emitEvent(() => {
      const previousStatus = this.get(id).status;
      const ts = new Date().toISOString();
      const task = this.database.db.update(tasks).set({ status, updatedAt: ts })
        .where(eq(tasks.id, id)).returning().get()!;
      return { task_id: id, ts, kind: 'task_status_changed', payload: { task, previousStatus } };
    }).payload.task;
  }
}
