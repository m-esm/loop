import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { INestApplication } from '@nestjs/common';
import type { Message, MessageSnapshot, TaskEvent, TaskSnapshot } from '@loop/types';
import { EventBus } from '../src/bus';
import { Database } from '../src/database';
import { jsonHeaders, OPERATOR, startAuthedApp } from './helpers';

let app: INestApplication;
let url: string;
let cookie: string;
let principalId: string;
before(async () => {
  process.env.DATABASE_PATH = ':memory:';
  const started = await startAuthedApp();
  app = started.app;
  url = started.url;
  cookie = started.cookie;
  principalId = started.principalId;
});
after(async () => { await app.close(); });
const input = { roomId: 'default', body: 'Hello' };
const post = (body: unknown) => fetch(`${url}/messages`, {
  method: 'POST', headers: jsonHeaders(cookie), body: JSON.stringify(body),
});

test('message validation rejects malformed fields and commands without writing events', async () => {
  const bus = app.get(EventBus);
  const since = bus.latestId();
  for (const body of [null, [], {}, { ...input, roomId: 'missing' }, { ...input, roomId: 1 },
    { ...input, body: 12 },
    { ...input, body: '' }, { ...input, body: 'a'.repeat(8001) }, { ...input, body: '/ask hi' },
    { ...input, body: '/task :: proof' }]) {
    assert.equal((await post(body)).status, 400);
  }
  assert.equal(bus.latestId(), since);
  assert.equal((await fetch(`${url}/messages?roomId=missing`, { headers: { Cookie: cookie } })).status, 400);
});

test('text emits once, task emits task then referencing message, SSE replays all in order', async () => {
  const bus = app.get(EventBus);
  const observed: TaskEvent[] = [];
  const unsubscribe = bus.subscribe((event) => observed.push(event));
  const text = await post({ ...input, body: ' Hello ' });
  assert.equal(text.status, 201);
  const message = await text.json() as Message;
  assert.equal(message.author, OPERATOR.displayName);
  assert.equal(message.authorPrincipalId, principalId);
  assert.deepEqual(message.body, { kind: 'text', text: 'Hello' });
  assert.equal(observed.length, 1);
  const response = await post({ ...input, body: '/task Build chat :: Tests pass' });
  assert.equal(response.status, 201);
  const card = await response.json() as Message;
  assert.equal(card.body.kind, 'task');
  if (card.body.kind !== 'task') throw new Error('Expected task body');
  const taskId = card.body.taskId;
  assert.deepEqual(observed.map((event) => event.kind), ['message_created', 'task_created', 'message_created']);
  assert.equal(observed[1].subject_id, taskId);
  const tasks = await (await fetch(`${url}/tasks`, { headers: { Cookie: cookie } })).json() as TaskSnapshot;
  const task = tasks.tasks.find((task) => task.id === taskId)!;
  assert.equal(task.title, 'Build chat');
  assert.equal(task.owner, OPERATOR.displayName);
  assert.equal(task.ownerPrincipalId, principalId);
  assert.equal(task.definitionOfDone, 'Tests pass');
  assert.equal(task.roomId, 'default');
  assert.equal(task.agentId, null);
  const snapshot = await (await fetch(`${url}/messages?roomId=default`, { headers: { Cookie: cookie } })).json() as MessageSnapshot;
  assert.deepEqual(snapshot.messages, [message, card]);
  assert.equal(snapshot.since, observed.at(-1)!.id);
  unsubscribe();
  const controller = new AbortController();
  const stream = await fetch(`${url}/stream?since=0`, { headers: { Cookie: cookie }, signal: controller.signal });
  const reader = stream.body!.getReader();
  let buffer = '';
  try {
    while ((buffer.match(/\n\n/g) ?? []).length < observed.length) {
      buffer += new TextDecoder().decode((await reader.read()).value);
    }
    const replay = buffer.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)) as TaskEvent);
    assert.deepEqual(replay, bus.since(0));
    assert.deepEqual(replay.map((event) => event.id), [...replay.map((event) => event.id)].sort((a, b) => a - b));
  } finally { controller.abort(); await reader.cancel().catch(() => {}); }
});

test('failed message event insertion rolls back its message', async () => {
  const database = app.get(Database);
  const bus = app.get(EventBus);
  const since = bus.latestId();
  database.sqlite.exec("CREATE TRIGGER reject_message_event BEFORE INSERT ON events WHEN NEW.kind = 'message_created' BEGIN SELECT RAISE(ABORT, 'rejected'); END");
  try {
    assert.equal((await post(input)).status, 500);
    assert.equal(bus.latestId(), since);
    const snapshot = await (await fetch(`${url}/messages?roomId=default`, { headers: { Cookie: cookie } })).json() as MessageSnapshot;
    assert.equal(snapshot.messages.length, 2);
  } finally { database.sqlite.exec('DROP TRIGGER reject_message_event'); }
});

test('a /task mention stores agentId and a bare @ is rejected', async () => {
  const addressed = await post({ ...input, body: '/task @reviewer check the diff :: proof' });
  assert.equal(addressed.status, 201);
  const addressedCard = await addressed.json() as Message;
  if (addressedCard.body.kind !== 'task') throw new Error('Expected task body');
  const addressedTask = await (await fetch(`${url}/tasks/${addressedCard.body.taskId}`, { headers: { Cookie: cookie } })).json() as { title: string; agentId: string | null };
  assert.equal(addressedTask.title, 'check the diff');
  assert.equal(addressedTask.agentId, 'reviewer');
  assert.equal((await post({ ...input, body: '/task @' })).status, 400);
});
