import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { RoomSummary, RoomsSnapshot, Task } from '@loop/types';
import { TaskRunner } from '../src/runner';
import { TaskStore } from '../src/task-store';
import { createApp } from '../src/app';
import { jsonHeaders, startAuthedApp } from './helpers';

let app: INestApplication;
let url: string;
let cookie: string;
let dir: string;
const envKeys = ['DATABASE_PATH', 'LOOP_RUNNER', 'LOOP_AGENTS_PATH', 'LOOP_ALLOW_REGISTER'] as const;
const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

async function start() {
  ({ app, url, cookie } = await startAuthedApp());
}

async function restart() {
  await app.close();
  app = await createApp(false);
  await app.listen(0, '127.0.0.1');
  url = `${await app.getUrl()}/api`;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'loop-steering-'));
  process.env.DATABASE_PATH = join(dir, 'loop.sqlite');
  process.env.LOOP_AGENTS_PATH = join(dir, 'agents.json');
  process.env.LOOP_RUNNER = '0';
  process.env.LOOP_ALLOW_REGISTER = '1';
  writeFileSync(join(dir, 'starts'), '');
  writeFileSync(process.env.LOOP_AGENTS_PATH, JSON.stringify({ agents: [{
    id: 'probe', name: 'Probe', command: [process.execPath, '-e', `
      const fs = require('node:fs');
      fs.appendFileSync(${JSON.stringify(join(dir, 'starts'))}, process.env.LOOP_TASK_TITLE + '\\n');
      const finish = () => console.log(process.env.LOOP_TASK_STEERING || 'ordinary turn');
      if (process.env.LOOP_TASK_TITLE === 'hold') {
        const timer = setInterval(() => {
          if (fs.existsSync(${JSON.stringify(join(dir, 'release'))})) { clearInterval(timer); finish(); }
        }, 20);
      } else finish();
    `],
  }] }));
  await start();
});

afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
  for (const key of envKeys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
});

async function steer(body: unknown, auth = cookie) {
  return fetch(`${url}/rooms/default/steer`, {
    method: 'PATCH', headers: jsonHeaders(auth), body: JSON.stringify(body),
  });
}

async function room(): Promise<RoomSummary> {
  const response = await fetch(`${url}/rooms/default`, { headers: jsonHeaders(cookie) });
  assert.equal(response.status, 200);
  return response.json() as Promise<RoomSummary>;
}

async function task(title: string, roomId = 'default', agentId?: string): Promise<Task> {
  const response = await fetch(`${url}/tasks`, {
    method: 'POST', headers: jsonHeaders(cookie),
    body: JSON.stringify({ title, roomId, definitionOfDone: 'Child output proves the turn', agentId }),
  });
  assert.equal(response.status, 201);
  return response.json() as Promise<Task>;
}

async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(check(), 'runner did not reach expected state');
}

test('pause survives restart, prevents claims and child starts, and does not block other rooms; resume runs again', async () => {
  assert.equal((await room()).paused, false);
  assert.equal((await steer({ paused: true })).status, 200);
  const queued = await task('paused room');
  await restart();
  assert.equal((await room()).paused, true);
  const listed = await (await fetch(`${url}/rooms`, { headers: jsonHeaders(cookie) })).json() as RoomsSnapshot;
  assert.equal(listed.rooms.find((item) => item.id === 'default')?.paused, true);
  const created = await fetch(`${url}/rooms`, {
    method: 'POST', headers: jsonHeaders(cookie), body: JSON.stringify({ name: 'Active room' }),
  });
  assert.equal(created.status, 201);
  const other = await created.json() as RoomSummary;
  const active = await task('other room', other.id);
  const store = app.get(TaskStore);
  assert.equal(store.claim(queued.id, 'probe'), null);
  app.get(TaskRunner).start();
  await until(() => store.get(active.id).status === 'done');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(store.get(queued.id).status, 'queued');
  assert.equal(store.get(queued.id).runId, null);
  assert.equal(readFileSync(join(dir, 'starts'), 'utf8'), 'other room\n');
  assert.equal((await steer({ paused: false })).status, 200);
  assert.equal((await room()).paused, false);
  await until(() => store.get(queued.id).status === 'done');
  assert.equal(readFileSync(join(dir, 'starts'), 'utf8'), 'other room\npaused room\n');
});

test('wrap up persists while paused and across restart, skips invalid agents, and reaches exactly one child', async () => {
  assert.equal((await steer({ paused: true, wrapUp: true })).status, 200);
  await restart();
  assert.equal((await room()).wrapUp, true);
  app.get(TaskRunner).start();
  const invalid = await task('invalid', 'default', 'missing');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal((await room()).wrapUp, true);
  assert.equal(readFileSync(join(dir, 'starts'), 'utf8'), '');
  await steer({ paused: false });
  const store = app.get(TaskStore);
  await until(() => store.get(invalid.id).status === 'failed');
  assert.equal((await room()).wrapUp, true);
  const first = await task('converge');
  await until(() => store.get(first.id).status === 'done');
  assert.match(store.get(first.id).result ?? '', /Wrap up: converge on a concrete result/);
  assert.equal((await room()).wrapUp, false);
  const second = await task('continue');
  await until(() => store.get(second.id).status === 'done');
  assert.equal(store.get(second.id).result, 'ordinary turn');
});

test('pause lets an existing child finish but holds its successor and wrap up until resumed', async () => {
  app.get(TaskRunner).start();
  const current = await task('hold');
  await until(() => readFileSync(join(dir, 'starts'), 'utf8') === 'hold\n');
  await steer({ paused: true, wrapUp: true });
  const next = await task('successor');
  writeFileSync(join(dir, 'release'), 'go');
  const store = app.get(TaskStore);
  await until(() => store.get(current.id).status === 'done');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(store.get(next.id).runId, null);
  assert.equal(store.get(next.id).status, 'queued');
  assert.equal((await room()).wrapUp, true);
  assert.equal(readFileSync(join(dir, 'starts'), 'utf8'), 'hold\n');
  await steer({ paused: false });
  await until(() => store.get(next.id).status === 'done');
  assert.match(store.get(next.id).result ?? '', /Wrap up: converge/);
  assert.equal((await room()).wrapUp, false);
});

test('steering is owner-only and validates booleans without partially applying bad input', async () => {
  const registered = await fetch(`${url}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'member@loop.local', password: 'password1', displayName: 'Member' }),
  });
  assert.equal(registered.status, 201);
  const memberCookie = registered.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await steer({ paused: true }, memberCookie)).status, 403);
  assert.equal((await steer({ wrapUp: true }, memberCookie)).status, 403);
  assert.equal((await steer({ paused: true }, '')).status, 401);
  for (const body of [{}, { paused: 'true' }, { wrapUp: 1 }, { paused: true, wrapUp: null }, { extra: true }, []]) {
    assert.equal((await steer(body)).status, 400);
  }
  assert.equal((await room()).paused, false);
  assert.equal((await room()).wrapUp, false);
  await steer({ paused: true, wrapUp: true });
  await steer({ wrapUp: false });
  assert.equal((await room()).paused, true);
  assert.equal((await room()).wrapUp, false);
  const created = await fetch(`${url}/rooms`, {
    method: 'POST', headers: jsonHeaders(cookie), body: JSON.stringify({ name: 'Private' }),
  });
  const privateRoom = await created.json() as RoomSummary;
  const foreign = await fetch(`${url}/rooms/${privateRoom.id}`, { headers: jsonHeaders(memberCookie) });
  assert.equal(foreign.status, 403);
});
