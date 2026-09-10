import { test, expect, type BrowserContext } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import { hashToken } from '../apps/api/src/auth-crypto';
import { authedContext, seedSession, withAuth } from './auth';

const apiUrl = 'http://127.0.0.1:3101/api';

test('owner invites, invitee registers with the token, lands as a member of that room and can post there', async ({ browser, request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-team-invite-'));
  const session = seedSession(join(dir, 'loop.sqlite'));
  const request = withAuth(raw, session.token);
  const { stop } = await startApi(dir, request);
  const contexts: BrowserContext[] = [];
  try {
    const context = await authedContext(browser, session.token);
    contexts.push(context);
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:3100');
    await expect(page.locator('[data-live]')).toHaveAttribute('data-live', '1');
    const form = page.getByRole('form', { name: 'Invite to room' });
    await expect(form).toBeVisible();
    await form.getByLabel('Email').fill('ada@x.com');
    await form.getByLabel('Role').selectOption('member');
    await form.getByRole('button', { name: 'Invite' }).click();
    await expect(page.locator('.room-team li').filter({ hasText: 'ada@x.com' })).toBeVisible();
    await expect(page.getByText('This link is shown only now')).toBeVisible();
    await expect(form.getByLabel('Email')).toBeInViewport({ ratio: 1 });
    await expect(form.getByLabel('Role')).toBeInViewport({ ratio: 1 });
    await expect(form.getByRole('button', { name: 'Invite' })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: 'docs/screenshots/team.png' });
    const link = await page.getByLabel('Invite link').inputValue();
    const inviteToken = new URL(link).searchParams.get('invite');
    if (!inviteToken) throw new Error('expected invite token in link');

    const inviteeContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    contexts.push(inviteeContext);
    const inviteePage = await inviteeContext.newPage();
    await inviteePage.goto(link);
    const register = inviteePage.getByRole('form', { name: 'Create account' });
    await register.getByLabel('Display name').fill('Ada');
    await register.getByLabel('Email').fill('ada@x.com');
    await register.getByLabel('Password').fill('password1');
    await register.getByRole('button', { name: 'Create account' }).click();
    await expect(inviteePage.locator('[data-live]')).toHaveAttribute('data-live', '1');
    await inviteePage.getByLabel('Message', { exact: true }).fill('hello from invitee');
    await inviteePage.getByRole('button', { name: 'Send' }).click();
    await expect(inviteePage.locator('.message-card').filter({ hasText: 'hello from invitee' })).toBeVisible();
  } finally {
    await Promise.all(contexts.map((item) => item.close()));
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a non-owner member gets 403 on POST invites', async ({ request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-team-403-'));
  const session = seedSession(join(dir, 'loop.sqlite'));
  const request = withAuth(raw, session.token);
  const { stop } = await startApi(dir, request);
  try {
    const created = await request.post(`${apiUrl}/rooms/default/invites`, {
      data: { email: 'member@loop.local', role: 'member' },
    });
    expect(created.status()).toBe(201);
    const body = await created.json() as { token: string };
    const registered = await raw.post(`${apiUrl}/auth/register`, {
      data: {
        email: 'member@loop.local', password: 'password1', displayName: 'Member', inviteToken: body.token,
      },
    });
    expect(registered.status()).toBe(201);
    const setCookie = registered.headers()['set-cookie'] ?? '';
    const token = /loop_session=([^;]+)/.exec(Array.isArray(setCookie) ? setCookie.join(';') : setCookie)?.[1];
    if (!token) throw new Error('expected session cookie');
    const member = withAuth(raw, token);
    const denied = await member.post(`${apiUrl}/rooms/default/invites`, {
      data: { email: 'intruder@loop.local', role: 'member' },
    });
    expect(denied.status()).toBe(403);
  } finally {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the same token used twice fails the second time', async ({ request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-team-twice-'));
  const session = seedSession(join(dir, 'loop.sqlite'));
  const request = withAuth(raw, session.token);
  const { stop } = await startApi(dir, request);
  try {
    const created = await request.post(`${apiUrl}/rooms/default/invites`, {
      data: { email: 'once@x.com', role: 'member' },
    });
    expect(created.status()).toBe(201);
    const body = await created.json() as { token: string };
    const first = await raw.post(`${apiUrl}/auth/register`, {
      data: {
        email: 'once@x.com', password: 'password1', displayName: 'Once', inviteToken: body.token,
      },
    });
    expect(first.status()).toBe(201);
    const second = await raw.post(`${apiUrl}/auth/register`, {
      data: {
        email: 'once@x.com', password: 'password1', displayName: 'Again', inviteToken: body.token,
      },
    });
    expect(second.status()).toBe(400);
    const failed = await second.json() as { message?: string };
    expect(failed.message).toBe('That invite is not valid');
  } finally {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a token for a@x.com used by b@x.com fails', async ({ request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-team-email-'));
  const session = seedSession(join(dir, 'loop.sqlite'));
  const request = withAuth(raw, session.token);
  const { stop } = await startApi(dir, request);
  try {
    const created = await request.post(`${apiUrl}/rooms/default/invites`, {
      data: { email: 'a@x.com', role: 'member' },
    });
    expect(created.status()).toBe(201);
    const body = await created.json() as { token: string };
    const mismatch = await raw.post(`${apiUrl}/auth/register`, {
      data: {
        email: 'b@x.com', password: 'password1', displayName: 'Bob', inviteToken: body.token,
      },
    });
    expect(mismatch.status()).toBe(400);
    const failed = await mismatch.json() as { message?: string };
    expect(failed.message).toBe('That invite is not valid');
  } finally {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /rooms/:room/invites response contains neither the raw token nor the hash', async ({ request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-team-list-'));
  const session = seedSession(join(dir, 'loop.sqlite'));
  const request = withAuth(raw, session.token);
  const { stop } = await startApi(dir, request);
  try {
    const created = await request.post(`${apiUrl}/rooms/default/invites`, {
      data: { email: 'listed@x.com', role: 'member' },
    });
    expect(created.status()).toBe(201);
    const body = await created.json() as { id: string; token: string };
    const listed = await request.get(`${apiUrl}/rooms/default/invites`);
    expect(listed.status()).toBe(200);
    const payload = await listed.json() as { invites: Record<string, unknown>[] };
    const rawBody = JSON.stringify(payload);
    expect(rawBody.includes(body.token)).toBe(false);
    expect(rawBody.includes(hashToken(body.token))).toBe(false);
    const row = payload.invites.find((invite) => invite.id === body.id);
    expect(row).toBeTruthy();
    expect(row).not.toHaveProperty('token');
    expect(row).not.toHaveProperty('tokenHash');
  } finally {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('registration with no token still says Registration is closed', async ({ request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-team-closed-'));
  const session = seedSession(join(dir, 'loop.sqlite'));
  const request = withAuth(raw, session.token);
  const { stop } = await startApi(dir, request);
  try {
    const closed = await raw.post(`${apiUrl}/auth/register`, {
      data: { email: 'closed@loop.local', password: 'password1', displayName: 'Closed' },
    });
    expect(closed.status()).toBe(403);
    const body = await closed.json() as { message?: string };
    expect(body.message).toBe('Registration is closed');
  } finally {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a revoked invite is not valid', async ({ request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-team-revoke-'));
  const session = seedSession(join(dir, 'loop.sqlite'));
  const request = withAuth(raw, session.token);
  const { stop } = await startApi(dir, request);
  try {
    const created = await request.post(`${apiUrl}/rooms/default/invites`, {
      data: { email: 'revoked@x.com', role: 'member' },
    });
    expect(created.status()).toBe(201);
    const body = await created.json() as { id: string; token: string };
    const revoked = await request.delete(`${apiUrl}/rooms/default/invites/${body.id}`);
    expect(revoked.status()).toBe(200);
    const attempt = await raw.post(`${apiUrl}/auth/register`, {
      data: {
        email: 'revoked@x.com', password: 'password1', displayName: 'Revoked', inviteToken: body.token,
      },
    });
    expect(attempt.status()).toBe(400);
    const failed = await attempt.json() as { message?: string };
    expect(failed.message).toBe('That invite is not valid');
  } finally {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function startApi(
  dir: string,
  request: ReturnType<typeof withAuth>,
): Promise<{ stop: () => Promise<void>; output: string }> {
  let output = '';
  const api = spawn(process.execPath, ['dist/src/main.js'], {
    cwd: resolve('apps/api'),
    env: {
      ...process.env,
      PORT: '3101',
      WEB_ORIGIN: 'http://127.0.0.1:3100',
      DATABASE_PATH: join(dir, 'loop.sqlite'),
      LOOP_RUNNER: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  api.stdout?.on('data', (chunk) => { output += chunk; });
  api.stderr?.on('data', (chunk) => { output += chunk; });
  await expect.poll(async () => {
    if (api.exitCode != null) throw new Error(output);
    return request.get(`${apiUrl}/tasks`)
      .then(async (response) => (response.status() === 200
        && ((await response.json()) as { tasks: unknown[] }).tasks.length === 0 ? 200 : 0))
      .catch(() => 0);
  }).toBe(200);
  return {
    output,
    stop: async () => {
      if (!api || api.exitCode !== null) return;
      const exited = once(api, 'exit');
      api.kill('SIGKILL');
      await exited;
    },
  };
}
