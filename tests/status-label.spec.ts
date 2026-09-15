import { test, expect, type BrowserContext } from '@playwright/test';
import { TASK_STATUSES, statusLabel, type Task } from '@loop/types';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { authedContext, seedSession, withAuth } from './auth';

// Wire values are a protocol detail. `needs_input` on screen is a defect, and
// the board is where every status renders at once, so it is the honest probe.
test('no task status reaches the screen as its raw wire value', async ({ browser, request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-status-label-'));
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
    // One task per status, so every column and chip renders.
    for (const status of TASK_STATUSES) {
      const created = await request.post(`${apiUrl}/tasks`, {
        data: { title: `Sample ${TASK_STATUSES.indexOf(status) + 1}`, definitionOfDone: 'Rendered.', roomId: 'default' },
      });
      expect(created.status()).toBe(201);
      const task = await created.json() as Task;
      expect((await request.patch(`${apiUrl}/tasks/${task.id}/status`, { data: { status } })).ok()).toBeTruthy();
    }
    context = await authedContext(browser, session.token);
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:3100/?room=default');
    await page.getByRole('button', { name: 'Tasks', exact: true }).click();
    const board = page.getByRole('region', { name: 'Task board' });
    await expect(board.locator('[data-task-status]')).toHaveCount(TASK_STATUSES.length);

    // Every column heading and chip reads as English.
    for (const status of TASK_STATUSES) {
      const column = board.locator(`[data-task-status="${status}"]`);
      await expect(column.locator('h4')).toContainText(statusLabel(status));
    }
    // And the underscored wire values appear nowhere in the rendered text.
    const shown = await page.locator('main').innerText();
    for (const status of TASK_STATUSES.filter((value) => value.includes('_'))) {
      expect(shown).not.toContain(status);
    }
    // The board fits its pane rather than scrolling sideways.
    const fits = await board.evaluate((node) => node.scrollWidth <= node.clientWidth + 1);
    expect(fits).toBe(true);
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
