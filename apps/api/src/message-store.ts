import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import { parseComposer, type CreateMessage, type MessageBody, type MessageSnapshot } from '@loop/types';
import { Database } from './database';
import { EventBus } from './bus';
import { TaskStore } from './task-store';
import { messages } from './schema';
import { roomId } from './field';
import { assertKnownRoom } from './room-agents';

@Injectable()
export class MessageStore {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(EventBus) private readonly bus: EventBus,
    @Inject(TaskStore) private readonly tasks: TaskStore,
  ) {}

  list(room: string): MessageSnapshot {
    roomId(room);
    assertKnownRoom(this.database, room);
    return this.database.sqlite.transaction(() => ({
      messages: this.database.db.select().from(messages).where(eq(messages.roomId, room))
        .orderBy(asc(sql`rowid`)).all(),
      since: this.bus.latestId(),
    }))();
  }

  private resolveParent(room: string, parentId: string | null): string | null {
    if (!parentId) return null;
    const parent = this.database.db.select().from(messages).where(eq(messages.id, parentId)).get();
    if (!parent || parent.roomId !== room) throw new BadRequestException('Unknown parent');
    return parent.parentId ?? parent.id;
  }

  create(input: CreateMessage) {
    roomId(input.roomId);
    assertKnownRoom(this.database, input.roomId);
    const parentId = this.resolveParent(input.roomId, input.parentId ?? null);
    const parsed = parseComposer(input.body);
    if (parsed.kind === 'error') throw new BadRequestException(parsed.message);
    // Commit and publish the task first. Both calls are synchronous, so replay
    // can never see the referencing message before its durable task event.
    const body: MessageBody = parsed.kind === 'text' ? parsed : {
      kind: 'task', taskId: this.tasks.create({
        roomId: input.roomId, owner: input.author, ownerPrincipalId: input.authorPrincipalId ?? null,
        title: parsed.title, definitionOfDone: parsed.definitionOfDone,
        ...(parsed.agentId ? { agentId: parsed.agentId } : {}),
      }).id,
    };
    const event = this.bus.emitEvent(() => {
      const ts = new Date().toISOString();
      const id = randomUUID();
      if (parentId === id) throw new BadRequestException('Unknown parent');
      const message = this.database.db.insert(messages).values({
        id, roomId: input.roomId, author: input.author,
        authorPrincipalId: input.authorPrincipalId ?? null, body, createdAt: ts, parentId,
      }).returning().get();
      return { subject_id: message.id, room_id: message.roomId, ts, kind: 'message_created', payload: { message } };
    });
    if (event.kind !== 'message_created') throw new Error('Unexpected event kind');
    return event.payload.message;
  }

  /** Card for an uploaded file, so every member sees the same transcript row. */
  attachFile(room: string, author: string, fileId: string, authorPrincipalId?: string | null) {
    roomId(room);
    assertKnownRoom(this.database, room);
    const event = this.bus.emitEvent(() => {
      const ts = new Date().toISOString();
      const message = this.database.db.insert(messages).values({
        id: randomUUID(), roomId: room, author, authorPrincipalId: authorPrincipalId ?? null,
        body: { kind: 'file', fileId }, createdAt: ts, parentId: null,
      }).returning().get();
      return { subject_id: message.id, room_id: message.roomId, ts, kind: 'message_created', payload: { message } };
    });
    if (event.kind !== 'message_created') throw new Error('Unexpected event kind');
    return event.payload.message;
  }

  /** Card for an already-created task, so a spawned child shows in the transcript. */
  attachTask(room: string, author: string, taskId: string, authorPrincipalId?: string | null) {
    roomId(room);
    assertKnownRoom(this.database, room);
    this.tasks.get(taskId);
    const event = this.bus.emitEvent(() => {
      const ts = new Date().toISOString();
      const message = this.database.db.insert(messages).values({
        id: randomUUID(), roomId: room, author, authorPrincipalId: authorPrincipalId ?? null,
        body: { kind: 'task', taskId }, createdAt: ts, parentId: null,
      }).returning().get();
      return { subject_id: message.id, room_id: message.roomId, ts, kind: 'message_created', payload: { message } };
    });
    if (event.kind !== 'message_created') throw new Error('Unexpected event kind');
    return event.payload.message;
  }
}
