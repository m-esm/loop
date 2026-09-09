import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import type { EventKind, TaskEvent, TaskStatus } from '@loop/types';

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  owner: text('owner').notNull(),
  definitionOfDone: text('definition_of_done').notNull(),
  status: text('status').$type<TaskStatus>().notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
export const events = sqliteTable('events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  task_id: text('task_id').notNull().references(() => tasks.id),
  ts: text('ts').notNull(),
  kind: text('kind').$type<EventKind>().notNull(),
  payload: text('payload', { mode: 'json' }).$type<TaskEvent['payload']>().notNull(),
});
