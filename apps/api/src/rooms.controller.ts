import { Body, Controller, Delete, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { loadAgents } from './agents';
import { actor, AuthService } from './auth';
import { field, roomId } from './field';
import { RoomAgentStore } from './room-agents';

@Controller('rooms')
export class RoomsController {
  constructor(
    @Inject(RoomAgentStore) private readonly agents: RoomAgentStore,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  @Get(':room/agents')
  list(@Param('room') roomParam: string, @Req() req: Request) {
    const room = roomId(roomParam);
    const membership = this.auth.membership(actor(req).id, room);
    return {
      agents: this.agents.list(room),
      catalog: loadAgents().map((agent) => ({ id: agent.id, name: agent.name })),
      role: membership.role,
    };
  }

  @Post(':room/agents')
  create(@Param('room') roomParam: string, @Body() body: unknown, @Req() req: Request) {
    const room = roomId(roomParam);
    const principal = actor(req);
    this.auth.requireOwner(principal.id, room);
    return this.agents.add(room, field(body, 'catalogId', 100), field(body, 'name', 100), principal.id);
  }

  @Delete(':room/agents/:id')
  remove(@Param('room') roomParam: string, @Param('id') id: string, @Req() req: Request) {
    const room = roomId(roomParam);
    this.auth.requireOwner(actor(req).id, room);
    return this.agents.remove(room, id);
  }
}
