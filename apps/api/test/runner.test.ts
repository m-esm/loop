import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
const originalAgentsPath = process.env.LOOP_AGENTS_PATH;
const originalWallMs = process.env.LOOP_WALL_MS;
let database: Database;
let bus: EventBus;
let store: TaskStore;
let messages: MessageStore;
let runner: TaskRunner;
let dir: string | undefined;

function nodeCommand(script: string): string[] {
  return [process.execPath, '-e', script];
}

function rebuildRunner(agents: { id: string; name: string; command: string[] }[]) {
  const path = join(dir!, 'agents.json');
  writeFileSync(path, JSON.stringify({ agents }));
  process.env.LOOP_AGENTS_PATH = path;
  runner.stop();
  runner = new TaskRunner(store, bus, messages);
}

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
  messages = new MessageStore(database, bus, store);
  runner = new TaskRunner(store, bus, messages);
});

afterEach(async () => {
  runner.stop();
  await new Promise((resolve) => defer(resolve));
  database.onModuleDestroy();
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (originalAgentsPath === undefined) delete process.env.LOOP_AGENTS_PATH;
  else process.env.LOOP_AGENTS_PATH = originalAgentsPath;
  if (originalWallMs === undefined) delete process.env.LOOP_WALL_MS;
  else process.env.LOOP_WALL_MS = originalWallMs;
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
  messages = new MessageStore(database, bus, store);
  runner = new TaskRunner(store, bus, messages);
  const before = bus.latestId();
  runner.start();
  const lost = store.get(task.id);
  assert.equal(lost.status, 'failed');
  assert.equal(lost.error, 'runner lost');
  const added = bus.since(before);
  assert.equal(added.length, 1);
  assert.equal(added[0].kind, 'task_status_changed');
});

test('ASK: parks in needs_input, resumes after answer, and finishes with the answer', async () => {
  const task = store.create({ ...input, title: 'ASK: what colour' });
  runner.start();
  await waitFor(() => store.get(task.id).status === 'needs_input');
  const parked = store.get(task.id);
  assert.equal(parked.question, 'what colour');
  assert.equal(parked.result, null);
  store.answer(task.id, 'blue', 'Moshe');
  await waitFor(() => store.get(task.id).status === 'done');
  const done = store.get(task.id);
  assert.equal(done.result, 'Answered: blue');
  assert.equal(done.answer, 'blue');
  assert.equal(done.answeredBy, 'Moshe');
});

test('needs_input survives reclaimLost as waiting on a human', () => {
  const task = store.create(input);
  const claimed = store.claim(task.id, 'echo')!;
  store.ask(claimed.id, claimed.runId!, 'what colour');
  const before = bus.latestId();
  const reclaimed = store.reclaimLost();
  assert.equal(reclaimed.length, 0);
  const parked = store.get(task.id);
  assert.equal(parked.status, 'needs_input');
  assert.equal(parked.question, 'what colour');
  assert.equal(bus.latestId(), before);
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

test('a configured command\'s stdout is the done result', async () => {
  const token = `stdout-${Date.now()}`;
  rebuildRunner([{ id: 'probe', name: 'Probe', command: nodeCommand(`process.stdout.write(${JSON.stringify(`${token}\n`)})`) }]);
  const task = store.create(input);
  runner.start();
  await waitFor(() => store.get(task.id).status === 'done');
  const done = store.get(task.id);
  assert.equal(done.result, token);
  assert.ok(done.log.includes(token));
  assert.equal(done.error, null);
});

test('a nonzero command\'s stderr is the failed error', async () => {
  const token = `stderr-${Date.now()}`;
  rebuildRunner([{
    id: 'probe', name: 'Probe',
    command: nodeCommand(`process.stderr.write(${JSON.stringify(`${token}\n`)}); process.exit(2)`),
  }]);
  const task = store.create(input);
  runner.start();
  await waitFor(() => store.get(task.id).status === 'failed');
  const failed = store.get(task.id);
  assert.equal(failed.error, token);
  assert.ok(failed.log.includes(token));
  assert.equal(failed.result, null);
});

test('empty stdout on exit 0 uses Exited 0; empty stderr on nonzero uses Exited code', async () => {
  rebuildRunner([{ id: 'probe', name: 'Probe', command: nodeCommand('process.exit(0)') }]);
  const ok = store.create({ ...input, title: 'silent ok' });
  runner.start();
  await waitFor(() => store.get(ok.id).status === 'done');
  assert.equal(store.get(ok.id).result, 'Exited 0');
  runner.stop();
  rebuildRunner([{ id: 'probe', name: 'Probe', command: nodeCommand('process.exit(3)') }]);
  const bad = store.create({ ...input, title: 'silent fail' });
  runner.start();
  await waitFor(() => store.get(bad.id).status === 'failed');
  assert.equal(store.get(bad.id).error, 'Exited 3');
});

test('partial stdout without a trailing newline is flushed on exit', async () => {
  rebuildRunner([{
    id: 'probe', name: 'Probe',
    command: nodeCommand("process.stdout.write('hel'); process.stdout.write('lo')"),
  }]);
  const task = store.create(input);
  runner.start();
  await waitFor(() => store.get(task.id).status === 'done');
  assert.equal(store.get(task.id).result, 'hello');
  assert.ok(store.get(task.id).log.includes('hello'));
});

test('missing agents file leaves tasks queued', async () => {
  process.env.LOOP_AGENTS_PATH = join(dir!, 'missing-agents.json');
  runner.stop();
  runner = new TaskRunner(store, bus, messages);
  const task = store.create(input);
  runner.start();
  await new Promise((resolve) => defer(resolve));
  await new Promise((resolve) => defer(resolve));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(store.get(task.id).status, 'queued');
});

test('wall clock kills a hung child and clears busy for the next task', async () => {
  process.env.LOOP_WALL_MS = '200';
  rebuildRunner([{
    id: 'probe', name: 'Probe',
    command: nodeCommand("setTimeout(() => process.stdout.write('too late\\n'), 10000)"),
  }]);
  const hung = store.create({ ...input, title: 'hang' });
  runner.start();
  await waitFor(() => store.get(hung.id).status === 'failed');
  const failed = store.get(hung.id);
  assert.equal(failed.error, 'timed out');
  assert.equal(failed.log.includes('too late'), false);
  rebuildRunner([{ id: 'probe', name: 'Probe', command: nodeCommand("process.stdout.write('next\\n')") }]);
  const next = store.create({ ...input, title: 'after hang' });
  runner.start();
  await waitFor(() => store.get(next.id).status === 'done');
  assert.equal(store.get(next.id).result, 'next');
});

test('LOOP_PROPOSE parks, then reruns with LOOP_TASK_CHOICE', async () => {
  const payload = JSON.stringify({
    question: 'Which store?', options: ['SQLite', 'Postgres'], pick: 'SQLite', why: 'one file, no service',
  });
  rebuildRunner([{
    id: 'probe', name: 'Probe',
    command: nodeCommand(
      `const c=process.env.LOOP_TASK_CHOICE;if(c){process.stdout.write('chose '+c+'\\n')}else{process.stdout.write(${JSON.stringify(`LOOP_PROPOSE: ${payload}\n`)})}`,
    ),
  }]);
  const task = store.create(input);
  runner.start();
  await waitFor(() => store.get(task.id).status === 'needs_input');
  const parked = store.get(task.id);
  assert.equal(parked.proposal?.pick, 'SQLite');
  assert.deepEqual(parked.proposal?.options, ['SQLite', 'Postgres']);
  store.decide(task.id, 'Postgres', 'Moshe');
  await waitFor(() => store.get(task.id).status === 'done');
  assert.equal(store.get(task.id).result, 'chose Postgres');
  assert.equal(store.get(task.id).proposalChoice, null);
});

test('malformed LOOP_PROPOSE fails the task instead of parking it', async () => {
  rebuildRunner([{
    id: 'probe', name: 'Probe',
    command: nodeCommand("process.stdout.write('LOOP_PROPOSE: {\\n')"),
  }]);
  const badJson = store.create({ ...input, title: 'bad json' });
  runner.start();
  await waitFor(() => store.get(badJson.id).status === 'failed');
  assert.match(store.get(badJson.id).error ?? '', /Malformed proposal/);
  runner.stop();
  rebuildRunner([{
    id: 'probe', name: 'Probe',
    command: nodeCommand(
      "process.stdout.write('LOOP_PROPOSE: '+JSON.stringify({question:'q',options:[],pick:'x',why:'y'})+'\\n')",
    ),
  }]);
  const empty = store.create({ ...input, title: 'empty options' });
  runner.start();
  await waitFor(() => store.get(empty.id).status === 'failed');
  assert.match(store.get(empty.id).error ?? '', /options must not be empty/);
  runner.stop();
  rebuildRunner([{
    id: 'probe', name: 'Probe',
    command: nodeCommand(
      "process.stdout.write('LOOP_PROPOSE: '+JSON.stringify({question:'q',options:['a'],pick:'b',why:'y'})+'\\n')",
    ),
  }]);
  const pick = store.create({ ...input, title: 'bad pick' });
  runner.start();
  await waitFor(() => store.get(pick.id).status === 'failed');
  assert.match(store.get(pick.id).error ?? '', /pick is not one of the options/);
});

test('LOOP_ASK line parks, then reruns with LOOP_TASK_ANSWER', async () => {
  rebuildRunner([{
    id: 'probe', name: 'Probe',
    command: nodeCommand(
      "const a=process.env.LOOP_TASK_ANSWER;if(a){process.stdout.write('got '+a+'\\n')}else{process.stdout.write('LOOP_ASK: colour?\\n')}",
    ),
  }]);
  const task = store.create(input);
  runner.start();
  await waitFor(() => store.get(task.id).status === 'needs_input');
  assert.equal(store.get(task.id).question, 'colour?');
  store.answer(task.id, 'green', 'Moshe');
  await waitFor(() => store.get(task.id).status === 'done');
  assert.equal(store.get(task.id).result, 'got green');
});

test('the child gets an allowlisted env and a cwd outside the API, not the server process env', async () => {
  process.env.LOOP_TEST_SECRET = 'hunter2';
  try {
    rebuildRunner([{
      id: 'probe', name: 'Probe',
      // Print the raw cwd. Comparing it to an env var inside the child is
      // vacuous: that name is not on the allowlist, so it is always undefined
      // and the comparison would pass even if spawn used the API directory.
      command: nodeCommand(
        "process.stdout.write('secret='+(process.env.LOOP_TEST_SECRET||'absent')+' cwd='+process.cwd()+'\\n')",
      ),
    }]);
    const task = store.create(input);
    runner.start();
    await waitFor(() => store.get(task.id).status === 'done');
    const result = store.get(task.id).result ?? '';
    // An agent command is arbitrary code from a config file. It must not be able
    // to read the API's secrets or write relative paths into the API's cwd.
    assert.match(result, /^secret=absent cwd=/);
    const childCwd = realpathSync(result.slice(result.indexOf(' cwd=') + 5));
    assert.notEqual(childCwd, realpathSync(process.cwd()));
    assert.equal(childCwd, realpathSync(tmpdir()));
  } finally {
    delete process.env.LOOP_TEST_SECRET;
  }
});

test('rejected rerun passes LOOP_TASK_NOTE to the child', async () => {
  rebuildRunner([{
    id: 'probe', name: 'Probe',
    command: nodeCommand(
      "const n=process.env.LOOP_TASK_NOTE;if(n){process.stdout.write('note '+n+'\\n')}else{process.stdout.write('first\\n')}",
    ),
  }]);
  const task = store.create(input);
  runner.start();
  await waitFor(() => store.get(task.id).status === 'done');
  assert.equal(store.get(task.id).result, 'first');
  store.review(task.id, 'rejected', 'too thin', 'Moshe');
  await waitFor(() => store.get(task.id).status === 'done' && store.get(task.id).result === 'note too thin');
  const done = store.get(task.id);
  assert.equal(done.result, 'note too thin');
  // The re-run is a new unreviewed result, so the verdict that sent it back is
  // gone. A surviving verdict would hide Accept/Reject on the fresh output.
  assert.equal(done.verdict, null);
  assert.equal(done.verdictNote, null);
  assert.equal(done.verdictBy, null);
  assert.equal(done.agentId, null);
});

test('a named agent runs its own command and claimedBy is that id', async () => {
  rebuildRunner([
    { id: 'echo', name: 'Echo', command: nodeCommand("process.stdout.write('from-echo\\n')") },
    { id: 'reviewer', name: 'Reviewer', command: nodeCommand("process.stdout.write('from-reviewer\\n')") },
  ]);
  const assigned = store.create({ ...input, title: 'review me', agentId: 'reviewer' });
  const unassigned = store.create({ ...input, title: 'echo me' });
  runner.start();
  await waitFor(() => store.get(assigned.id).status === 'done' && store.get(unassigned.id).status === 'done');
  assert.equal(store.get(assigned.id).result, 'from-reviewer');
  assert.equal(store.get(assigned.id).claimedBy, 'reviewer');
  assert.equal(store.get(unassigned.id).result, 'from-echo');
  assert.equal(store.get(unassigned.id).claimedBy, 'echo');
});

test('unknown agent fails through finish with the id and the known list', async () => {
  rebuildRunner([
    { id: 'echo', name: 'Echo', command: nodeCommand("process.stdout.write('from-echo\\n')") },
    { id: 'reviewer', name: 'Reviewer', command: nodeCommand("process.stdout.write('from-reviewer\\n')") },
  ]);
  const task = store.create({ ...input, title: 'ghost me', agentId: 'ghost' });
  runner.start();
  await waitFor(() => store.get(task.id).status === 'failed');
  const failed = store.get(task.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error ?? '', /Unknown agent ghost/);
  assert.match(failed.error ?? '', /echo/);
  assert.match(failed.error ?? '', /reviewer/);
  assert.equal(failed.claimedBy, 'ghost');
  assert.equal(failed.result, null);
  const kinds = bus.since(0).filter((event) => event.subject_id === task.id).map((event) => event.kind);
  assert.ok(kinds.includes('task_status_changed'));
  const next = store.create({ ...input, title: 'after ghost' });
  await waitFor(() => store.get(next.id).status === 'done');
  assert.equal(store.get(next.id).result, 'from-echo');
});

test('needs_input on a named agent resumes the same command', async () => {
  rebuildRunner([
    { id: 'echo', name: 'Echo', command: nodeCommand("process.stdout.write('from-echo\\n')") },
    {
      id: 'reviewer', name: 'Reviewer',
      command: nodeCommand(
        "const a=process.env.LOOP_TASK_ANSWER;if(a){process.stdout.write('reviewed '+a+'\\n')}else{process.stdout.write('LOOP_ASK: notes?\\n')}",
      ),
    },
  ]);
  const task = store.create({ ...input, title: 'review parked', agentId: 'reviewer' });
  runner.start();
  await waitFor(() => store.get(task.id).status === 'needs_input');
  assert.equal(store.get(task.id).claimedBy, 'reviewer');
  store.answer(task.id, 'lgtm', 'Moshe');
  await waitFor(() => store.get(task.id).status === 'done');
  const done = store.get(task.id);
  assert.equal(done.result, 'reviewed lgtm');
  assert.equal(done.claimedBy, 'reviewer');
});

test('LOOP_SPAWN creates children without parking the parent, then the children run', async () => {
  const first = JSON.stringify({ title: 'First child', definitionOfDone: 'one', agentId: 'echo' });
  const second = JSON.stringify({ title: 'Second child', definitionOfDone: 'two', agentId: 'echo' });
  rebuildRunner([
    {
      id: 'planner', name: 'Planner',
      command: nodeCommand(
        `process.stdout.write(${JSON.stringify(`LOOP_SPAWN: ${first}\n`)});process.stdout.write(${JSON.stringify(`LOOP_SPAWN: ${second}\n`)});process.stdout.write('parent-done\\n')`,
      ),
    },
    { id: 'echo', name: 'Echo', command: nodeCommand("process.stdout.write('child-done\\n')") },
  ]);
  const parent = store.create({ ...input, title: 'Break this down', agentId: 'planner' });
  runner.start();
  await waitFor(() => store.get(parent.id).status === 'done');
  assert.equal(store.get(parent.id).result, 'parent-done');
  assert.equal(store.get(parent.id).error, null);
  const children = store.list().tasks.filter((row) => row.parentTaskId === parent.id);
  assert.equal(children.length, 2);
  assert.deepEqual(children.map((row) => row.title).sort(), ['First child', 'Second child']);
  assert.ok(children.every((row) => row.roomId === parent.roomId));
  await waitFor(() => children.every((row) => store.get(row.id).status === 'done'));
  assert.ok(children.every((row) => store.get(row.id).result === 'child-done'));
  const cards = messages.list(parent.roomId).messages.filter((message) => message.body.kind === 'task');
  assert.equal(cards.length, 2);
});

test('malformed LOOP_SPAWN logs on the parent and the parent still finishes', async () => {
  rebuildRunner([{
    id: 'planner', name: 'Planner',
    command: nodeCommand("process.stdout.write('LOOP_SPAWN: {\\n');process.stdout.write('parent-done\\n')"),
  }]);
  const parent = store.create({ ...input, title: 'Bad spawn', agentId: 'planner' });
  runner.start();
  await waitFor(() => store.get(parent.id).status === 'done');
  const done = store.get(parent.id);
  assert.equal(done.result, 'parent-done');
  assert.ok(done.log.some((line) => /Malformed spawn/.test(line)));
  assert.equal(store.list().tasks.filter((row) => row.parentTaskId === parent.id).length, 0);
});

test('LOOP_SPAWN with an unknown agent fails the child and not the parent', async () => {
  const payload = JSON.stringify({ title: 'Ghost child', definitionOfDone: 'x', agentId: 'ghost' });
  rebuildRunner([
    {
      id: 'planner', name: 'Planner',
      command: nodeCommand(
        `process.stdout.write(${JSON.stringify(`LOOP_SPAWN: ${payload}\n`)});process.stdout.write('parent-done\\n')`,
      ),
    },
    { id: 'echo', name: 'Echo', command: nodeCommand("process.stdout.write('child-done\\n')") },
  ]);
  const parent = store.create({ ...input, title: 'Spawn ghost', agentId: 'planner' });
  runner.start();
  await waitFor(() => store.get(parent.id).status === 'done');
  assert.equal(store.get(parent.id).result, 'parent-done');
  const child = store.list().tasks.find((row) => row.parentTaskId === parent.id);
  assert.ok(child, 'expected a spawned child');
  const childId = child.id;
  await waitFor(() => store.get(childId).status === 'failed');
  assert.match(store.get(childId).error ?? '', /Unknown agent ghost/);
});
