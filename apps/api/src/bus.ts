import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { and, asc, desc, gt, inArray } from 'drizzle-orm';
import type { TaskEvent } from '@loop/types';
import { Database } from './database';
import { events } from './schema';

/** Port of 3DVP bus.ts: every insert and publication goes through emitEvent. */
@Injectable()
export class EventBus {
  private readonly bus = new EventEmitter();
  private readonly logger = new Logger(EventBus.name);
  constructor(@Inject(Database) private readonly database: Database) {
    this.bus.setMaxListeners(0);
  }

  emitEvent(mutate: () => Omit<TaskEvent, 'id'>): TaskEvent {
    // Commit task and event atomically before any subscriber can observe them.
    const event = this.database.sqlite.transaction(() =>
      this.database.db.insert(events).values(mutate()).returning().get(),
    )() as TaskEvent;
    this.bus.emit('event', event);
    return event;
  }

  subscribe(listener: (event: TaskEvent) => void): () => void {
    const safe = (event: TaskEvent) => {
      try { listener(event); } catch { this.logger.warn('Event subscriber failed'); }
    };
    this.bus.on('event', safe);
    return () => { this.bus.off('event', safe); };
  }

  since(id: number, rooms?: string[], limit = 500): TaskEvent[] {
    if (rooms && rooms.length === 0) return [];
    const cond = rooms
      ? and(gt(events.id, id), inArray(events.room_id, rooms))
      : gt(events.id, id);
    return this.database.db.select().from(events).where(cond)
      .orderBy(asc(events.id)).limit(limit).all() as TaskEvent[];
  }

  latestId(): number {
    return this.database.db.select({ id: events.id }).from(events)
      .orderBy(desc(events.id)).limit(1).get()?.id ?? 0;
  }
}
