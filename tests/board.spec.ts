import { test, expect, type BrowserContext } from '@playwright/test';
import { TASK_STATUSES, chipClass, statusLabel } from '@loop/types';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { authedContext, seedSession, withAuth } from './auth';

test('Board uses every shared status, updates live, opens the inspector, and toggles to List', async ({ browser, request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-board-browser-'));
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
    context = await authedContext(browser, session.token);
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:3100/?room=default');
    await expect(page.locator('[data-live]')).toHaveAttribute('data-live', '1');
    await page.getByRole('button', { name: 'Tasks', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Tasks', exact: true });
    const board = panel.getByRole('region', { name: 'Task board', exact: true });
    await expect(panel.getByRole('form', { name: 'Create task' })).toHaveCount(0);
    await panel.getByRole('button', { name: 'Create task', exact: true }).click();
    await expect(panel.getByRole('form', { name: 'Create task' })).toBeVisible();
    await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Board', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(board.locator('[data-task-status]')).toHaveCount(TASK_STATUSES.length);
    expect(await board.locator('[data-task-status]').evaluateAll((columns) => columns.map((column) => column.getAttribute('data-task-status')))).toEqual(TASK_STATUSES);
    await expect(board.getByText('No tasks', { exact: true })).toHaveCount(TASK_STATUSES.length);

    const tasks = [];
    for (const title of ['Polish task ownership', 'Ship the room foundation']) {
      const response = await request.post(`${apiUrl}/tasks`, {
        data: { title, definitionOfDone: 'The room shows the verified result.', roomId: 'default' },
      });
      expect(response.status()).toBe(201);
      tasks.push(await response.json());
    }
    const queuedColumn = board.locator('[data-task-status="queued"]');
    const doneColumn = board.locator('[data-task-status="done"]');
    await expect(queuedColumn.locator('[data-task-id]')).toHaveCount(2);
    expect((await request.patch(`${apiUrl}/tasks/${tasks[1].id}/status`, { data: { status: 'done' } })).ok()).toBeTruthy();
    await expect(queuedColumn.locator('[data-task-id]')).toHaveCount(1);
    await expect(doneColumn.locator('[data-task-id]')).toHaveCount(1);
    for (const [task, status] of [[tasks[0], 'queued'], [tasks[1], 'done']] as const) {
      const card = board.locator(`[data-task-id="${task.id}"]`);
      await expect(card).toHaveText(`${task.title}Owner: ${task.owner}${statusLabel(status)}`);
      await expect(card.locator('.tp-chip')).toHaveClass(chipClass(status));
      await card.click();
      await expect(page.locator('.inspector-title')).toHaveText(task.title);
      await expect(page.getByRole('region', { name: 'Task detail' })).toContainText(task.definitionOfDone);
    }
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByRole('complementary', { name: 'Context panel' })).toHaveCount(0);
    await board.evaluate((element) => { element.scrollLeft = 0; });
    await page.screenshot({ path: resolve('docs/screenshots/board.png') });
    await panel.getByRole('button', { name: 'List', exact: true }).click();
    await expect(board).toHaveCount(0);
    await expect(panel.getByRole('table')).toBeVisible();
    await expect(panel.locator('tbody tr')).toHaveCount(2);
    await panel.getByRole('button', { name: tasks[0].title, exact: true }).click();
    await expect(page.locator('.inspector-title')).toHaveText(tasks[0].title);
    await panel.getByRole('button', { name: 'Board', exact: true }).click();
    await expect(board).toBeVisible();
    await expect(doneColumn.locator('[data-task-id]')).toHaveCount(1);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.setViewportSize({ width: 600, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    await board.locator('[data-task-status]').last().scrollIntoViewIfNeeded();
    await expect(board.locator('[data-task-status]').last()).toBeInViewport();
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
