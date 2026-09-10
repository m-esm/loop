import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_STATUS, TASK_STATUSES, type TaskEvent } from '@loop/types';
import { Database } from '../src/database';
import { EventBus } from '../src/bus';
import { TaskStore } from '../src/task-store';

let database: Database;
let bus: EventBus;
let store: TaskStore;
const input = { title: 'Build Loop', owner: 'Human', definitionOfDone: 'Live events reach another tab' };
beforeEach(() => {
  process.env.DATABASE_PATH = ':memory:';
  database = new Database();
  bus = new EventBus(database);
  store = new TaskStore(database, bus);
});
afterEach(() => database.onModuleDestroy());

test('task store creates, lists, gets and updates every shared status', () => {
  const task = store.create(input);
  assert.equal(task.status, INITIAL_STATUS);
  assert.deepEqual(store.get(task.id), task);
  for (const status of TASK_STATUSES) assert.equal(store.updateStatus(task.id, status).status, status);
  assert.equal(store.list().tasks.length, 1);
  assert.equal(store.list().since, 1 + TASK_STATUSES.length);
  assert.throws(() => store.get('missing'), /Task not found/);
  assert.throws(() => store.updateStatus('missing', INITIAL_STATUS), /Task not found/);
});

test('service event reaches subscriber and persistence with the same id and payload', () => {
  const received: TaskEvent[] = [];
  const unsubscribe = bus.subscribe((event) => {
    assert.deepEqual(bus.since(event.id - 1)[0], event);
    assert.notEqual(event.kind, 'message_created');
    if (event.kind !== 'message_created') assert.deepEqual(store.get(event.subject_id!), event.payload.task);
    received.push(event);
  });
  const task = store.create(input);
  store.updateStatus(task.id, TASK_STATUSES.at(-1)!);
  assert.deepEqual(received, bus.since(0));
  assert.equal(received.length, 2);
  unsubscribe();
  store.create(input);
  assert.equal(received.length, 2);
});

test('failed event insert rolls back the task and never publishes', () => {
  const received: TaskEvent[] = [];
  bus.subscribe((event) => received.push(event));
  database.sqlite.exec("CREATE TRIGGER reject_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'rejected'); END");
  assert.throws(() => store.create(input), /rejected/);
  assert.equal(store.list().tasks.length, 0);
  assert.equal(received.length, 0);
});

test('a broken subscriber does not block other subscribers or fail the mutation', () => {
  bus.subscribe(() => { throw new Error('broken'); });
  const received: TaskEvent[] = [];
  bus.subscribe((event) => received.push(event));
  const task = store.create(input);
  assert.equal(received[0].subject_id, task.id);
});
