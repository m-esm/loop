import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { loadAgents } from './agents';
import { actor, AuthService } from './auth';
import { field, roomId, textField } from './field';
import { RoomAgentStore } from './room-agents';

@Controller('rooms')
export class RoomsController {
  constructor(
    @Inject(RoomAgentStore) private readonly agents: RoomAgentStore,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  @Get()
  listRooms(@Req() req: Request) {
    return { rooms: this.auth.listRooms(actor(req).id) };
  }

  @Post()
  createRoom(@Body() body: unknown, @Req() req: Request) {
    return this.auth.createRoom(actor(req).id, field(body, 'name', 100));
  }

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

  @Get(':room')
  getRoom(@Param('room') roomParam: string, @Req() req: Request) {
    return this.auth.getRoom(actor(req).id, roomId(roomParam));
  }

  @Patch(':room/steer')
  steer(@Param('room') roomParam: string, @Body() body: unknown, @Req() req: Request) {
    return this.auth.steerRoom(actor(req).id, roomId(roomParam), body);
  }

  @Post(':room/agents')
  create(@Param('room') roomParam: string, @Body() body: unknown, @Req() req: Request) {
    const room = roomId(roomParam);
    const principal = actor(req);
    this.auth.requireOwner(principal.id, room);
    return this.agents.add(room, field(body, 'catalogId', 100), field(body, 'name', 100), principal.id);
  }

  @Patch(':room/agents/:id')
  setMandate(@Param('room') roomParam: string, @Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    const room = roomId(roomParam);
    this.auth.requireOwner(actor(req).id, room);
    return this.agents.setMandate(room, id, textField(body, 'mandate', 2000));
  }

  @Delete(':room/agents/:id')
  remove(@Param('room') roomParam: string, @Param('id') id: string, @Req() req: Request) {
    const room = roomId(roomParam);
    this.auth.requireOwner(actor(req).id, room);
    return this.agents.remove(room, id);
  }

  @Get(':room/members')
  members(@Param('room') roomParam: string, @Req() req: Request) {
    return this.auth.listMembers(actor(req).id, roomId(roomParam));
  }

  @Get(':room/invites')
  listInvites(@Param('room') roomParam: string, @Req() req: Request) {
    return { invites: this.auth.listInvites(actor(req).id, roomId(roomParam)) };
  }

  @Post(':room/invites')
  createInvite(@Param('room') roomParam: string, @Body() body: unknown, @Req() req: Request) {
    return this.auth.createInvite(
      actor(req).id,
      roomId(roomParam),
      field(body, 'email', 254),
      field(body, 'role', 20),
    );
  }

  @Delete(':room/invites/:id')
  revokeInvite(@Param('room') roomParam: string, @Param('id') id: string, @Req() req: Request) {
    return this.auth.revokeInvite(actor(req).id, roomId(roomParam), id);
  }
}
