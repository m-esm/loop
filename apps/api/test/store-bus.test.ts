import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_STATUS, TASK_STATUSES, type TaskEvent } from '@loop/types';
import { Database } from '../src/database';
import { EventBus } from '../src/bus';
import { tasks } from '../src/schema';
import { TaskStore, assertParentLink, capLog, LOG_MAX_BYTES, LOG_MAX_CHARS, LOG_MAX_LINES } from '../src/task-store';

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

test('ask fences on a stale run_id and emits no event', () => {
  const task = store.create(input);
  const claimed = store.claim(task.id, 'echo')!;
  const before = bus.latestId();
  assert.throws(() => store.ask(task.id, 'other-run', 'what colour'));
  assert.equal(bus.latestId(), before);
  assert.equal(store.get(task.id).status, 'running');
  const asked = store.ask(claimed.id, claimed.runId!, 'what colour');
  assert.equal(asked.status, 'needs_input');
  assert.equal(asked.question, 'what colour');
  const added = bus.since(before);
  assert.deepEqual(added.map((event) => event.kind), ['task_status_changed']);
  if (added[0].kind !== 'task_status_changed') throw new Error('expected status change');
  assert.equal(added[0].payload.previousStatus, 'running');
  assert.equal(added[0].payload.task.status, 'needs_input');
});

test('answer on a task not in needs_input is rejected and writes nothing', () => {
  const task = store.create(input);
  const before = bus.latestId();
  assert.throws(() => store.answer(task.id, 'blue', 'Human'), /not waiting for an answer/);
  assert.equal(bus.latestId(), before);
  assert.equal(store.get(task.id).status, INITIAL_STATUS);
  assert.throws(() => store.answer('missing', 'blue', 'Human'), /Task not found/);
});

test('answer flips needs_input to queued and preserves the answer', () => {
  const task = store.create(input);
  const claimed = store.claim(task.id, 'echo')!;
  store.ask(claimed.id, claimed.runId!, 'what colour');
  const before = bus.latestId();
  const answered = store.answer(task.id, 'blue', 'Moshe');
  assert.equal(answered.status, INITIAL_STATUS);
  assert.equal(answered.answer, 'blue');
  assert.equal(answered.answeredBy, 'Moshe');
  assert.equal(answered.question, 'what colour');
  const added = bus.since(before);
  assert.deepEqual(added.map((event) => event.kind), ['task_status_changed']);
  if (added[0].kind !== 'task_status_changed') throw new Error('expected status change');
  assert.equal(added[0].payload.previousStatus, 'needs_input');
  assert.throws(() => store.answer(task.id, 'green', 'Moshe'), /not waiting for an answer/);
  assert.equal(bus.latestId(), before + 1);
  assert.equal(store.get(task.id).answer, 'blue');
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

test('accept leaves status and run fields alone', () => {
  const task = store.create(input);
  const claimed = store.claim(task.id, 'echo')!;
  store.finish(claimed.id, claimed.runId!, { status: 'done', result: 'ok' });
  const before = bus.latestId();
  const accepted = store.review(task.id, 'accepted', undefined, 'Moshe');
  assert.equal(accepted.status, 'done');
  assert.equal(accepted.result, 'ok');
  assert.equal(accepted.runId, claimed.runId);
  assert.equal(accepted.claimedBy, 'echo');
  assert.equal(accepted.error, null);
  assert.equal(accepted.verdict, 'accepted');
  assert.equal(accepted.verdictNote, null);
  assert.equal(accepted.verdictBy, 'Moshe');
  const added = bus.since(before);
  assert.deepEqual(added.map((event) => event.kind), ['task_status_changed']);
  if (added[0].kind !== 'task_status_changed') throw new Error('expected status change');
  assert.equal(added[0].payload.previousStatus, 'done');
  assert.equal(added[0].payload.task.status, 'done');
});

test('reject requeues and clears runId, result, and error', () => {
  const task = store.create({ ...input, agentId: 'echo' });
  const claimed = store.claim(task.id, 'echo')!;
  store.finish(claimed.id, claimed.runId!, { status: 'failed', error: 'boom' });
  const before = bus.latestId();
  const rejected = store.review(task.id, 'rejected', 'try again', 'Moshe');
  assert.equal(rejected.status, INITIAL_STATUS);
  assert.equal(rejected.runId, null);
  assert.equal(rejected.claimedBy, null);
  assert.equal(rejected.result, null);
  assert.equal(rejected.error, null);
  assert.equal(rejected.agentId, 'echo');
  assert.equal(rejected.verdict, 'rejected');
  assert.equal(rejected.verdictNote, 'try again');
  assert.equal(rejected.verdictBy, 'Moshe');
  const added = bus.since(before);
  assert.deepEqual(added.map((event) => event.kind), ['task_status_changed']);
  if (added[0].kind !== 'task_status_changed') throw new Error('expected status change');
  assert.equal(added[0].payload.previousStatus, 'failed');
  assert.equal(added[0].payload.task.status, INITIAL_STATUS);
  assert.throws(() => store.review(task.id, 'accepted', undefined, 'Moshe'), /not finished/);
  assert.equal(bus.latestId(), before + 1);
});

test('reviewing an active task throws and writes nothing', () => {
  const task = store.create(input);
  const before = bus.latestId();
  assert.throws(() => store.review(task.id, 'accepted', undefined, 'Moshe'), /not finished/);
  const claimed = store.claim(task.id, 'echo')!;
  assert.throws(() => store.review(task.id, 'rejected', 'nope', 'Moshe'), /not finished/);
  assert.equal(bus.latestId(), before + 1);
  assert.equal(store.get(task.id).status, 'running');
  assert.equal(store.get(task.id).verdict, null);
  store.finish(claimed.id, claimed.runId!, { status: 'done', result: 'ok' });
});

test('an invalid verdict string throws and writes nothing', () => {
  const task = store.create(input);
  const claimed = store.claim(task.id, 'echo')!;
  store.finish(claimed.id, claimed.runId!, { status: 'done', result: 'ok' });
  const before = bus.latestId();
  assert.throws(() => store.review(task.id, 'maybe', undefined, 'Moshe'), /Invalid verdict/);
  assert.throws(() => store.review(task.id, '__proto__', undefined, 'Moshe'), /Invalid verdict/);
  assert.equal(bus.latestId(), before);
  assert.equal(store.get(task.id).status, 'done');
  assert.equal(store.get(task.id).verdict, null);
  assert.throws(() => store.review('missing', 'accepted', undefined, 'Moshe'), /Task not found/);
});

const proposal = {
  question: 'Which store?',
  options: ['SQLite', 'Postgres'],
  pick: 'SQLite',
  why: 'one file, no service',
};

test('propose fences on a stale run_id and parks needs_input', () => {
  const task = store.create(input);
  const claimed = store.claim(task.id, 'echo')!;
  const before = bus.latestId();
  assert.throws(() => store.propose(task.id, 'other-run', proposal));
  assert.equal(bus.latestId(), before);
  assert.equal(store.get(task.id).status, 'running');
  const parked = store.propose(claimed.id, claimed.runId!, proposal);
  assert.equal(parked.status, 'needs_input');
  assert.deepEqual(parked.proposal, proposal);
  assert.equal(parked.proposalChoice, null);
  const added = bus.since(before);
  assert.deepEqual(added.map((event) => event.kind), ['task_status_changed']);
  if (added[0].kind !== 'task_status_changed') throw new Error('expected status change');
  assert.equal(added[0].payload.previousStatus, 'running');
  assert.equal(added[0].payload.task.status, 'needs_input');
});

test('decide records a proposal option and discuss, and rejects an unknown choice', () => {
  const task = store.create(input);
  const claimed = store.claim(task.id, 'echo')!;
  store.propose(claimed.id, claimed.runId!, proposal);
  const before = bus.latestId();
  assert.throws(() => store.decide(task.id, 'MySQL', 'Moshe'), /proposal options, discuss, or reject/);
  assert.equal(bus.latestId(), before);
  assert.equal(store.get(task.id).status, 'needs_input');
  const decided = store.decide(task.id, 'Postgres', 'Moshe');
  assert.equal(decided.status, INITIAL_STATUS);
  assert.equal(decided.proposalChoice, 'Postgres');
  assert.equal(decided.proposalBy, 'Moshe');
  const added = bus.since(before);
  assert.deepEqual(added.map((event) => event.kind), ['task_status_changed']);
  if (added[0].kind !== 'task_status_changed') throw new Error('expected status change');
  assert.equal(added[0].payload.previousStatus, 'needs_input');
  assert.throws(() => store.decide(task.id, 'SQLite', 'Moshe'), /not waiting for a decision/);
  const other = store.create({ ...input, title: 'Talk it through' });
  const otherClaim = store.claim(other.id, 'echo')!;
  store.propose(otherClaim.id, otherClaim.runId!, proposal);
  const discussed = store.decide(other.id, 'discuss', 'Moshe');
  assert.equal(discussed.proposalChoice, 'discuss');
  assert.equal(discussed.status, INITIAL_STATUS);
  assert.throws(() => store.decide('missing', 'SQLite', 'Moshe'), /Task not found/);
});

test('reject fails the task, keeps the proposal, and does not requeue', () => {
  const task = store.create(input);
  const claimed = store.claim(task.id, 'echo')!;
  store.propose(claimed.id, claimed.runId!, proposal);
  const before = bus.latestId();
  const rejected = store.decide(task.id, 'reject', 'Moshe');
  assert.equal(rejected.status, 'failed');
  assert.equal(rejected.error, 'Proposal rejected by Moshe: SQLite');
  assert.equal(rejected.proposalChoice, 'reject');
  assert.equal(rejected.proposalBy, 'Moshe');
  assert.deepEqual(rejected.proposal, proposal);
  assert.equal(rejected.runId, claimed.runId);
  assert.equal(rejected.claimedBy, 'echo');
  assert.equal(rejected.result, null);
  const added = bus.since(before);
  assert.deepEqual(added.map((event) => event.kind), ['task_status_changed']);
  if (added[0].kind !== 'task_status_changed') throw new Error('expected status change');
  assert.equal(added[0].payload.previousStatus, 'needs_input');
  assert.equal(added[0].payload.task.status, 'failed');
  assert.equal(store.claim(task.id, 'echo'), null);
  const after = store.get(task.id);
  assert.equal(after.status, 'failed');
  assert.equal(after.runId, claimed.runId);
  assert.equal(after.claimedBy, 'echo');
  assert.equal(after.result, null);
  assert.equal(after.proposalChoice, 'reject');
  assert.deepEqual(after.proposal, proposal);
  assert.equal(bus.latestId(), before + 1);
});

test('create validates parent existence, same room, and self-parent', () => {
  const parent = store.create(input);
  assert.equal(parent.parentTaskId, null);
  const child = store.create({ ...input, title: 'Child', parentTaskId: parent.id });
  assert.equal(child.parentTaskId, parent.id);
  assert.equal(child.roomId, parent.roomId);
  assert.throws(() => store.create({ ...input, title: 'Missing', parentTaskId: 'no-such-task' }), /Parent task not found/);
  assert.throws(() => assertParentLink(child.id, child.id), /A task may not be its own parent/);
  assert.doesNotThrow(() => assertParentLink(child.id, parent.id));
  database.sqlite.exec("INSERT INTO rooms (id) VALUES ('other')");
  const ts = new Date().toISOString();
  database.db.insert(tasks).values({
    id: 'other-task', roomId: 'other', title: 'Elsewhere', owner: 'Human', definitionOfDone: 'x',
    status: INITIAL_STATUS, createdAt: ts, updatedAt: ts, log: [],
  }).run();
  assert.throws(
    () => store.create({ ...input, title: 'Cross room', parentTaskId: 'other-task' }),
    /Parent task is not in the same room/,
  );
});

test('finish and send-back keep parentTaskId', () => {
  const parent = store.create(input);
  const child = store.create({ ...input, title: 'Child', parentTaskId: parent.id, agentId: 'echo' });
  const claimed = store.claim(child.id, 'echo')!;
  store.finish(claimed.id, claimed.runId!, { status: 'done', result: 'ok' });
  const done = store.get(child.id);
  assert.equal(done.parentTaskId, parent.id);
  assert.equal(done.proposal, null);
  const sent = store.review(child.id, 'rejected', 'again', 'Moshe');
  assert.equal(sent.parentTaskId, parent.id);
  assert.equal(sent.status, INITIAL_STATUS);
});

test('finish clears proposal_choice so a later run is a new decision', () => {
  const task = store.create(input);
  const claimed = store.claim(task.id, 'echo')!;
  store.propose(claimed.id, claimed.runId!, proposal);
  store.decide(task.id, 'Postgres', 'Moshe');
  const rerun = store.claim(task.id, 'echo')!;
  assert.equal(store.get(task.id).proposalChoice, 'Postgres');
  store.finish(rerun.id, rerun.runId!, { status: 'done', result: 'chose Postgres' });
  const done = store.get(task.id);
  assert.equal(done.proposalChoice, null);
  assert.equal(done.proposalBy, null);
  assert.equal(done.proposalByPrincipalId, null);
  assert.equal(done.verdictByPrincipalId, null);
  // The proposal goes with the choice. Keeping it would render a decision block
  // on a finished task for a decision already acted on.
  assert.equal(done.proposal, null);
  assert.equal(done.verdict, null);
});
