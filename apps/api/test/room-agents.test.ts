import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { Message, RoomAgent, Task } from '@loop/types';
import { Database } from '../src/database';
import { jsonHeaders, startAuthedApp } from './helpers';

let app: INestApplication;
let url: string;
let cookie: string;
let principalId: string;
let dir: string;
const echoToken = `echo-${Date.now()}`;
const probeToken = `probe-${Date.now()}`;
const previousRunner = process.env.LOOP_RUNNER;
const previousAgents = process.env.LOOP_AGENTS_PATH;
const previousRegister = process.env.LOOP_ALLOW_REGISTER;
const previousDb = process.env.DATABASE_PATH;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'loop-room-agents-'));
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    agents: [
      {
        id: 'echo',
        name: 'Echo',
        command: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(`${echoToken}\n`)})`],
      },
      {
        id: 'probe',
        name: 'Probe',
        command: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(`${probeToken}\n`)})`],
      },
    ],
  }));
  process.env.DATABASE_PATH = join(dir, 'loop.sqlite');
  process.env.LOOP_RUNNER = '1';
  process.env.LOOP_AGENTS_PATH = join(dir, 'agents.json');
  process.env.LOOP_ALLOW_REGISTER = '1';
  const started = await startAuthedApp();
  app = started.app;
  url = started.url;
  cookie = started.cookie;
  principalId = started.principalId;
});

after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
  if (previousRunner === undefined) delete process.env.LOOP_RUNNER;
  else process.env.LOOP_RUNNER = previousRunner;
  if (previousAgents === undefined) delete process.env.LOOP_AGENTS_PATH;
  else process.env.LOOP_AGENTS_PATH = previousAgents;
  if (previousRegister === undefined) delete process.env.LOOP_ALLOW_REGISTER;
  else process.env.LOOP_ALLOW_REGISTER = previousRegister;
  if (previousDb === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDb;
});

const headers = () => jsonHeaders(cookie);

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

async function postTask(roomId: string, body: string) {
  const response = await fetch(`${url}/messages`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ roomId, body }),
  });
  assert.equal(response.status, 201);
  const message = await response.json() as Message;
  assert.equal(message.body.kind, 'task');
  if (message.body.kind !== 'task') throw new Error('expected task');
  return message.body.taskId;
}

test('an owner adds an agent from the catalog and a /task @name routes to it', async () => {
  const added = await fetch(`${url}/rooms/default/agents`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ catalogId: 'probe', name: 'scout' }),
  });
  assert.equal(added.status, 201);
  const agent = await added.json() as RoomAgent;
  assert.equal(agent.name, 'scout');
  assert.equal(agent.catalogId, 'probe');
  const id = await postTask('default', '/task @scout Named scout :: proof');
  const task = await waitTask(id, 'done');
  assert.equal(task.agentId, 'scout');
  assert.equal(task.claimedBy, 'probe');
  assert.equal(task.result, probeToken);
  assert.notEqual(task.result, echoToken);
});

test('a non-owner member gets 403 on add', async () => {
  const registered = await fetch(`${url}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'member@loop.local', password: 'password1', displayName: 'Member' }),
  });
  assert.equal(registered.status, 201);
  const setCookie = registered.headers.get('set-cookie') ?? '';
  const token = /loop_session=([^;]+)/.exec(setCookie)?.[1];
  assert.ok(token);
  const denied = await fetch(`${url}/rooms/default/agents`, {
    method: 'POST',
    headers: jsonHeaders(`loop_session=${token}`),
    body: JSON.stringify({ catalogId: 'probe', name: 'intruder' }),
  });
  assert.equal(denied.status, 403);
  const ownerAdds = await fetch(`${url}/rooms/default/agents`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ catalogId: 'probe', name: 'intruder' }),
  });
  assert.equal(ownerAdds.status, 201);
});

test('an agent registered in room A cannot be addressed from room B', async () => {
  const db = app.get(Database);
  db.sqlite.exec("INSERT INTO rooms (id) VALUES ('other')");
  db.sqlite.prepare('INSERT INTO room_members (room_id, principal_id, role) VALUES (?, ?, ?)')
    .run('other', principalId, 'owner');
  const added = await fetch(`${url}/rooms/default/agents`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ catalogId: 'probe', name: 'scoped' }),
  });
  assert.equal(added.status, 201);
  const foreignId = await postTask('other', '/task @scoped from B :: proof');
  const foreign = await waitTask(foreignId, 'failed');
  assert.match(foreign.error ?? '', /Unknown agent scoped/);
  assert.equal(foreign.result, null);
  const homeId = await postTask('default', '/task @scoped from A :: proof');
  const home = await waitTask(homeId, 'done');
  assert.equal(home.result, probeToken);
  assert.equal(home.agentId, 'scoped');
});

test('a duplicate name returns 400', async () => {
  const first = await fetch(`${url}/rooms/default/agents`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ catalogId: 'probe', name: 'duped' }),
  });
  assert.equal(first.status, 201);
  const duplicate = await fetch(`${url}/rooms/default/agents`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ catalogId: 'echo', name: 'duped' }),
  });
  assert.equal(duplicate.status, 400);
  const body = await duplicate.json() as { message?: string };
  assert.match(body.message ?? '', /already exists/i);
});
