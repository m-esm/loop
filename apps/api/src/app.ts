import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Database } from './database';
import { EventBus } from './bus';
import { TaskStore } from './task-store';
import { TasksController } from './tasks.controller';
import { StreamController } from './stream.controller';
import { MessageStore } from './message-store';
import { MessagesController } from './messages.controller';

@Module({ providers: [Database, EventBus, TaskStore, MessageStore], controllers: [TasksController, StreamController, MessagesController] })
class AppModule {}

export async function createApp(logger: false | undefined = undefined) {
  const app = await NestFactory.create(AppModule, { logger });
  app.setGlobalPrefix('api');
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? ['http://localhost:3000', 'http://127.0.0.1:3000'] });
  return app;
}
