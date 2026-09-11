import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { MessageSnapshot, RoomAgent, RoomsSnapshot, Task } from '@loop/types';
import { Database } from '../src/database';
import { jsonHeaders, startAuthedApp } from './helpers';

let app: INestApplication;
let url: string;
let cookie: string;
let dir: string;
const previousDb = process.env.DATABASE_PATH;
const previousRegister = process.env.LOOP_ALLOW_REGISTER;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'loop-rooms-'));
  process.env.DATABASE_PATH = join(dir, 'loop.sqlite');
  process.env.LOOP_ALLOW_REGISTER = '1';
  const started = await startAuthedApp();
  app = started.app;
  url = started.url;
  cookie = started.cookie;
});

after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
  if (previousDb === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDb;
  if (previousRegister === undefined) delete process.env.LOOP_ALLOW_REGISTER;
  else process.env.LOOP_ALLOW_REGISTER = previousRegister;
});

const headers = () => jsonHeaders(cookie);

test('GET /rooms lists only rooms the caller belongs to', async () => {
  const db = app.get(Database);
  db.sqlite.exec("INSERT INTO rooms (id, name) VALUES ('secret', 'Secret')");
  const listed = await fetch(`${url}/rooms`, { headers: { Cookie: cookie } });
  assert.equal(listed.status, 200);
  const body = await listed.json() as RoomsSnapshot;
  assert.equal(body.rooms.some((room) => room.id === 'secret'), false);
  assert.ok(body.rooms.some((room) => room.id === 'default'));
});

test('POST /rooms makes the creator an owner who can enter', async () => {
  const created = await fetch(`${url}/rooms`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ name: 'Klonk' }),
  });
  assert.equal(created.status, 201);
  const room = await created.json() as { id: string; name: string; role: string };
  assert.equal(room.id, 'klonk');
  assert.equal(room.name, 'Klonk');
  assert.equal(room.role, 'owner');
  const listed = await fetch(`${url}/rooms`, { headers: { Cookie: cookie } });
  const body = await listed.json() as RoomsSnapshot;
  const row = body.rooms.find((item) => item.id === 'klonk');
  assert.ok(row);
  assert.equal(row?.role, 'owner');
  const posted = await fetch(`${url}/messages`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ roomId: 'klonk', body: 'hello from klonk' }),
  });
  assert.equal(posted.status, 201);
});

test('a message posted in one room is not listed in another', async () => {
  const created = await fetch(`${url}/rooms`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ name: 'Isolated' }),
  });
  assert.equal(created.status, 201);
  const room = await created.json() as { id: string };
  const posted = await fetch(`${url}/messages`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ roomId: room.id, body: 'secret-in-isolated' }),
  });
  assert.equal(posted.status, 201);
  const home = await fetch(`${url}/messages?roomId=default`, { headers: { Cookie: cookie } });
  assert.equal(home.status, 200);
  const snapshot = await home.json() as MessageSnapshot;
  assert.equal(snapshot.messages.some((message) => {
    return message.body.kind === 'text' && message.body.text === 'secret-in-isolated';
  }), false);
  const there = await fetch(`${url}/messages?roomId=${room.id}`, { headers: { Cookie: cookie } });
  const isolated = await there.json() as MessageSnapshot;
  assert.equal(isolated.messages.some((message) => {
    return message.body.kind === 'text' && message.body.text === 'secret-in-isolated';
  }), true);
});

test('a new room is seeded with catalog agents', async () => {
  const created = await fetch(`${url}/rooms`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ name: 'Crewed' }),
  });
  assert.equal(created.status, 201);
  const room = await created.json() as { id: string };
  const listed = await fetch(`${url}/rooms/${room.id}/agents`, { headers: { Cookie: cookie } });
  assert.equal(listed.status, 200);
  const body = await listed.json() as { agents: RoomAgent[] };
  assert.ok(body.agents.some((agent) => agent.catalogId === 'echo'));
  assert.ok(body.agents.length > 0);
});

test('POST /tasks with a foreign roomId is rejected and writes no row', async () => {
  const db = app.get(Database);
  db.sqlite.exec("INSERT INTO rooms (id, name) VALUES ('foreign', 'Foreign')");
  const denied = await fetch(`${url}/tasks`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ title: 'Sneak', definitionOfDone: 'proof', roomId: 'foreign' }),
  });
  assert.ok(denied.status === 403 || denied.status === 404);
  const count = db.sqlite.prepare('SELECT count(*) AS n FROM tasks WHERE room_id = ?').get('foreign') as { n: number };
  assert.equal(count.n, 0);
});

test('POST /rooms collision is 409 and empty slug is 400', async () => {
  const first = await fetch(`${url}/rooms`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ name: 'Unique One' }),
  });
  assert.equal(first.status, 201);
  const clash = await fetch(`${url}/rooms`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ name: 'Unique One' }),
  });
  assert.equal(clash.status, 409);
  const empty = await fetch(`${url}/rooms`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ name: '!!!' }),
  });
  assert.equal(empty.status, 400);
});

test('POST /tasks without roomId still creates in default', async () => {
  const created = await fetch(`${url}/tasks`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ title: 'Default room task', definitionOfDone: 'proof' }),
  });
  assert.equal(created.status, 201);
  const task = await created.json() as Task;
  assert.equal(task.roomId, 'default');
});
