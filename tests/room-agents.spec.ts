import { test, expect, type BrowserContext } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import Sqlite from 'better-sqlite3';
import type { Message, Task } from '@loop/types';
import { authedContext, seedSession, withAuth } from './auth';

const apiUrl = 'http://127.0.0.1:3101/api';

function probeAgents(echoToken: string, probeToken: string) {
  return {
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
  };
}

test('an owner adds an agent from the catalog and a /task @name routes to it', async ({ browser, request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-room-agents-add-'));
  const session = seedSession(join(dir, 'loop.sqlite'));
  const request = withAuth(raw, session.token);
  const echoToken = `echo-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const probeToken = `probe-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  writeFileSync(join(dir, 'agents.json'), JSON.stringify(probeAgents(echoToken, probeToken)));
  const { stop } = await startApi(dir, request, { LOOP_ALLOW_REGISTER: '1' });
  const contexts: BrowserContext[] = [];
  try {
    const context = await authedContext(browser, session.token);
    contexts.push(context);
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:3100');
    await expect(page.locator('[data-live]')).toHaveAttribute('data-live', '1');
    const form = page.getByRole('form', { name: 'Add agent' });
    await expect(form).toBeVisible();
    await form.getByLabel('Catalog').selectOption('probe');
    await form.getByLabel('Name').fill('scout');
    await form.getByRole('button', { name: 'Add' }).click();
    await expect(page.locator('.room-agents li').filter({ hasText: '@scout' })).toBeVisible();
    // The panel is a component we ship, so capture it and assert the controls are
    // fully on screen: a clipped Add button passes toBeVisible and is still unusable.
    await expect(form.getByRole('button', { name: 'Add' })).toBeInViewport({ ratio: 1 });
    await expect(form.getByLabel('Catalog')).toBeInViewport({ ratio: 1 });
    await expect(page.locator('.room-agents li').filter({ hasText: '@scout' })).toBeInViewport({ ratio: 1 });

    await page.getByLabel('Message', { exact: true }).fill('/task @scout Named scout :: proof');
    const posted = page.waitForResponse((response) => response.url().endsWith('/messages') && response.request().method() === 'POST');
    await page.getByLabel('Message', { exact: true }).press('Enter');
    const cardMessage = await (await posted).json() as Message;
    if (cardMessage.body.kind !== 'task') throw new Error('Expected task card');
    const card = page.locator('.chat-task').filter({ hasText: 'Named scout' });
    await expect(card.locator('.tp-chip')).toHaveText('done', { timeout: 10_000 });
    await expect(card.locator('[data-task-result]')).toHaveText(probeToken);
    await page.screenshot({ path: 'docs/screenshots/room-agents.png' });
    const task = await (await request.get(`${apiUrl}/tasks/${cardMessage.body.taskId}`)).json() as Task;
    expect(task.agentId).toBe('scout');
    expect(task.claimedBy).toBe('probe');
    expect(task.result).toBe(probeToken);
    expect(task.result).not.toBe(echoToken);
  } finally {
    await Promise.all(contexts.map((item) => item.close()));
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a non-owner member gets 403 on add', async ({ request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-room-agents-403-'));
  const session = seedSession(join(dir, 'loop.sqlite'));
  const request = withAuth(raw, session.token);
  writeFileSync(join(dir, 'agents.json'), JSON.stringify(probeAgents('echo-tok', 'probe-tok')));
  const { stop } = await startApi(dir, request, { LOOP_ALLOW_REGISTER: '1' });
  try {
    const registered = await raw.post(`${apiUrl}/auth/register`, {
      data: { email: 'member@loop.local', password: 'password1', displayName: 'Member' },
    });
    expect(registered.status()).toBe(201);
    const setCookie = registered.headers()['set-cookie'] ?? '';
    const token = /loop_session=([^;]+)/.exec(Array.isArray(setCookie) ? setCookie.join(';') : setCookie)?.[1];
    if (!token) throw new Error('expected session cookie');
    const member = withAuth(raw, token);
    const denied = await member.post(`${apiUrl}/rooms/default/agents`, {
      data: { catalogId: 'probe', name: 'intruder' },
    });
    expect(denied.status()).toBe(403);
    const added = await request.post(`${apiUrl}/rooms/default/agents`, {
      data: { catalogId: 'probe', name: 'intruder' },
    });
    expect(added.status()).toBe(201);
  } finally {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an agent registered in room A cannot be addressed from room B', async ({ request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-room-agents-scope-'));
  const dbPath = join(dir, 'loop.sqlite');
  const session = seedSession(dbPath);
  const sqlite = new Sqlite(dbPath);
  sqlite.prepare('INSERT INTO rooms (id) VALUES (?)').run('other');
  sqlite.prepare('INSERT INTO room_members (room_id, principal_id, role) VALUES (?, ?, ?)').run('other', session.principalId, 'owner');
  sqlite.close();
  const request = withAuth(raw, session.token);
  const echoToken = `echo-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const probeToken = `probe-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  writeFileSync(join(dir, 'agents.json'), JSON.stringify(probeAgents(echoToken, probeToken)));
  const { stop } = await startApi(dir, request);
  try {
    const added = await request.post(`${apiUrl}/rooms/default/agents`, {
      data: { catalogId: 'probe', name: 'scout' },
    });
    expect(added.status()).toBe(201);
    const foreign = await request.post(`${apiUrl}/messages`, {
      data: { roomId: 'other', body: '/task @scout from B :: proof' },
    });
    expect(foreign.status()).toBe(201);
    const foreignMessage = await foreign.json() as Message;
    if (foreignMessage.body.kind !== 'task') throw new Error('Expected task card');
    await expect.poll(async () => {
      const task = await (await request.get(`${apiUrl}/tasks/${foreignMessage.body.taskId}`)).json() as Task;
      return task.status;
    }).toBe('failed');
    const foreignTask = await (await request.get(`${apiUrl}/tasks/${foreignMessage.body.taskId}`)).json() as Task;
    expect(foreignTask.error ?? '').toMatch(/Unknown agent scout/);
    expect(foreignTask.result).toBeNull();

    const home = await request.post(`${apiUrl}/messages`, {
      data: { roomId: 'default', body: '/task @scout from A :: proof' },
    });
    expect(home.status()).toBe(201);
    const homeMessage = await home.json() as Message;
    if (homeMessage.body.kind !== 'task') throw new Error('Expected task card');
    await expect.poll(async () => {
      const task = await (await request.get(`${apiUrl}/tasks/${homeMessage.body.taskId}`)).json() as Task;
      return task.status;
    }).toBe('done');
    const homeTask = await (await request.get(`${apiUrl}/tasks/${homeMessage.body.taskId}`)).json() as Task;
    expect(homeTask.result).toBe(probeToken);
    expect(homeTask.agentId).toBe('scout');
  } finally {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a duplicate name returns 400', async ({ request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-room-agents-dup-'));
  const session = seedSession(join(dir, 'loop.sqlite'));
  const request = withAuth(raw, session.token);
  writeFileSync(join(dir, 'agents.json'), JSON.stringify(probeAgents('echo-tok', 'probe-tok')));
  const { stop } = await startApi(dir, request);
  try {
    const first = await request.post(`${apiUrl}/rooms/default/agents`, {
      data: { catalogId: 'probe', name: 'scout' },
    });
    expect(first.status()).toBe(201);
    const duplicate = await request.post(`${apiUrl}/rooms/default/agents`, {
      data: { catalogId: 'echo', name: 'scout' },
    });
    expect(duplicate.status()).toBe(400);
    const body = await duplicate.json() as { message?: string };
    expect(body.message ?? '').toMatch(/already exists/i);
  } finally {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function startApi(
  dir: string,
  request: ReturnType<typeof withAuth>,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ stop: () => Promise<void>; output: string }> {
  let output = '';
  const api = spawn(process.execPath, ['dist/src/main.js'], {
    cwd: resolve('apps/api'),
    env: {
      ...process.env,
      PORT: '3101',
      WEB_ORIGIN: 'http://127.0.0.1:3100',
      DATABASE_PATH: join(dir, 'loop.sqlite'),
      LOOP_RUNNER: '1',
      LOOP_AGENTS_PATH: join(dir, 'agents.json'),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  api.stdout?.on('data', (chunk) => { output += chunk; });
  api.stderr?.on('data', (chunk) => { output += chunk; });
  const expectedTasks = () => 0;
  await expect.poll(async () => {
    if (api.exitCode != null) throw new Error(output);
    return request.get(`${apiUrl}/tasks`)
      .then(async (response) => (response.status() === 200
        && ((await response.json()) as { tasks: unknown[] }).tasks.length === expectedTasks() ? 200 : 0))
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
