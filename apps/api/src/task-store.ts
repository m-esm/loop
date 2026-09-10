import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { INITIAL_STATUS, TASK_STATUSES, isActiveStatus, isRunningStatus, isTaskVerdict, type CreateTask, type TaskSnapshot, type TaskStatus } from '@loop/types';
import { Database } from './database';
import { EventBus } from './bus';
import { events, tasks } from './schema';
import { roomId } from './field';

export const LOG_MAX_LINES = 200;
export const LOG_MAX_CHARS = 500;
export const LOG_MAX_BYTES = 32 * 1024;

export class RunFenceError extends Error {
  constructor(message = 'run fence missed') {
    super(message);
    this.name = 'RunFenceError';
  }
}

export function capLog(lines: string[]): string[] {
  const clipped = lines.map((line) => line.slice(0, LOG_MAX_CHARS));
  const limited = clipped.length > LOG_MAX_LINES ? clipped.slice(clipped.length - LOG_MAX_LINES) : clipped;
  let bytes = 0;
  for (const line of limited) bytes += Buffer.byteLength(line);
  if (bytes <= LOG_MAX_BYTES) return limited;
  let start = 0;
  while (start < limited.length && bytes > LOG_MAX_BYTES) {
    bytes -= Buffer.byteLength(limited[start]);
    start += 1;
  }
  return limited.slice(start);
}

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
        ...input, roomId: roomId(input.roomId ?? 'default'), id: randomUUID(), status: INITIAL_STATUS,
        agentId: input.agentId ?? null, createdAt: ts, updatedAt: ts, log: [],
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

  claim(id: string, agentId: string) {
    try {
      const event = this.bus.emitEvent(() => {
        const ts = new Date().toISOString();
        const runId = randomUUID();
        const task = this.database.db.update(tasks).set({
          status: 'running', claimedBy: agentId, runId, updatedAt: ts,
        }).where(and(eq(tasks.id, id), eq(tasks.status, INITIAL_STATUS))).returning().get();
        if (!task) {
          this.get(id);
          throw new RunFenceError();
        }
        return {
          subject_id: id, room_id: task.roomId, ts, kind: 'task_status_changed',
          payload: { task, previousStatus: INITIAL_STATUS },
        };
      });
      if (event.kind !== 'task_status_changed') throw new Error('Unexpected event kind');
      return event.payload.task;
    } catch (error) {
      if (error instanceof RunFenceError) return null;
      throw error;
    }
  }

  progress(id: string, runId: string, lines: string | string[]) {
    const extra = Array.isArray(lines) ? lines : [lines];
    const event = this.bus.emitEvent(() => {
      const current = this.get(id);
      if (current.status !== 'running' || current.runId !== runId) throw new RunFenceError();
      this.database.db.delete(events).where(and(eq(events.kind, 'task_progress'), eq(events.subject_id, id))).run();
      const ts = new Date().toISOString();
      const log = capLog([...current.log, ...extra]);
      const task = this.database.db.update(tasks).set({ log, updatedAt: ts })
        .where(and(eq(tasks.id, id), eq(tasks.status, 'running'), eq(tasks.runId, runId))).returning().get();
      if (!task) throw new RunFenceError();
      return { subject_id: id, room_id: task.roomId, ts, kind: 'task_progress', payload: { task } };
    });
    if (event.kind !== 'task_progress') throw new Error('Unexpected event kind');
    return event.payload.task;
  }

  finish(id: string, runId: string, outcome: { status: 'done'; result: string } | { status: 'failed'; error: string }) {
    try {
      const event = this.bus.emitEvent(() => {
        const ts = new Date().toISOString();
        const fields = outcome.status === 'done'
          ? { status: outcome.status, result: outcome.result, error: null, updatedAt: ts }
          : { status: outcome.status, error: outcome.error, result: null, updatedAt: ts };
        const task = this.database.db.update(tasks).set(fields)
          .where(and(eq(tasks.id, id), eq(tasks.status, 'running'), eq(tasks.runId, runId))).returning().get();
        if (!task) {
          this.get(id);
          throw new RunFenceError();
        }
        return {
          subject_id: id, room_id: task.roomId, ts, kind: 'task_status_changed',
          payload: { task, previousStatus: 'running' },
        };
      });
      if (event.kind !== 'task_status_changed') throw new Error('Unexpected event kind');
      return event.payload.task;
    } catch (error) {
      if (error instanceof RunFenceError) return null;
      throw error;
    }
  }

  ask(id: string, runId: string, question: string) {
    const event = this.bus.emitEvent(() => {
      const ts = new Date().toISOString();
      const task = this.database.db.update(tasks).set({
        status: 'needs_input', question, updatedAt: ts,
      }).where(and(eq(tasks.id, id), eq(tasks.status, 'running'), eq(tasks.runId, runId))).returning().get();
      if (!task) {
        this.get(id);
        throw new RunFenceError();
      }
      return {
        subject_id: id, room_id: task.roomId, ts, kind: 'task_status_changed',
        payload: { task, previousStatus: 'running' },
      };
    });
    if (event.kind !== 'task_status_changed') throw new Error('Unexpected event kind');
    return event.payload.task;
  }

  answer(id: string, answer: string, answeredBy: string) {
    const event = this.bus.emitEvent(() => {
      const ts = new Date().toISOString();
      const task = this.database.db.update(tasks).set({
        answer, answeredBy, status: INITIAL_STATUS, updatedAt: ts,
      }).where(and(eq(tasks.id, id), eq(tasks.status, 'needs_input'))).returning().get();
      if (!task) {
        this.get(id);
        throw new BadRequestException('Task is not waiting for an answer');
      }
      return {
        subject_id: id, room_id: task.roomId, ts, kind: 'task_status_changed',
        payload: { task, previousStatus: 'needs_input' },
      };
    });
    if (event.kind !== 'task_status_changed') throw new Error('Unexpected event kind');
    return event.payload.task;
  }

  review(id: string, verdict: string, note: string | undefined, reviewedBy: string) {
    const event = this.bus.emitEvent(() => {
      if (!isTaskVerdict(verdict)) throw new BadRequestException('Invalid verdict');
      const current = this.get(id);
      if (isActiveStatus(current.status)) throw new BadRequestException('Task is not finished');
      const ts = new Date().toISOString();
      const verdictFields = {
        verdict, verdictNote: note ?? null, verdictBy: reviewedBy, updatedAt: ts,
      };
      const fields = verdict === 'accepted' ? verdictFields : {
        ...verdictFields,
        status: INITIAL_STATUS,
        runId: null,
        claimedBy: null,
        result: null,
        error: null,
      };
      const task = this.database.db.update(tasks).set(fields)
        .where(eq(tasks.id, id)).returning().get()!;
      return {
        subject_id: id, room_id: task.roomId, ts, kind: 'task_status_changed',
        payload: { task, previousStatus: current.status },
      };
    });
    if (event.kind !== 'task_status_changed') throw new Error('Unexpected event kind');
    return event.payload.task;
  }

  reclaimLost() {
    const stale = TASK_STATUSES.filter((status) => isRunningStatus(status) || status === 'cancelling');
    const rows = this.database.db.select().from(tasks).where(inArray(tasks.status, stale)).all();
    const reclaimed = [];
    for (const row of rows) {
      try {
        const event = this.bus.emitEvent(() => {
          const ts = new Date().toISOString();
          const task = this.database.db.update(tasks).set({
            status: 'failed', error: 'runner lost', updatedAt: ts,
          }).where(and(eq(tasks.id, row.id), inArray(tasks.status, stale))).returning().get();
          if (!task) throw new RunFenceError();
          return {
            subject_id: row.id, room_id: task.roomId, ts, kind: 'task_status_changed',
            payload: { task, previousStatus: row.status },
          };
        });
        if (event.kind !== 'task_status_changed') throw new Error('Unexpected event kind');
        reclaimed.push(event.payload.task);
      } catch (error) {
        if (!(error instanceof RunFenceError)) throw error;
      }
    }
    return reclaimed;
  }
}
