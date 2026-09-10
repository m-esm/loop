import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { INestApplication } from '@nestjs/common';
import type { Message, MessageSnapshot, Task, TaskEvent } from '@loop/types';
import { EventBus } from '../src/bus';
import { jsonHeaders, startAuthedApp } from './helpers';

let app: INestApplication;
let url: string;
let cookie: string;
const previous = process.env.LOOP_RUNNER;

before(async () => {
  process.env.DATABASE_PATH = ':memory:';
  process.env.LOOP_RUNNER = '1';
  const started = await startAuthedApp();
  app = started.app;
  url = started.url;
  cookie = started.cookie;
});
after(async () => {
  if (previous === undefined) delete process.env.LOOP_RUNNER;
  else process.env.LOOP_RUNNER = previous;
  await app.close();
});

async function postTask(body: string) {
  const response = await fetch(`${url}/messages`, {
    method: 'POST', headers: jsonHeaders(cookie),
    body: JSON.stringify({ roomId: 'default', body }),
  });
  assert.equal(response.status, 201);
  const message = await response.json() as Message;
  assert.equal(message.body.kind, 'task');
  if (message.body.kind !== 'task') throw new Error('expected task');
  return message.body.taskId;
}

async function waitTask(id: string, status: Task['status'], ms = 5000) {
  const start = Date.now();
  let task: Task | undefined;
  while (Date.now() - start < ms) {
    const response = await fetch(`${url}/tasks/${id}`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    task = await response.json() as Task;
    if (task.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.equal(task?.status, status);
  return task!;
}

test('LOOP_RUNNER finishes /task without PATCH and fails FAIL: titles', async () => {
  const echoId = await postTask('/task Echo me :: proof');
  const echo = await waitTask(echoId, 'done');
  assert.equal(echo.result, 'Echo: Echo me');
  assert.equal(echo.error, null);
  assert.ok(echo.log.includes('Echo started'));
  assert.ok(echo.log.includes('Echo finished'));
  const failId = await postTask('/task FAIL: boom :: x');
  const failed = await waitTask(failId, 'failed');
  assert.equal(failed.error, 'boom');
  const snapshot = await (await fetch(`${url}/messages?roomId=default`, { headers: { Cookie: cookie } })).json() as MessageSnapshot;
  assert.equal(snapshot.messages.length, 2);
  const replay = app.get(EventBus).since(0) as TaskEvent[];
  let folded: Task | undefined;
  let seenDone = false;
  for (const event of replay) {
    if (event.kind === 'message_created') continue;
    const row = event.payload.task;
    if (row.id !== echoId) continue;
    if (seenDone && row.status === 'running') assert.fail('done then running');
    if (row.status === 'done') seenDone = true;
    folded = row;
  }
  assert.equal(folded?.status, echo.status);
  assert.deepEqual(folded?.log, echo.log);
  assert.equal(folded?.result, echo.result);
});

test('two /task posts route to echo and reviewer commands', async () => {
  const echoId = await postTask('/task Echo me :: proof');
  const reviewId = await postTask('/task @reviewer check the diff :: proof');
  const echo = await waitTask(echoId, 'done');
  const review = await waitTask(reviewId, 'done');
  assert.equal(echo.result, 'Echo: Echo me');
  assert.equal(echo.claimedBy, 'echo');
  assert.equal(echo.agentId, null);
  assert.equal(review.result, 'Reviewed: check the diff');
  assert.equal(review.claimedBy, 'reviewer');
  assert.equal(review.agentId, 'reviewer');
  const ghostId = await postTask('/task @ghost unknown :: proof');
  const ghost = await waitTask(ghostId, 'failed');
  assert.match(ghost.error ?? '', /Unknown agent ghost/);
  assert.match(ghost.error ?? '', /echo/);
  assert.match(ghost.error ?? '', /reviewer/);
});

test('ASK: title parks, POST answer resumes, and the result carries the answer', async () => {
  const askId = await postTask('/task ASK: what colour :: proof');
  const parked = await waitTask(askId, 'needs_input');
  assert.equal(parked.question, 'what colour');
  const response = await fetch(`${url}/tasks/${askId}/answer`, {
    method: 'POST', headers: jsonHeaders(cookie),
    body: JSON.stringify({ answer: 'blue' }),
  });
  assert.equal(response.status, 200);
  const done = await waitTask(askId, 'done');
  assert.equal(done.result, 'Answered: blue');
  assert.equal(done.answer, 'blue');
  assert.equal(done.answeredBy, 'Moshe');
});
