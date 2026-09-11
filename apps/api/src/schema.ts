import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import type { EventKind, MessageBody, TaskEvent, TaskProposal, TaskStatus, TaskVerdict } from '@loop/types';

export const rooms = sqliteTable('rooms', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
});

export const principals = sqliteTable('principals', {
  id: text('id').primaryKey(),
  kind: text('kind').$type<'human' | 'agent'>().notNull(),
  displayName: text('display_name').notNull(),
  disabledAt: text('disabled_at'),
  createdAt: text('created_at').notNull(),
});

export const credentials = sqliteTable('credentials', {
  principalId: text('principal_id').primaryKey().references(() => principals.id),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: text('created_at').notNull(),
});

export const sessions = sqliteTable('sessions', {
  tokenHash: text('token_hash').primaryKey(),
  principalId: text('principal_id').notNull().references(() => principals.id),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  revokedAt: text('revoked_at'),
});

export const roomMembers = sqliteTable('room_members', {
  roomId: text('room_id').notNull().references(() => rooms.id),
  principalId: text('principal_id').notNull().references(() => principals.id),
  role: text('role').$type<'owner' | 'member'>().notNull(),
});

export const invites = sqliteTable('invites', {
  id: text('id').primaryKey(),
  roomId: text('room_id').notNull().references(() => rooms.id),
  email: text('email').notNull(),
  role: text('role').$type<'owner' | 'member'>().notNull(),
  tokenHash: text('token_hash').notNull(),
  invitedBy: text('invited_by').notNull().references(() => principals.id),
  createdAt: text('created_at').notNull(),
  acceptedAt: text('accepted_at'),
  expiresAt: text('expires_at').notNull(),
});

export const roomAgents = sqliteTable('room_agents', {
  id: text('id').primaryKey(),
  roomId: text('room_id').notNull().references(() => rooms.id),
  catalogId: text('catalog_id').notNull(),
  name: text('name').notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at').notNull(),
});

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  roomId: text('room_id').notNull().default('default').references(() => rooms.id),
  title: text('title').notNull(),
  owner: text('owner').notNull(),
  ownerPrincipalId: text('owner_principal_id').references(() => principals.id),
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
  answeredByPrincipalId: text('answered_by_principal_id').references(() => principals.id),
  verdict: text('verdict').$type<TaskVerdict>(),
  verdictNote: text('verdict_note'),
  verdictBy: text('verdict_by'),
  verdictByPrincipalId: text('verdict_by_principal_id').references(() => principals.id),
  proposal: text('proposal', { mode: 'json' }).$type<TaskProposal>(),
  proposalChoice: text('proposal_choice'),
  proposalBy: text('proposal_by'),
  proposalByPrincipalId: text('proposal_by_principal_id').references(() => principals.id),
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
  authorPrincipalId: text('author_principal_id').references(() => principals.id),
  body: text('body', { mode: 'json' }).$type<MessageBody>().notNull(),
  createdAt: text('created_at').notNull(),
  parentId: text('parent_id'),
});
export const files = sqliteTable('files', {
  id: text('id').primaryKey(),
  roomId: text('room_id').notNull().references(() => rooms.id),
  name: text('name').notNull(),
  size: integer('size').notNull(),
  contentType: text('content_type').notNull(),
  sha256: text('sha256').notNull(),
  storedPath: text('stored_path').notNull(),
  uploadedBy: text('uploaded_by').notNull(),
  createdAt: text('created_at').notNull(),
});
