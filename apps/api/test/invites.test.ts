import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { INestApplication } from '@nestjs/common';
import type { Message } from '@loop/types';
import { Database } from '../src/database';
import { hashToken } from '../src/auth-crypto';
import { jsonHeaders, startAuthedApp } from './helpers';

let app: INestApplication;
let url: string;
let cookie: string;
let principalId: string;
const previousRegister = process.env.LOOP_ALLOW_REGISTER;
const previousDb = process.env.DATABASE_PATH;

before(async () => {
  process.env.DATABASE_PATH = ':memory:';
  delete process.env.LOOP_ALLOW_REGISTER;
  const started = await startAuthedApp();
  app = started.app;
  url = started.url;
  cookie = started.cookie;
  principalId = started.principalId;
});

after(async () => {
  await app.close();
  if (previousRegister === undefined) delete process.env.LOOP_ALLOW_REGISTER;
  else process.env.LOOP_ALLOW_REGISTER = previousRegister;
  if (previousDb === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDb;
});

const headers = () => jsonHeaders(cookie);

async function invite(email: string, role = 'member', room = 'default') {
  const response = await fetch(`${url}/rooms/${room}/invites`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ email, role }),
  });
  return response;
}

test('owner invites, invitee registers with the token, lands as a member of that room and can post there', async () => {
  const db = app.get(Database);
  db.sqlite.exec("INSERT INTO rooms (id) VALUES ('other')");
  db.sqlite.prepare('INSERT INTO room_members (room_id, principal_id, role) VALUES (?, ?, ?)')
    .run('other', principalId, 'owner');
  const created = await invite('ada@x.com', 'member', 'other');
  assert.equal(created.status, 201);
  const body = await created.json() as { id: string; email: string; role: string; token: string };
  assert.equal(body.email, 'ada@x.com');
  assert.equal(body.role, 'member');
  assert.equal(typeof body.token, 'string');
  assert.ok(body.token.length > 20);
  const registered = await fetch(`${url}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'Ada@x.com', password: 'password1', displayName: 'Ada', inviteToken: body.token,
    }),
  });
  assert.equal(registered.status, 201);
  const setCookie = registered.headers.get('set-cookie') ?? '';
  const token = /loop_session=([^;]+)/.exec(setCookie)?.[1];
  assert.ok(token);
  const posted = await fetch(`${url}/messages`, {
    method: 'POST', headers: jsonHeaders(`loop_session=${token}`),
    body: JSON.stringify({ roomId: 'other', body: 'hello from invitee' }),
  });
  assert.equal(posted.status, 201);
  const message = await posted.json() as Message;
  assert.equal(message.body.kind, 'text');
  const deniedDefault = await fetch(`${url}/messages`, {
    method: 'POST', headers: jsonHeaders(`loop_session=${token}`),
    body: JSON.stringify({ roomId: 'default', body: 'should not land here' }),
  });
  assert.equal(deniedDefault.status, 403);
});

test('a non-owner member gets 403 on POST invites', async () => {
  const created = await invite('member@loop.local');
  assert.equal(created.status, 201);
  const body = await created.json() as { token: string };
  const registered = await fetch(`${url}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'member@loop.local', password: 'password1', displayName: 'Member', inviteToken: body.token,
    }),
  });
  assert.equal(registered.status, 201);
  const setCookie = registered.headers.get('set-cookie') ?? '';
  const token = /loop_session=([^;]+)/.exec(setCookie)?.[1];
  assert.ok(token);
  const denied = await fetch(`${url}/rooms/default/invites`, {
    method: 'POST',
    headers: jsonHeaders(`loop_session=${token}`),
    body: JSON.stringify({ email: 'intruder@loop.local', role: 'member' }),
  });
  assert.equal(denied.status, 403);
  const ownerAdds = await invite('second@loop.local');
  assert.equal(ownerAdds.status, 201);
});

test('the same token used twice fails the second time', async () => {
  const created = await invite('once@x.com');
  assert.equal(created.status, 201);
  const body = await created.json() as { token: string };
  const first = await fetch(`${url}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'once@x.com', password: 'password1', displayName: 'Once', inviteToken: body.token,
    }),
  });
  assert.equal(first.status, 201);
  const second = await fetch(`${url}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'once@x.com', password: 'password1', displayName: 'Again', inviteToken: body.token,
    }),
  });
  assert.equal(second.status, 400);
  const failed = await second.json() as { message?: string };
  assert.equal(failed.message, 'That invite is not valid');
});

test('a token for a@x.com used by b@x.com fails', async () => {
  const created = await invite('a@x.com');
  assert.equal(created.status, 201);
  const body = await created.json() as { token: string };
  const mismatch = await fetch(`${url}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'b@x.com', password: 'password1', displayName: 'Bob', inviteToken: body.token,
    }),
  });
  assert.equal(mismatch.status, 400);
  const failed = await mismatch.json() as { message?: string };
  assert.equal(failed.message, 'That invite is not valid');
});

test('GET /rooms/:room/invites response contains neither the raw token nor the hash', async () => {
  const created = await invite('listed@x.com');
  assert.equal(created.status, 201);
  const body = await created.json() as { id: string; token: string };
  const listed = await fetch(`${url}/rooms/default/invites`, { headers: { Cookie: cookie } });
  assert.equal(listed.status, 200);
  const payload = await listed.json() as {
    invites: { id: string; email: string; role: string; createdAt: string; expiresAt: string; token?: string; tokenHash?: string }[];
  };
  const raw = JSON.stringify(payload);
  assert.equal(raw.includes(body.token), false);
  assert.equal(raw.includes(hashToken(body.token)), false);
  const row = payload.invites.find((inviteRow) => inviteRow.id === body.id);
  assert.ok(row);
  assert.equal(row.email, 'listed@x.com');
  assert.equal(row.role, 'member');
  assert.equal('token' in row, false);
  assert.equal('tokenHash' in row, false);
});

test('registration with no token still says Registration is closed', async () => {
  const closed = await fetch(`${url}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'closed@loop.local', password: 'password1', displayName: 'Closed' }),
  });
  assert.equal(closed.status, 403);
  const body = await closed.json() as { message?: string };
  assert.equal(body.message, 'Registration is closed');
});

test('a revoked invite is not valid', async () => {
  const created = await invite('revoked@x.com');
  assert.equal(created.status, 201);
  const body = await created.json() as { id: string; token: string };
  const revoked = await fetch(`${url}/rooms/default/invites/${body.id}`, {
    method: 'DELETE', headers: { Cookie: cookie },
  });
  assert.equal(revoked.status, 200);
  const attempt = await fetch(`${url}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'revoked@x.com', password: 'password1', displayName: 'Revoked', inviteToken: body.token,
    }),
  });
  assert.equal(attempt.status, 400);
  const failed = await attempt.json() as { message?: string };
  assert.equal(failed.message, 'That invite is not valid');
});
