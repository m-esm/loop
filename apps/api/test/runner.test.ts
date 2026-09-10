import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as defer } from 'node:timers';
import type { TaskEvent } from '@loop/types';
import { Database } from '../src/database';
import { EventBus } from '../src/bus';
import { TaskStore } from '../src/task-store';
import { TaskRunner } from '../src/runner';
import { MessageStore } from '../src/message-store';

const input = { title: 'Echo me', owner: 'Human', definitionOfDone: 'proof' };
let database: Database;
let bus: EventBus;
let store: TaskStore;
let runner: TaskRunner;
let dir: string | undefined;

async function waitFor(check: () => boolean, ms = 5000) {
  const start = Date.now();
  while (!check() && Date.now() - start < ms) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(check(), 'timed out waiting for runner');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'loop-runner-'));
  process.env.DATABASE_PATH = join(dir, 'loop.sqlite');
  delete process.env.LOOP_RUNNER;
  database = new Database();
  bus = new EventBus(database);
  store = new TaskStore(database, bus);
  runner = new TaskRunner(store, bus);
});

afterEach(async () => {
  runner.stop();
  await new Promise((resolve) => defer(resolve));
  database.onModuleDestroy();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('echo runner claims a queued task and finishes with log and result', async () => {
  const task = store.create(input);
  assert.equal(task.status, 'queued');
  runner.start();
  await waitFor(() => store.get(task.id).status === 'done');
  const done = store.get(task.id);
  assert.equal(done.status, 'done');
  assert.equal(done.result, 'Echo: Echo me');
  assert.equal(done.error, null);
  assert.ok(done.log.includes('Echo started'));
  assert.ok(done.log.includes('Echo finished'));
  const kinds = bus.since(0).filter((event) => event.subject_id === task.id).map((event) => event.kind);
  assert.equal(kinds[0], 'task_created');
  assert.ok(kinds.includes('task_status_changed'));
  assert.ok(kinds.includes('task_progress'));
});

test('FAIL: title lands on failed with error set', async () => {
  const task = store.create({ ...input, title: 'FAIL: boom' });
  runner.start();
  await waitFor(() => store.get(task.id).status === 'failed');
  const failed = store.get(task.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'boom');
  assert.equal(failed.result, null);
  assert.ok(failed.log.includes('Echo failed'));
});

test('boot reclaim fails a running row through an event, not a silent update', () => {
  const task = store.create(input);
  store.updateStatus(task.id, 'running');
  const before = bus.latestId();
  const received: TaskEvent[] = [];
  bus.subscribe((event) => received.push(event));
  runner.start();
  const lost = store.get(task.id);
  assert.equal(lost.status, 'failed');
  assert.equal(lost.error, 'runner lost');
  assert.equal(bus.latestId(), before + 1);
  assert.equal(received.length, 1);
  assert.equal(received[0].kind, 'task_status_changed');
  assert.equal(received[0].payload.task.error, 'runner lost');
});

test('reclaim on a new API process against the same file emits runner lost', () => {
  const task = store.create(input);
  store.updateStatus(task.id, 'running');
  const path = process.env.DATABASE_PATH!;
  runner.stop();
  database.onModuleDestroy();
  process.env.DATABASE_PATH = path;
  database = new Database();
  bus = new EventBus(database);
  store = new TaskStore(database, bus);
  runner = new TaskRunner(store, bus);
  const before = bus.latestId();
  runner.start();
  const lost = store.get(task.id);
  assert.equal(lost.status, 'failed');
  assert.equal(lost.error, 'runner lost');
  const added = bus.since(before);
  assert.equal(added.length, 1);
  assert.equal(added[0].kind, 'task_status_changed');
});

test('claim is deferred so a /task message stays task_created then message_created', async () => {
  const messages = new MessageStore(database, bus, store);
  const kinds: string[] = [];
  bus.subscribe((event) => kinds.push(event.kind));
  runner.start();
  const message = messages.create({ roomId: 'default', author: 'Human', body: '/task Echo me :: proof' });
  assert.deepEqual(kinds, ['task_created', 'message_created']);
  await new Promise((resolve) => defer(resolve));
  await new Promise((resolve) => defer(resolve));
  await waitFor(() => kinds.includes('task_status_changed'));
  const createdAt = kinds.indexOf('task_created');
  const messageAt = kinds.indexOf('message_created');
  const runningAt = kinds.indexOf('task_status_changed');
  assert.ok(createdAt < messageAt);
  assert.ok(messageAt < runningAt);
  if (message.body.kind !== 'task') throw new Error('expected task card');
  const taskId = message.body.taskId;
  await waitFor(() => store.get(taskId).status === 'done');
});
