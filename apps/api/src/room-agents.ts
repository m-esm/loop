import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { RoomAgent } from '@loop/types';
import { loadAgents, type AgentConfig } from './agents';
import { Database } from './database';
import { mentionName } from './field';
import { roomAgents, rooms } from './schema';

export function assertKnownRoom(database: Database, id: string) {
  const row = database.db.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, id)).get();
  if (!row) throw new BadRequestException('Unknown room');
}

export function listRoomAgents(database: Database, room: string): RoomAgent[] {
  return database.db.select().from(roomAgents).where(eq(roomAgents.roomId, room))
    .orderBy(asc(roomAgents.createdAt), asc(roomAgents.id)).all();
}

/** Register catalog entries in a room so a custom agents.json still has a mention. */
export function syncCatalogRoomAgents(database: Database, agents: AgentConfig[], room = 'default') {
  const ts = new Date().toISOString();
  const existing = listRoomAgents(database, room);
  const byCatalog = new Set(existing.map((row) => row.catalogId));
  const names = new Set(existing.map((row) => row.name));
  for (const agent of agents) {
    if (byCatalog.has(agent.id) || names.has(agent.id)) continue;
    database.db.insert(roomAgents).values({
      id: randomUUID(),
      roomId: room,
      catalogId: agent.id,
      name: agent.id,
      mandate: '',
      createdBy: 'catalog',
      createdAt: ts,
    }).run();
    byCatalog.add(agent.id);
    names.add(agent.id);
  }
}

@Injectable()
export class RoomAgentStore {
  constructor(@Inject(Database) private readonly database: Database) {}

  list(room: string): RoomAgent[] {
    assertKnownRoom(this.database, room);
    return listRoomAgents(this.database, room);
  }

  add(room: string, catalogId: string, name: string, createdBy: string): RoomAgent {
    assertKnownRoom(this.database, room);
    const mention = mentionName(name);
    const catalog = loadAgents();
    if (!catalog.some((agent) => agent.id === catalogId)) {
      const known = catalog.map((agent) => agent.id).join(', ') || '(none)';
      throw new BadRequestException(`Unknown catalog id ${catalogId}. Known: ${known}`);
    }
    const clash = this.database.db.select({ id: roomAgents.id }).from(roomAgents)
      .where(and(eq(roomAgents.roomId, room), eq(roomAgents.name, mention))).get();
    if (clash) throw new BadRequestException('An agent with this name already exists in the room');
    try {
      return this.database.db.insert(roomAgents).values({
        id: randomUUID(),
        roomId: room,
        catalogId,
        name: mention,
        mandate: '',
        createdBy,
        createdAt: new Date().toISOString(),
      }).returning().get();
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/unique/i.test(message)) throw new BadRequestException('An agent with this name already exists in the room');
      throw error;
    }
  }

  setMandate(room: string, id: string, mandate: string): RoomAgent {
    assertKnownRoom(this.database, room);
    const row = this.database.db.update(roomAgents)
      .set({ mandate })
      .where(and(eq(roomAgents.id, id), eq(roomAgents.roomId, room)))
      .returning().get();
    if (!row) throw new NotFoundException('Agent not found');
    return row;
  }

  remove(room: string, id: string): RoomAgent {
    assertKnownRoom(this.database, room);
    const row = this.database.db.delete(roomAgents)
      .where(and(eq(roomAgents.id, id), eq(roomAgents.roomId, room)))
      .returning().get();
    if (!row) throw new NotFoundException('Agent not found');
    return row;
  }
}
