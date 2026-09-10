import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { Task, TaskEvent } from '@loop/types';
import { createApp } from '../src/app';
import { Database } from '../src/database';
import { TaskStore } from '../src/task-store';
import { hashToken } from '../src/auth-crypto';
import { OPERATOR, seedOperator } from '../src/session-seed';
import { jsonHeaders, startAuthedApp } from './helpers';

test('GET /health is public', async () => {
  process.env.DATABASE_PATH = ':memory:';
  const app = await createApp(false);
  await app.listen(0, '127.0.0.1');
  try {
    const url = `${await app.getUrl()}/api`;
    const response = await fetch(`${url}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  } finally { await app.close(); }
});

test('an anonymous request to GET /tasks is rejected', async () => {
  process.env.DATABASE_PATH = ':memory:';
  const app = await createApp(false);
  await app.listen(0, '127.0.0.1');
  try {
    const response = await fetch(`${await app.getUrl()}/api/tasks`);
    assert.equal(response.status, 401);
  } finally { await app.close(); }
});

test('an anonymous EventSource is rejected', async () => {
  process.env.DATABASE_PATH = ':memory:';
  const app = await createApp(false);
  await app.listen(0, '127.0.0.1');
  try {
    const response = await fetch(`${await app.getUrl()}/api/stream?since=0`);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('content-type')?.includes('event-stream'), false);
  } finally { await app.close(); }
});

test('reviewedBy in the body is ignored; the session identity is recorded', async () => {
  process.env.DATABASE_PATH = ':memory:';
  const { app, url, cookie, principalId } = await startAuthedApp();
  try {
    const created = await fetch(`${url}/tasks`, {
      method: 'POST', headers: jsonHeaders(cookie),
      body: JSON.stringify({ title: 'Review me', definitionOfDone: 'proof' }),
    });
    assert.equal(created.status, 201);
    const task = await created.json() as Task;
    assert.equal(task.owner, OPERATOR.displayName);
    assert.equal(task.ownerPrincipalId, principalId);
    assert.equal((await fetch(`${url}/tasks/${task.id}/status`, {
      method: 'PATCH', headers: jsonHeaders(cookie), body: JSON.stringify({ status: 'done' }),
    })).status, 200);
    const reviewed = await fetch(`${url}/tasks/${task.id}/review`, {
      method: 'POST', headers: jsonHeaders(cookie),
      body: JSON.stringify({ verdict: 'accepted', reviewedBy: 'Someone Else' }),
    });
    assert.equal(reviewed.status, 200);
    const body = await reviewed.json() as Task;
    assert.equal(body.verdict, 'accepted');
    assert.equal(body.verdictBy, OPERATOR.displayName);
    assert.equal(body.verdictByPrincipalId, principalId);
    assert.notEqual(body.verdictBy, 'Someone Else');
  } finally { await app.close(); }
});

test('logout stops an already-open stream', async () => {
  process.env.DATABASE_PATH = ':memory:';
  const { app, url, cookie } = await startAuthedApp();
  try {
    const controller = new AbortController();
    const stream = await fetch(`${url}/stream?since=0`, {
      headers: { Cookie: cookie }, signal: controller.signal,
    });
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    const reading = reader.read();
    assert.equal((await fetch(`${url}/auth/logout`, {
      method: 'POST', headers: { Cookie: cookie },
    })).status, 200);
    const result = await Promise.race([
      reading.then((chunk) => ({ kind: 'chunk' as const, chunk })),
      new Promise<{ kind: 'timeout' }>((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), 2000)),
    ]);
    if (result.kind === 'timeout') {
      controller.abort();
      await reader.cancel().catch(() => {});
      assert.fail('stream was still open 2s after logout');
    }
    assert.equal(result.chunk.done, true);
    controller.abort();
    await reader.cancel().catch(() => {});
  } finally { await app.close(); }
});

test('a session survives an API restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-session-'));
  const path = join(dir, 'loop.sqlite');
  process.env.DATABASE_PATH = path;
  let first: INestApplication | undefined;
  let second: INestApplication | undefined;
  try {
    first = await createApp(false);
    await first.listen(0, '127.0.0.1');
    const seeded = seedOperator(first.get(Database).sqlite);
    const cookie = `loop_session=${seeded.token}`;
    const url1 = `${await first.getUrl()}/api`;
    assert.equal((await fetch(`${url1}/tasks`, { headers: { Cookie: cookie } })).status, 200);
    await first.close();
    first = undefined;
    process.env.DATABASE_PATH = path;
    second = await createApp(false);
    await second.listen(0, '127.0.0.1');
    const url2 = `${await second.getUrl()}/api`;
    const me = await fetch(`${url2}/auth/me`, { headers: { Cookie: cookie } });
    assert.equal(me.status, 200);
    const body = await me.json() as { id: string; displayName: string };
    assert.equal(body.id, seeded.principalId);
    assert.equal(body.displayName, OPERATOR.displayName);
    assert.equal((await fetch(`${url2}/tasks`, { headers: { Cookie: cookie } })).status, 200);
  } finally {
    await first?.close();
    await second?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('registration closes after the first human unless LOOP_ALLOW_REGISTER=1', async () => {
  process.env.DATABASE_PATH = ':memory:';
  delete process.env.LOOP_ALLOW_REGISTER;
  const app = await createApp(false);
  await app.listen(0, '127.0.0.1');
  const url = `${await app.getUrl()}/api`;
  try {
    const first = await fetch(`${url}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@loop.local', password: 'password1', displayName: 'Ada' }),
    });
    assert.equal(first.status, 201);
    const setCookie = first.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /loop_session=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    const closed = await fetch(`${url}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'b@loop.local', password: 'password1', displayName: 'Bob' }),
    });
    assert.equal(closed.status, 403);
    process.env.LOOP_ALLOW_REGISTER = '1';
    const extra = await fetch(`${url}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'b@loop.local', password: 'password1', displayName: 'Bob' }),
    });
    assert.equal(extra.status, 201);
  } finally {
    delete process.env.LOOP_ALLOW_REGISTER;
    await app.close();
  }
});

test('login and me round-trip the session cookie; a human decision rejects an agent principal', async () => {
  process.env.DATABASE_PATH = ':memory:';
  const { app, url, cookie, principalId } = await startAuthedApp();
  try {
    const logged = await fetch(`${url}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: OPERATOR.email, password: OPERATOR.password }),
    });
    assert.equal(logged.status, 200);
    const me = await fetch(`${url}/auth/me`, { headers: { Cookie: cookie } });
    assert.equal(me.status, 200);
    const identity = await me.json() as { id: string; kind: string; displayName: string };
    assert.equal(identity.id, principalId);
    assert.equal(identity.kind, 'human');
    const store = app.get(TaskStore);
    const task = store.create({ title: 'Decide', owner: 'Moshe', definitionOfDone: 'proof' });
    const claimed = store.claim(task.id, 'echo')!;
    store.propose(claimed.id, claimed.runId!, {
      question: 'Which store?', options: ['SQLite', 'Postgres'], pick: 'SQLite', why: 'one file',
    });
    const db = app.get(Database);
    const agentToken = 'a'.repeat(64);
    const ts = new Date().toISOString();
    const echo = db.sqlite.prepare('SELECT id FROM principals WHERE id = ?').get('echo') as { id: string } | undefined;
    if (!echo) {
      db.sqlite.prepare('INSERT INTO principals (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)')
        .run('echo', 'agent', 'Echo', ts);
    }
    db.sqlite.prepare(
      'INSERT INTO sessions (token_hash, principal_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    ).run(hashToken(agentToken), 'echo', ts, new Date(Date.now() + 86400000).toISOString());
    db.sqlite.prepare('INSERT OR IGNORE INTO room_members (room_id, principal_id, role) VALUES (?, ?, ?)')
      .run('default', 'echo', 'member');
    const asAgent = await fetch(`${url}/tasks/${task.id}/decide`, {
      method: 'POST',
      headers: jsonHeaders(`loop_session=${agentToken}`),
      body: JSON.stringify({ choice: 'SQLite' }),
    });
    assert.equal(asAgent.status, 403);
  } finally { await app.close(); }
});

test('the stream only replays events from rooms the caller belongs to', async () => {
  process.env.DATABASE_PATH = ':memory:';
  const { app, url, cookie } = await startAuthedApp();
  try {
    const created = await fetch(`${url}/tasks`, {
      method: 'POST', headers: jsonHeaders(cookie),
      body: JSON.stringify({ title: 'In default', definitionOfDone: 'proof' }),
    });
    assert.equal(created.status, 201);
    const db = app.get(Database);
    db.sqlite.exec("INSERT INTO rooms (id) VALUES ('other')");
    const ts = new Date().toISOString();
    db.sqlite.prepare(
      'INSERT INTO events (room_id, ts, kind, payload) VALUES (?, ?, ?, ?)',
    ).run('other', ts, 'task_created', JSON.stringify({ task: { id: 'secret', title: 'Secret', roomId: 'other' } }));
    const controller = new AbortController();
    const stream = await fetch(`${url}/stream?since=0`, {
      headers: { Cookie: cookie }, signal: controller.signal,
    });
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    let buffer = '';
    const events: TaskEvent[] = [];
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && events.length < 2) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), 200)),
      ]);
      if (chunk.done && !chunk.value) break;
      if (chunk.value) buffer += new TextDecoder().decode(chunk.value);
      let end: number;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame.split('\n').find((line) => line.startsWith('data: '));
        if (data) events.push(JSON.parse(data.slice(6)) as TaskEvent);
      }
    }
    controller.abort();
    await reader.cancel().catch(() => {});
    assert.ok(events.some((event) => event.payload && 'task' in event.payload && event.payload.task.title === 'In default'));
    assert.equal(events.some((event) => event.room_id === 'other'), false);
  } finally { await app.close(); }
});
