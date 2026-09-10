import { BadRequestException, Body, Controller, Get, Inject, Param, Patch, Post } from '@nestjs/common';
import { isTaskStatus } from '@loop/types';
import { TaskStore } from './task-store';
import { field } from './field';

@Controller('tasks')
export class TasksController {
  constructor(@Inject(TaskStore) private readonly store: TaskStore) {}
  @Get() list() { return this.store.list(); }
  @Get(':id') get(@Param('id') id: string) { return this.store.get(id); }
  @Post() create(@Body() body: unknown) {
    return this.store.create({
      title: field(body, 'title', 200), owner: field(body, 'owner', 100),
      definitionOfDone: field(body, 'definitionOfDone', 8000),
    });
  }
  @Patch(':id/status') update(@Param('id') id: string, @Body() body: unknown) {
    const status = body && typeof body === 'object' ? (body as Record<string, unknown>).status : undefined;
    if (!isTaskStatus(status)) throw new BadRequestException('Invalid task status');
    return this.store.updateStatus(id, status);
  }
}
