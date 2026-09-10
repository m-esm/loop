import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { Database } from './database';
import { EventBus } from './bus';
import { TaskStore } from './task-store';
import { TasksController } from './tasks.controller';
import { StreamController } from './stream.controller';
import { MessageStore } from './message-store';
import { MessagesController } from './messages.controller';
import { TaskRunner } from './runner';
import { AuthService } from './auth';
import { AuthGuard } from './auth.guard';
import { AuthController } from './auth.controller';
import { HealthController } from './health.controller';
import { RoomAgentStore } from './room-agents';
import { RoomsController } from './rooms.controller';

@Module({
  providers: [
    Database, EventBus, TaskStore, MessageStore, TaskRunner, AuthService, RoomAgentStore,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  controllers: [
    TasksController, StreamController, MessagesController, AuthController, HealthController, RoomsController,
  ],
})
class AppModule {}

export async function createApp(logger: false | undefined = undefined) {
  const app = await NestFactory.create(AppModule, { logger });
  app.setGlobalPrefix('api');
  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? ['http://localhost:3000', 'http://127.0.0.1:3000'],
    credentials: true,
  });
  return app;
}
