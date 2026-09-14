import { test, expect, type BrowserContext } from '@playwright/test';
import type { Task } from '@loop/types';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { authedContext, seedSession, withAuth } from './auth';

test('Inbox stays home, orders cross-room parked work, opens Task detail, and updates to empty', async ({ browser, request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-inbox-browser-'));
  const session = seedSession(join(dir, 'loop.sqlite'));
  const request = withAuth(raw, session.token);
  const apiUrl = 'http://127.0.0.1:3101/api';
  let context: BrowserContext | undefined;
  let output = '';
  const api = spawn(process.execPath, ['dist/src/main.js'], {
    cwd: resolve('apps/api'),
    env: { ...process.env, PORT: '3101', WEB_ORIGIN: 'http://127.0.0.1:3100',
      DATABASE_PATH: join(dir, 'loop.sqlite'), LOOP_RUNNER: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  api.stdout?.on('data', (chunk) => { output += chunk; });
  api.stderr?.on('data', (chunk) => { output += chunk; });
  try {
    await expect.poll(async () => {
      if (api.exitCode !== null) throw new Error(output);
      return request.get(`${apiUrl}/rooms/default`).then((response) => response.status()).catch(() => 0);
    }).toBe(200);
    const roomResponse = await request.post(`${apiUrl}/rooms`, { data: { name: 'Launch' } });
    expect(roomResponse.status()).toBe(201);
    const room = await roomResponse.json();
    const tasks: Task[] = [];
    for (const [title, roomId] of [['Choose the release scope', room.id], ['Confirm the room copy', 'default']]) {
      const response = await request.post(`${apiUrl}/tasks`, {
        data: { title, definitionOfDone: 'The human decision is recorded.', roomId },
      });
      expect(response.status()).toBe(201);
      const task = await response.json() as Task;
      expect((await request.patch(`${apiUrl}/tasks/${task.id}/status`, { data: { status: 'needs_input' } })).ok()).toBeTruthy();
      tasks.push(task);
    }
    context = await authedContext(browser, session.token);
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:3100/');
    const inbox = page.getByRole('region', { name: 'Inbox', exact: true });
    const rows = inbox.locator('[data-task-id]');
    await expect(page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible();
    await expect(page.locator('[data-live]')).toHaveAttribute('data-live', '1');
    await expect(page).toHaveURL('http://127.0.0.1:3100/');
    await expect(page.locator('#projects-rail [aria-current]')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Chat', exact: true })).toHaveCount(0);
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText(tasks[0].title);
    await expect(rows.nth(1)).toContainText(tasks[1].title);
    await expect(rows.nth(0)).toContainText('Launch');
    await expect(page.getByRole('complementary', { name: 'Projects', exact: true })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Context panel', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Project name')).toHaveCount(0);
    await page.screenshot({ path: resolve('docs/screenshots/inbox.png') });
    await rows.first().click();
    await expect(page).toHaveURL(`http://127.0.0.1:3100/?room=${room.id}`);
    await expect(page.getByRole('region', { name: 'Task detail' })).toContainText(tasks[0].definitionOfDone);
    await expect(page.locator('.inspector-title')).toHaveText(tasks[0].title);
    await expect(page.locator(`#projects-rail [data-room="${room.id}"]`)).toHaveAttribute('aria-current', 'page');
    await page.goBack();
    await expect(rows).toHaveCount(2);
    await expect(page).toHaveURL('http://127.0.0.1:3100/');
    await expect(page.locator('#projects-rail [aria-current]')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Task detail' })).toHaveCount(0);
    await page.reload();
    await expect(rows).toHaveCount(2);
    await expect(page).toHaveURL('http://127.0.0.1:3100/');
    for (const task of tasks) {
      expect((await request.patch(`${apiUrl}/tasks/${task.id}/status`, { data: { status: 'queued' } })).ok()).toBeTruthy();
    }
    await expect(inbox.getByText('Nothing needs you', { exact: true })).toBeVisible();
    expect((await request.patch(`${apiUrl}/tasks/${tasks[0].id}/status`, { data: { status: 'done' } })).ok()).toBeTruthy();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Result waiting for review');
    expect((await request.post(`${apiUrl}/tasks/${tasks[0].id}/review`, { data: { verdict: 'accepted' } })).ok()).toBeTruthy();
    await expect(inbox.getByText('Nothing needs you', { exact: true })).toBeVisible();
  } finally {
    await context?.close();
    if (api.exitCode === null) {
      const exited = once(api, 'exit');
      api.kill('SIGKILL');
      await exited;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
