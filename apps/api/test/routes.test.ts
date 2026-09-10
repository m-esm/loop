import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { INestApplication } from '@nestjs/common';
import { INITIAL_STATUS, TASK_STATUSES, type Task, type TaskEvent, type TaskSnapshot } from '@loop/types';
import { TaskStore } from '../src/task-store';
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
const input = { title: 'Route task', definitionOfDone: 'All routes pass' };
const headers = () => jsonHeaders(cookie);
async function create(): Promise<Task> {
  const response = await fetch(`${url}/tasks`, { method: 'POST', headers: headers(), body: JSON.stringify(input) });
  assert.equal(response.status, 201);
  return response.json() as Promise<Task>;
}

test('POST /tasks validates fields, trims text, and returns a stored task', async () => {
  const task = await create();
  assert.equal(task.title, input.title);
  assert.equal(task.status, INITIAL_STATUS);
  assert.equal(task.agentId, null);
  assert.equal(task.owner, OPERATOR.displayName);
  assert.equal(task.ownerPrincipalId, principalId);
  const named = await fetch(`${url}/tasks`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ ...input, agentId: ' reviewer ' }),
  });
  assert.equal(named.status, 201);
  assert.equal((await named.json() as Task).agentId, 'reviewer');
  for (const body of [{}, { ...input, title: 'a'.repeat(201) }, { ...input, definitionOfDone: 123 },
    { ...input, agentId: ' ' }, { ...input, agentId: 'a'.repeat(101) }]) {
    const response = await fetch(`${url}/tasks`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    assert.equal(response.status, 400);
  }
});

test('GET /tasks returns a snapshot cursor and GET /tasks/:id handles missing tasks', async () => {
  const task = await create();
  const list = await fetch(`${url}/tasks`, { headers: { Cookie: cookie } });
  assert.equal(list.status, 200);
  const snapshot = await list.json() as TaskSnapshot;
  assert.ok(snapshot.tasks.some((row) => row.id === task.id));
  assert.ok(snapshot.since > 0);
  assert.deepEqual(await (await fetch(`${url}/tasks/${task.id}`, { headers: { Cookie: cookie } })).json(), task);
  assert.equal((await fetch(`${url}/tasks/missing`, { headers: { Cookie: cookie } })).status, 404);
});

test('PATCH /tasks/:id/status validates status and persists a change', async () => {
  const task = await create();
  const patch = (id: string, status: unknown) => fetch(`${url}/tasks/${id}/status`, {
    method: 'PATCH', headers: headers(), body: JSON.stringify({ status }),
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
    method: 'POST', headers: headers(), body: JSON.stringify(body),
  });
  assert.equal((await answer(task.id, { answer: 'blue' })).status, 400);
  assert.equal((await fetch(`${url}/tasks/${task.id}/status`, {
    method: 'PATCH', headers: headers(), body: JSON.stringify({ status: 'needs_input' }),
  })).status, 200);
  const ok = await answer(task.id, { answer: 'blue' });
  assert.equal(ok.status, 200);
  const body = await ok.json() as Task;
  assert.equal(body.status, INITIAL_STATUS);
  assert.equal(body.answer, 'blue');
  assert.equal(body.answeredBy, OPERATOR.displayName);
  assert.equal(body.answeredByPrincipalId, principalId);
  assert.equal((await answer(task.id, { answer: 'green' })).status, 400);
  assert.equal((await answer(task.id, { answer: ' ' })).status, 400);
  assert.equal((await answer('missing', { answer: 'blue' })).status, 404);
});

test('POST /tasks/:id/review validates fields and only accepts a finished task', async () => {
  const task = await create();
  const review = (id: string, body: unknown) => fetch(`${url}/tasks/${id}/review`, {
    method: 'POST', headers: headers(), body: JSON.stringify(body),
  });
  assert.equal((await review(task.id, { verdict: 'accepted' })).status, 400);
  assert.equal((await fetch(`${url}/tasks/${task.id}/status`, {
    method: 'PATCH', headers: headers(), body: JSON.stringify({ status: 'done' }),
  })).status, 200);
  const ok = await review(task.id, { verdict: 'accepted' });
  assert.equal(ok.status, 200);
  const body = await ok.json() as Task;
  assert.equal(body.status, 'done');
  assert.equal(body.verdict, 'accepted');
  assert.equal(body.verdictBy, OPERATOR.displayName);
  assert.equal(body.verdictByPrincipalId, principalId);
  assert.equal((await review(task.id, { verdict: 'maybe' })).status, 400);
  assert.equal((await review(task.id, { verdict: 'accepted', note: 'a'.repeat(8001) })).status, 400);
  assert.equal((await review('missing', { verdict: 'accepted' })).status, 404);
  const other = await create();
  assert.equal((await fetch(`${url}/tasks/${other.id}/status`, {
    method: 'PATCH', headers: headers(), body: JSON.stringify({ status: 'failed' }),
  })).status, 200);
  const rejected = await review(other.id, { verdict: 'rejected', note: 'send back' });
  assert.equal(rejected.status, 200);
  const requeued = await rejected.json() as Task;
  assert.equal(requeued.status, INITIAL_STATUS);
  assert.equal(requeued.verdict, 'rejected');
  assert.equal(requeued.verdictNote, 'send back');
  assert.equal((await review(other.id, { verdict: 'accepted' })).status, 400);
});

test('POST /tasks/:id/decide validates choice against the stored proposal', async () => {
  const decide = (id: string, body: unknown) => fetch(`${url}/tasks/${id}/decide`, {
    method: 'POST', headers: headers(), body: JSON.stringify(body),
  });
  const queued = await create();
  assert.equal((await decide(queued.id, { choice: 'SQLite' })).status, 400);
  const store = app.get(TaskStore);
  const task = await create();
  const claimed = store.claim(task.id, 'echo')!;
  store.propose(claimed.id, claimed.runId!, {
    question: 'Which store?', options: ['SQLite', 'Postgres'], pick: 'SQLite', why: 'one file, no service',
  });
  assert.equal((await decide(task.id, { choice: 'MySQL' })).status, 400);
  const ok = await decide(task.id, { choice: 'Postgres' });
  assert.equal(ok.status, 200);
  const body = await ok.json() as Task;
  assert.equal(body.status, INITIAL_STATUS);
  assert.equal(body.proposalChoice, 'Postgres');
  assert.equal(body.proposalBy, OPERATOR.displayName);
  assert.equal(body.proposalByPrincipalId, principalId);
  assert.equal((await decide(task.id, { choice: 'SQLite' })).status, 400);
  assert.equal((await decide(task.id, { choice: ' ' })).status, 400);
  assert.equal((await decide('missing', { choice: 'SQLite' })).status, 404);
});

test('GET /stream replays across database pages in order, then streams live with SSE headers', async () => {
  const snapshot = await (await fetch(`${url}/tasks`, { headers: { Cookie: cookie } })).json() as TaskSnapshot;
  const count = 555;
  for (let i = 0; i < count; i++) await create();
  const controller = new AbortController();
  const response = await fetch(`${url}/stream?since=${snapshot.since}`, { headers: { Cookie: cookie }, signal: controller.signal });
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
    assert.equal((await fetch(`${url}/stream?since=${value}`, { headers: { Cookie: cookie } })).status, 400);
  }
});
