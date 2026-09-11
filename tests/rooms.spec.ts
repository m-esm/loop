import { test, expect, type BrowserContext } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import Sqlite from 'better-sqlite3';
import type { RoomsSnapshot } from '@loop/types';
import { authedContext, seedSession, withAuth } from './auth';

const apiUrl = 'http://127.0.0.1:3101/api';

test('GET /rooms omits a room the caller does not belong to', async ({ request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-rooms-list-'));
  const dbPath = join(dir, 'loop.sqlite');
  const session = seedSession(dbPath);
  const sqlite = new Sqlite(dbPath);
  sqlite.prepare('INSERT INTO rooms (id, name) VALUES (?, ?)').run('secret', 'Secret');
  sqlite.close();
  const request = withAuth(raw, session.token);
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ agents: [] }));
  const { stop } = await startApi(dir, request);
  try {
    const listed = await request.get(`${apiUrl}/rooms`);
    expect(listed.status()).toBe(200);
    const body = await listed.json() as RoomsSnapshot;
    expect(body.rooms.some((room) => room.id === 'secret')).toBe(false);
    expect(body.rooms.some((room) => room.id === 'default')).toBe(true);
  } finally {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /rooms is transactional: the creator is an owner who can enter', async ({ request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-rooms-create-'));
  const session = seedSession(join(dir, 'loop.sqlite'));
  const request = withAuth(raw, session.token);
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ agents: [] }));
  const { stop } = await startApi(dir, request);
  try {
    const created = await request.post(`${apiUrl}/rooms`, { data: { name: 'Klonk' } });
    expect(created.status()).toBe(201);
    const room = await created.json() as { id: string; name: string; role: string };
    expect(room.id).toBe('klonk');
    expect(room.role).toBe('owner');
    const listed = await request.get(`${apiUrl}/rooms`);
    const body = await listed.json() as RoomsSnapshot;
    expect(body.rooms.find((item) => item.id === 'klonk')?.role).toBe('owner');
    const posted = await request.post(`${apiUrl}/messages`, {
      data: { roomId: 'klonk', body: 'owner can enter' },
    });
    expect(posted.status()).toBe(201);
  } finally {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a message posted in one room does not appear in another', async ({ browser, request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-rooms-ui-'));
  const session = seedSession(join(dir, 'loop.sqlite'));
  const request = withAuth(raw, session.token);
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    agents: [{ id: 'echo', name: 'Echo', command: [process.execPath, '-e', "process.stdout.write('room-ok\\n')"] }],
  }));
  const { stop } = await startApi(dir, request);
  const contexts: BrowserContext[] = [];
  try {
    const context = await authedContext(browser, session.token);
    contexts.push(context);
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:3100');
    await expect(page.locator('[data-live]')).toHaveAttribute('data-live', '1');
    await page.getByLabel('Project name').fill('Klonk');
    await page.getByRole('button', { name: 'New project' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Klonk' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Klonk' })).toHaveAttribute('aria-current', 'page');
    await page.getByLabel('Message', { exact: true }).fill('only in klonk');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.message-card').filter({ hasText: 'only in klonk' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Loop' })).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('button', { name: 'Klonk' })).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('button', { name: 'New project' })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: resolve('docs/screenshots/projects-rail.png') });
    await page.getByRole('button', { name: 'Loop' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Loop' })).toBeVisible();
    await expect(page.locator('.message-card').filter({ hasText: 'only in klonk' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Klonk' }).click();
    await expect(page.locator('.message-card').filter({ hasText: 'only in klonk' })).toBeVisible();
  } finally {
    await Promise.all(contexts.map((item) => item.close()));
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a newly created room can run /task', async ({ browser, request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-rooms-task-'));
  const session = seedSession(join(dir, 'loop.sqlite'));
  const request = withAuth(raw, session.token);
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    agents: [{ id: 'echo', name: 'Echo', command: [process.execPath, '-e', "process.stdout.write('room-ok\\n')"] }],
  }));
  const { stop } = await startApi(dir, request);
  const contexts: BrowserContext[] = [];
  try {
    const context = await authedContext(browser, session.token);
    contexts.push(context);
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:3100');
    await expect(page.locator('[data-live]')).toHaveAttribute('data-live', '1');
    await page.getByLabel('Project name').fill('Klonk');
    await page.getByRole('button', { name: 'New project' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Klonk' })).toBeVisible();
    await page.getByLabel('Message', { exact: true }).fill('/task new room work :: it finishes');
    await page.getByRole('button', { name: 'Send' }).click();
    const card = page.locator('.chat-task').filter({ has: page.locator('h3', { hasText: 'new room work' }) });
    await expect(card.locator('.tp-chip')).toHaveText('done', { timeout: 15_000 });
    await expect(card.locator('[data-task-result]')).toHaveText('room-ok');
  } finally {
    await Promise.all(contexts.map((item) => item.close()));
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /tasks with a foreign roomId is rejected', async ({ request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-rooms-foreign-'));
  const dbPath = join(dir, 'loop.sqlite');
  const session = seedSession(dbPath);
  const sqlite = new Sqlite(dbPath);
  sqlite.prepare('INSERT INTO rooms (id, name) VALUES (?, ?)').run('foreign', 'Foreign');
  sqlite.close();
  const request = withAuth(raw, session.token);
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ agents: [] }));
  const { stop } = await startApi(dir, request);
  try {
    const denied = await request.post(`${apiUrl}/tasks`, {
      data: { title: 'Sneak', definitionOfDone: 'proof', roomId: 'foreign' },
    });
    expect([403, 404]).toContain(denied.status());
    const db = new Sqlite(dbPath);
    const count = db.prepare('SELECT count(*) AS n FROM tasks WHERE room_id = ?').get('foreign') as { n: number };
    db.close();
    expect(count.n).toBe(0);
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
      LOOP_RUNNER: '1',
      LOOP_AGENTS_PATH: join(dir, 'agents.json'),
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
