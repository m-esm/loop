import { Body, Controller, ForbiddenException, Get, Inject, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { actor, AuthService } from './auth';
import { field, roomId } from './field';
import { MessageStore } from './message-store';

@Controller('messages')
export class MessagesController {
  constructor(
    @Inject(MessageStore) private readonly store: MessageStore,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  private inRoom(req: Request, room: string) {
    this.auth.assertRoom(room);
    if (!this.auth.roomIds(actor(req).id).includes(room)) {
      throw new ForbiddenException('Not a member of this room');
    }
  }

  @Get() list(@Query('roomId') room: unknown, @Req() req: Request) {
    const id = roomId(room);
    this.inRoom(req, id);
    return this.store.list(id);
  }
  @Post() create(@Body() body: unknown, @Req() req: Request) {
    const principal = actor(req);
    const room = roomId(field(body, 'roomId', 100));
    this.inRoom(req, room);
    const rawParent = body && typeof body === 'object' ? (body as Record<string, unknown>).parentId : undefined;
    const parentId = rawParent === undefined || rawParent === null ? null : field(body, 'parentId', 100);
    return this.store.create({
      roomId: room,
      author: principal.displayName,
      authorPrincipalId: principal.id,
      body: field(body, 'body', 8000),
      parentId,
    });
  }
}
