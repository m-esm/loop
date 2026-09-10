import { Body, Controller, Get, Inject, Post, Query } from '@nestjs/common';
import { field, roomId } from './field';
import { MessageStore } from './message-store';

@Controller('messages')
export class MessagesController {
  constructor(@Inject(MessageStore) private readonly store: MessageStore) {}
  @Get() list(@Query('roomId') room: unknown) { return this.store.list(roomId(room)); }
  @Post() create(@Body() body: unknown) {
    return this.store.create({
      roomId: roomId(field(body, 'roomId', 100)),
      author: field(body, 'author', 100), body: field(body, 'body', 8000),
    });
  }
}
