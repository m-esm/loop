import { test, expect, type BrowserContext } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import type { Task } from '@loop/types';
import { authedContext, seedSession, withAuth } from './auth';

test('Chat and Tasks tabs show needs-human and active counts, and hide at zero', async ({ browser, request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-tab-badges-'));
  const session = seedSession(join(dir, 'loop.sqlite'));
  const request = withAuth(raw, session.token);
  let api: ChildProcess | undefined;
  let output = '';
  const contexts: BrowserContext[] = [];
  const apiUrl = 'http://127.0.0.1:3101/api';
  const expectedTasks = () => 0;
  async function startApi() {
    api = spawn(process.execPath, ['dist/src/main.js'], {
      cwd: resolve('apps/api'),
      env: { ...process.env, PORT: '3101', WEB_ORIGIN: 'http://127.0.0.1:3100', DATABASE_PATH: join(dir, 'loop.sqlite'), LOOP_RUNNER: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    api.stdout?.on('data', (chunk) => { output += chunk; });
    api.stderr?.on('data', (chunk) => { output += chunk; });
    await expect.poll(async () => {
      if (api?.exitCode != null) throw new Error(output);
      return request.get(`${apiUrl}/tasks`)
        .then(async (response) => (response.status() === 200
          && ((await response.json()) as { tasks: unknown[] }).tasks.length === expectedTasks() ? 200 : 0))
        .catch(() => 0);
    }).toBe(200);
  }
  async function stopApi() {
    if (!api || api.exitCode !== null) return;
    const exited = once(api, 'exit');
    api.kill('SIGKILL');
    await exited;
  }
  async function createTask(title: string) {
    const response = await request.post(`${apiUrl}/tasks`, {
      data: { title, definitionOfDone: 'proof' },
    });
    expect(response.status()).toBe(201);
    return response.json() as Promise<Task>;
  }
  try {
    await startApi();
    const context = await authedContext(browser, session.token);
    contexts.push(context);
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:3100');
    await expect(page.locator('[data-live]')).toHaveAttribute('data-live', '1');
    await expect(page.locator('[data-tab-badge]')).toHaveCount(0);

    const parked = await createTask('Park me');
    const extra = await createTask('Keep running');
    const third = await createTask('Also queued');
    await expect(page.locator('[data-tab-badge="tasks"]')).toHaveText('3');
    await expect(page.locator('[data-tab-badge="tasks"]')).toHaveAttribute('aria-label', '3 tasks running');
    await expect(page.locator('[data-tab-badge="chat"]')).toHaveCount(0);

    expect((await request.patch(`${apiUrl}/tasks/${parked.id}/status`, { data: { status: 'needs_input' } })).status()).toBe(200);
    await expect(page.locator('[data-tab-badge="chat"]')).toHaveText('1');
    await expect(page.locator('[data-tab-badge="chat"]')).toHaveAttribute('aria-label', '1 task needs a human');
    await expect(page.locator('[data-tab-badge="tasks"]')).toHaveText('3');

    expect((await request.patch(`${apiUrl}/tasks/${extra.id}/status`, { data: { status: 'needs_input' } })).status()).toBe(200);
    await expect(page.locator('[data-tab-badge="chat"]')).toHaveText('2');
    await expect(page.locator('[data-tab-badge="chat"]')).toHaveAttribute('aria-label', '2 tasks need a human');
    await expect(page.locator('[data-tab-badge="tasks"]')).toHaveText('3');
    await expect(page.getByRole('button', { name: 'Tasks', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Chat', exact: true })).toBeVisible();
    await page.screenshot({ path: resolve('docs/screenshots/tab-badges.png') });

    expect((await request.patch(`${apiUrl}/tasks/${parked.id}/status`, { data: { status: 'done' } })).status()).toBe(200);
    expect((await request.patch(`${apiUrl}/tasks/${extra.id}/status`, { data: { status: 'done' } })).status()).toBe(200);
    expect((await request.patch(`${apiUrl}/tasks/${third.id}/status`, { data: { status: 'done' } })).status()).toBe(200);
    await expect(page.locator('[data-tab-badge]')).toHaveCount(0);
  } finally {
    await Promise.all(contexts.map((ctx) => ctx.close()));
    await stopApi();
    rmSync(dir, { recursive: true, force: true });
  }
});
