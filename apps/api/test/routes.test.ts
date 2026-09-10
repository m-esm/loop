import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { INestApplication } from '@nestjs/common';
import { INITIAL_STATUS, TASK_STATUSES, type Task, type TaskEvent, type TaskSnapshot } from '@loop/types';
import { createApp } from '../src/app';

let app: INestApplication;
let url: string;
before(async () => {
  process.env.DATABASE_PATH = ':memory:';
  app = await createApp(false);
  await app.listen(0, '127.0.0.1');
  url = `${await app.getUrl()}/api`;
});
after(async () => { await app.close(); });
const input = { title: 'Route task', owner: 'Human', definitionOfDone: 'All routes pass' };
async function create(): Promise<Task> {
  const response = await fetch(`${url}/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal(response.status, 201);
  return response.json() as Promise<Task>;
}

test('POST /tasks validates fields, trims text, and returns a stored task', async () => {
  const task = await create();
  assert.equal(task.title, input.title);
  assert.equal(task.status, INITIAL_STATUS);
  for (const body of [{}, { ...input, owner: ' ' }, { ...input, title: 'a'.repeat(201) }, { ...input, definitionOfDone: 123 }]) {
    const response = await fetch(`${url}/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 400);
  }
});

test('GET /tasks returns a snapshot cursor and GET /tasks/:id handles missing tasks', async () => {
  const task = await create();
  const list = await fetch(`${url}/tasks`);
  assert.equal(list.status, 200);
  const snapshot = await list.json() as TaskSnapshot;
  assert.ok(snapshot.tasks.some((row) => row.id === task.id));
  assert.ok(snapshot.since > 0);
  assert.deepEqual(await (await fetch(`${url}/tasks/${task.id}`)).json(), task);
  assert.equal((await fetch(`${url}/tasks/missing`)).status, 404);
});

test('PATCH /tasks/:id/status validates status and persists a change', async () => {
  const task = await create();
  const patch = (id: string, status: unknown) => fetch(`${url}/tasks/${id}/status`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }),
  });
  const status = TASK_STATUSES.at(-1)!;
  const response = await patch(task.id, status);
  assert.equal(response.status, 200);
  assert.equal((await response.json() as Task).status, status);
  assert.equal((await patch(task.id, '__proto__')).status, 400);
  assert.equal((await patch(task.id, ['bad'])).status, 400);
  assert.equal((await patch('missing', status)).status, 404);
});

test('POST /tasks/:id/answer validates fields and only accepts needs_input', async () => {
  const task = await create();
  const answer = (id: string, body: unknown) => fetch(`${url}/tasks/${id}/answer`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await answer(task.id, { answer: 'blue', answeredBy: 'Moshe' })).status, 400);
  assert.equal((await fetch(`${url}/tasks/${task.id}/status`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'needs_input' }),
  })).status, 200);
  const ok = await answer(task.id, { answer: 'blue', answeredBy: 'Moshe' });
  assert.equal(ok.status, 200);
  const body = await ok.json() as Task;
  assert.equal(body.status, INITIAL_STATUS);
  assert.equal(body.answer, 'blue');
  assert.equal(body.answeredBy, 'Moshe');
  assert.equal((await answer(task.id, { answer: 'green', answeredBy: 'Moshe' })).status, 400);
  assert.equal((await answer(task.id, { answer: ' ', answeredBy: 'Moshe' })).status, 400);
  assert.equal((await answer(task.id, { answer: 'blue', answeredBy: 'a'.repeat(101) })).status, 400);
  assert.equal((await answer('missing', { answer: 'blue', answeredBy: 'Moshe' })).status, 404);
});

test('GET /stream replays across database pages in order, then streams live with SSE headers', async () => {
  const snapshot = await (await fetch(`${url}/tasks`)).json() as TaskSnapshot;
  const count = 555;
  for (let i = 0; i < count; i++) await create();
  const controller = new AbortController();
  const response = await fetch(`${url}/stream?since=${snapshot.since}`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type')!, /text\/event-stream/);
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  assert.equal(response.headers.get('content-encoding'), 'identity');
  const reader = response.body!.getReader();
  let buffer = '';
  const received: TaskEvent[] = [];
  async function readUntil(count: number) {
    while (received.length < count) {
      const result = await reader.read();
      assert.equal(result.done, false);
      buffer += new TextDecoder().decode(result.value);
      let end: number;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame.split('\n').find((line) => line.startsWith('data: '));
        if (data) {
          const event = JSON.parse(data.slice(6)) as TaskEvent;
          assert.ok(frame.includes(`id: ${event.id}`));
          received.push(event);
        }
      }
    }
  }
  try {
    await readUntil(count);
    assert.equal(received[0].id, snapshot.since + 1);
    assert.equal(new Set(received.map((event) => event.id)).size, count);
    const task = await create();
    await readUntil(count + 1);
    assert.equal(received.at(-1)!.subject_id, task.id);
  } finally { controller.abort(); await reader.cancel().catch(() => {}); }
});

test('GET /stream rejects invalid replay cursors', async () => {
  for (const value of ['bad', '-1', '1.5', '9007199254740992', '']) {
    assert.equal((await fetch(`${url}/stream?since=${value}`)).status, 400);
  }
});
