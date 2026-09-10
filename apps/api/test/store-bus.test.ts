import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_STATUS, TASK_STATUSES, type TaskEvent } from '@loop/types';
import { Database } from '../src/database';
import { EventBus } from '../src/bus';
import { TaskStore, capLog, LOG_MAX_BYTES, LOG_MAX_CHARS, LOG_MAX_LINES } from '../src/task-store';

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

test('two overlapping claims yield one running task and the loser inserts zero events', () => {
  const task = store.create(input);
  const before = bus.latestId();
  const first = store.claim(task.id, 'echo');
  const second = store.claim(task.id, 'echo');
  assert.equal(first?.status, 'running');
  assert.equal(first?.claimedBy, 'echo');
  assert.ok(first?.runId);
  assert.equal(second, null);
  assert.equal(store.get(task.id).status, 'running');
  const added = bus.since(before);
  assert.deepEqual(added.map((event) => event.kind), ['task_status_changed']);
  if (added[0].kind !== 'task_status_changed') throw new Error('expected status change');
  assert.equal(added[0].payload.task.status, 'running');
  const rows = database.sqlite.prepare('SELECT kind FROM events WHERE subject_id = ? ORDER BY id').all(task.id) as { kind: string }[];
  assert.deepEqual(rows.map((row) => row.kind), ['task_created', 'task_status_changed']);
});

test('a lost claim, fenced progress, and fenced finish throw inside mutate and publish nothing', () => {
  const task = store.create(input);
  const before = bus.latestId();
  assert.throws(() => store.claim('missing', 'echo'), /Task not found/);
  assert.equal(store.claim(task.id, 'echo')!.status, 'running');
  const afterClaim = bus.latestId();
  assert.equal(afterClaim, before + 1);
  assert.throws(() => store.progress(task.id, 'other-run', 'nope'));
  assert.equal(bus.latestId(), afterClaim);
  assert.equal(store.finish(task.id, 'other-run', { status: 'done', result: 'nope' }), null);
  assert.equal(bus.latestId(), afterClaim);
  assert.equal(store.get(task.id).status, 'running');
});

test('fifty log appends compact to one task_progress row and stay within caps', () => {
  const task = store.create(input);
  const claimed = store.claim(task.id, 'echo')!;
  for (let i = 0; i < 50; i++) store.progress(claimed.id, claimed.runId!, `line ${i}`);
  const count = database.sqlite.prepare(
    "SELECT count(*) AS n FROM events WHERE kind = 'task_progress' AND subject_id = ?",
  ).get(task.id) as { n: number };
  assert.equal(count.n, 1);
  const logged = store.get(task.id);
  assert.equal(logged.log.length, 50);
  assert.equal(logged.log[0], 'line 0');
  assert.equal(logged.log[49], 'line 49');
  const huge = store.progress(claimed.id, claimed.runId!, [
    'x'.repeat(LOG_MAX_CHARS + 20),
    ...Array.from({ length: LOG_MAX_LINES + 10 }, (_, i) => `keep ${i}`),
  ]);
  assert.ok(huge.log.length <= LOG_MAX_LINES);
  assert.ok(huge.log.every((line) => line.length <= LOG_MAX_CHARS));
  assert.ok(huge.log.reduce((sum, line) => sum + Buffer.byteLength(line), 0) <= LOG_MAX_BYTES);
  assert.equal(capLog(['a'.repeat(10)]).join(), 'aaaaaaaaaa');
  const recount = database.sqlite.prepare(
    "SELECT count(*) AS n FROM events WHERE kind = 'task_progress' AND subject_id = ?",
  ).get(task.id) as { n: number };
  assert.equal(recount.n, 1);
});

test('replay of since=0 matches GET task and never goes done then running', () => {
  const task = store.create(input);
  const claimed = store.claim(task.id, 'echo')!;
  store.progress(claimed.id, claimed.runId!, 'one');
  store.progress(claimed.id, claimed.runId!, 'two');
  store.finish(claimed.id, claimed.runId!, { status: 'done', result: 'ok' });
  const live = store.get(task.id);
  let seenDone = false;
  let folded = live;
  for (const event of bus.since(0)) {
    if (event.kind === 'message_created') continue;
    const row = event.payload.task;
    if (row.id !== task.id) continue;
    if (seenDone && row.status === 'running') assert.fail('done then running');
    if (row.status === 'done') seenDone = true;
    folded = row;
  }
  assert.equal(folded.status, live.status);
  assert.deepEqual(folded.log, live.log);
  assert.equal(folded.result, live.result);
  assert.equal(folded.error, live.error);
  assert.equal(live.status, 'done');
  assert.equal(live.result, 'ok');
});
