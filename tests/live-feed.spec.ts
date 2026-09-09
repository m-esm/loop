import { test, expect, type BrowserContext } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import { TASK_STATUSES, isRunningStatus, isActiveStatus, type Task, type TaskSnapshot } from '@loop/types';

test('two tabs receive creates and status changes, then reconnect and replay after API restart', async ({ browser, request }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-e2e-'));
  let api: ChildProcess | undefined;
  let output = '';
  const contexts: BrowserContext[] = [];
  const apiUrl = 'http://127.0.0.1:3101/api';
  async function startApi() {
    api = spawn(process.execPath, ['dist/src/main.js'], {
      cwd: resolve('apps/api'),
      env: { ...process.env, PORT: '3101', WEB_ORIGIN: 'http://127.0.0.1:3100', DATABASE_PATH: join(dir, 'loop.sqlite') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    api.stdout?.on('data', (chunk) => { output += chunk; });
    api.stderr?.on('data', (chunk) => { output += chunk; });
    await expect.poll(async () => {
      if (api?.exitCode != null) throw new Error(output);
      return request.get(`${apiUrl}/tasks`).then((response) => response.status()).catch(() => 0);
    }).toBe(200);
  }
  async function stopApi() {
    if (!api || api.exitCode !== null) return;
    const exited = once(api, 'exit');
    api.kill('SIGKILL');
    await exited;
  }
  try {
    await startApi();
    const a = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const b = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    contexts.push(a, b);
    const tabA = await a.newPage();
    const tabB = await b.newPage();
    const errors: string[] = [];
    tabA.on('pageerror', (error) => errors.push(error.message));
    tabB.on('pageerror', (error) => errors.push(error.message));
    await Promise.all([tabA.goto('http://127.0.0.1:3100'), tabB.goto('http://127.0.0.1:3100')]);
    await expect(tabA.locator('[data-live]')).toHaveAttribute('data-live', '1');
    await expect(tabB.locator('[data-live]')).toHaveAttribute('data-live', '1');
    let taskReads = 0;
    const streamUrls: string[] = [];
    tabB.on('request', (req) => {
      if (req.method() === 'GET' && req.url() === `${apiUrl}/tasks`) taskReads++;
      if (req.url().includes('/stream')) streamUrls.push(req.url());
    });
    await tabA.getByLabel('Title', { exact: true }).fill('Stream a new task across tabs');
    await tabA.getByLabel('Owner', { exact: true }).fill('Moshe');
    await tabA.getByLabel('Definition of done').fill('The second tab shows this task without a reload.');
    const started = Date.now();
    await tabA.getByRole('button', { name: 'Create task', exact: true }).click();
    const row = tabB.getByRole('row').filter({ hasText: 'Stream a new task across tabs' });
    await expect(row).toHaveCount(1, { timeout: 1000 });
    console.log(`Tab A submitted the form; Tab B displayed one row in ${Date.now() - started}ms without navigation or a task-list fetch.`);
    const snapshot = await (await request.get(`${apiUrl}/tasks`)).json() as TaskSnapshot;
    const task = snapshot.tasks[0];
    const running = TASK_STATUSES.find(isRunningStatus)!;
    const terminal = TASK_STATUSES.find((status) => !isActiveStatus(status))!;
    const patch = await request.patch(`${apiUrl}/tasks/${task.id}/status`, { data: { status: running } });
    expect(patch.status()).toBe(200);
    await expect(row.getByText(running, { exact: true })).toBeVisible({ timeout: 1000 });
    console.log(`API PATCH changed the task to ${running}; Tab B updated the existing row within 1 second.`);
    const cursor = (await (await request.get(`${apiUrl}/tasks`)).json() as TaskSnapshot).since;
    const hiddenReconnects: string[] = [];
    tabA.on('request', (req) => { if (req.url().includes('/stream')) hiddenReconnects.push(req.url()); });
    // Deterministically simulate background visibility in headless Chromium.
    await tabA.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await stopApi();
    await expect(tabB.locator('[data-live]')).toHaveAttribute('data-live', '0');
    await Promise.all([a.setOffline(true), b.setOffline(true)]);
    await startApi();
    const missed = await request.post(`${apiUrl}/tasks`, { data: {
      title: 'Replay the task created while disconnected', owner: 'Builder', definitionOfDone: 'Exactly one row appears after reconnection.',
    } });
    expect(missed.status()).toBe(201);
    const missedTask = await missed.json() as Task;
    expect((await request.patch(`${apiUrl}/tasks/${task.id}/status`, { data: { status: terminal } })).status()).toBe(200);
    await Promise.all([a.setOffline(false), b.setOffline(false)]);
    await expect(tabB.getByRole('row').filter({ hasText: missedTask.title })).toHaveCount(1, { timeout: 35_000 });
    await expect(row.getByText(terminal, { exact: true })).toBeVisible();
    await expect(tabB.locator('[data-live]')).toHaveAttribute('data-live', '1');
    expect(streamUrls.some((url) => url.endsWith(`since=${cursor}`))).toBe(true);
    expect(await tabB.locator('tbody tr').count()).toBe(2);
    expect(taskReads).toBe(0);
    console.log(`Killed and restarted API with the same SQLite file. Reconnected using since=${cursor}; missed create and status replayed, exactly 2 rows, 0 task-list fetches.`);
    expect(hiddenReconnects).toEqual([]);
    await tabA.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(tabA.getByRole('row').filter({ hasText: missedTask.title })).toHaveCount(1);
    expect(hiddenReconnects).toHaveLength(1);
    console.log('Tab A made no reconnect attempts while simulated hidden; visibilitychange triggered one reconnect and replay.');
    const third = await request.post(`${apiUrl}/tasks`, { data: {
      title: 'Verify the live task list', owner: 'Reviewer', definitionOfDone: 'Lint, tests, build and browser verification pass.',
    } });
    expect(third.status()).toBe(201);
    const thirdTask = await third.json() as Task;
    expect((await request.patch(`${apiUrl}/tasks/${thirdTask.id}/status`, { data: { status: running } })).status()).toBe(200);
    await expect(tabB.locator('tbody tr')).toHaveCount(3);
    await expect(tabB.getByRole('row').filter({ hasText: thirdTask.title }).getByText(running, { exact: true })).toBeVisible();
    await row.getByRole('button').click();
    await expect(tabB.getByRole('region', { name: 'Task detail' })).toBeVisible();
    mkdirSync('docs/screenshots', { recursive: true });
    await tabB.screenshot({ path: 'docs/screenshots/tasks-list.png' });
    expect(errors).toEqual([]);
    console.log('Saved docs/screenshots/tasks-list.png at 1440x900 with 3 tasks in different states; no browser runtime errors.');
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await stopApi();
    rmSync(dir, { recursive: true, force: true });
  }
});
