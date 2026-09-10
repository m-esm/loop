import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import type { EventKind, MessageBody, TaskEvent, TaskProposal, TaskStatus, TaskVerdict } from '@loop/types';

export const rooms = sqliteTable('rooms', { id: text('id').primaryKey() });

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  roomId: text('room_id').notNull().default('default').references(() => rooms.id),
  title: text('title').notNull(),
  owner: text('owner').notNull(),
  agentId: text('agent_id'),
  definitionOfDone: text('definition_of_done').notNull(),
  status: text('status').$type<TaskStatus>().notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  claimedBy: text('claimed_by'),
  runId: text('run_id'),
  log: text('log', { mode: 'json' }).$type<string[]>().notNull().$defaultFn(() => []),
  result: text('result'),
  error: text('error'),
  question: text('question'),
  answer: text('answer'),
  answeredBy: text('answered_by'),
  verdict: text('verdict').$type<TaskVerdict>(),
  verdictNote: text('verdict_note'),
  verdictBy: text('verdict_by'),
  proposal: text('proposal', { mode: 'json' }).$type<TaskProposal>(),
  proposalChoice: text('proposal_choice'),
  proposalBy: text('proposal_by'),
  parentTaskId: text('parent_task_id'),
});
export const events = sqliteTable('events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  subject_id: text('subject_id'),
  room_id: text('room_id').notNull().references(() => rooms.id),
  ts: text('ts').notNull(),
  kind: text('kind').$type<EventKind>().notNull(),
  payload: text('payload', { mode: 'json' }).$type<TaskEvent['payload']>().notNull(),
});
export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  roomId: text('room_id').notNull().references(() => rooms.id),
  author: text('author').notNull(),
  body: text('body', { mode: 'json' }).$type<MessageBody>().notNull(),
  createdAt: text('created_at').notNull(),
});
