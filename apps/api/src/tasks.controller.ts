import { BadRequestException, Body, Controller, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { isTaskStatus, isTaskVerdict } from '@loop/types';
import { actor, AuthService, requireHuman } from './auth';
import { TaskStore } from './task-store';
import { field, optionalField, roomId } from './field';

@Controller('tasks')
export class TasksController {
  constructor(
    @Inject(TaskStore) private readonly store: TaskStore,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  private rooms(req: Request) {
    return this.auth.roomIds(actor(req).id);
  }

  private visible(req: Request, id: string) {
    const task = this.store.get(id);
    if (!this.rooms(req).includes(task.roomId)) throw new NotFoundException('Task not found');
    return task;
  }

  @Get() list(@Req() req: Request) { return this.store.list(this.rooms(req)); }
  @Get(':id') get(@Param('id') id: string, @Req() req: Request) { return this.visible(req, id); }
  @Post() create(@Body() body: unknown, @Req() req: Request) {
    const principal = actor(req);
    const agentId = optionalField(body, 'agentId', 100);
    const room = roomId(optionalField(body, 'roomId', 100) ?? 'default');
    this.auth.membership(principal.id, room);
    return this.store.create({
      title: field(body, 'title', 200),
      owner: principal.displayName,
      ownerPrincipalId: principal.id,
      definitionOfDone: field(body, 'definitionOfDone', 8000),
      roomId: room,
      ...(agentId ? { agentId } : {}),
    });
  }
  @Patch(':id/status') update(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    this.visible(req, id);
    const status = body && typeof body === 'object' ? (body as Record<string, unknown>).status : undefined;
    if (!isTaskStatus(status)) throw new BadRequestException('Invalid task status');
    return this.store.updateStatus(id, status);
  }
  @Post(':id/answer') @HttpCode(200) answer(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    this.visible(req, id);
    const principal = requireHuman(req);
    return this.store.answer(id, field(body, 'answer', 8000), principal.displayName, principal.id);
  }
  @Post(':id/review') @HttpCode(200) review(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    this.visible(req, id);
    const principal = requireHuman(req);
    const verdict = body && typeof body === 'object' ? (body as Record<string, unknown>).verdict : undefined;
    if (!isTaskVerdict(verdict)) throw new BadRequestException('Invalid verdict');
    return this.store.review(id, verdict, optionalField(body, 'note', 8000), principal.displayName, principal.id);
  }
  @Post(':id/decide') @HttpCode(200) decide(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    this.visible(req, id);
    const principal = requireHuman(req);
    return this.store.decide(id, field(body, 'choice', 8000), principal.displayName, principal.id);
  }
}
