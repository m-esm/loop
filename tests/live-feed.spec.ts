import { test, expect, type BrowserContext } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import { TASK_STATUSES, isRunningStatus, isActiveStatus, type Message, type Task, type TaskSnapshot } from '@loop/types';

test('two tabs receive creates and status changes, then reconnect and replay after API restart', async ({ browser, request }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-e2e-'));
  let api: ChildProcess | undefined;
  let output = '';
  const contexts: BrowserContext[] = [];
  const apiUrl = 'http://127.0.0.1:3101/api';
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
    let streamCount = 0;
    let messagePosts = 0;
    tabA.on('request', (req) => {
      if (req.url().includes('/stream')) streamCount++;
      if (req.url().endsWith('/messages') && req.method() === 'POST') messagePosts++;
    });
    await tabA.getByLabel('Message', { exact: true }).fill('/unknown hi');
    await tabA.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(tabA.locator('.composer').getByRole('alert')).toContainText('Unknown command');
    expect(messagePosts).toBe(0);
    await tabA.getByLabel('Author', { exact: true }).fill('Moshe');
    await tabA.getByLabel('Message', { exact: true }).fill('Hello room');
    await tabA.getByLabel('Message', { exact: true }).press('Shift+Enter');
    await tabA.getByLabel('Message', { exact: true }).press('Enter');
    await expect(tabB.getByRole('log')).toContainText('Hello room');
    await tabA.getByLabel('Message', { exact: true }).fill('/task Build the chat :: Live cards update');
    const posted = tabA.waitForResponse((response) => response.url().endsWith('/messages') && response.request().method() === 'POST');
    await tabA.getByLabel('Message', { exact: true }).press('Enter');
    const cardMessage = await (await posted).json() as Message;
    if (cardMessage.body.kind !== 'task') throw new Error('Expected task card');
    const chatCard = tabB.locator('.chat-task');
    await expect(chatCard).toContainText('Build the chat');
    const chatStatus = TASK_STATUSES.find(isRunningStatus)!;
    await request.patch(`${apiUrl}/tasks/${cardMessage.body.taskId}/status`, { data: { status: chatStatus } });
    await expect(chatCard.locator('.tp-chip')).toHaveText(chatStatus);
    await tabB.screenshot({ path: '/tmp/loop-chat.png' });
    for (let i = 0; i < 14; i++) {
      await request.post(`${apiUrl}/messages`, { data: { roomId: 'default', author: 'Human', body: `History ${i}` } });
    }
    const transcript = tabB.getByRole('log');
    await expect(transcript).toContainText('History 13');
    await expect.poll(() => transcript.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(80);
    await transcript.evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
    await request.post(`${apiUrl}/messages`, { data: { roomId: 'default', author: 'Human', body: 'Keep reading history' } });
    await expect(transcript).toContainText('Keep reading history');
    expect(await transcript.evaluate((el) => el.scrollTop)).toBe(0);
    expect(streamCount).toBe(0);
    await tabA.getByRole('button', { name: 'Tasks', exact: true }).click();
    await tabB.getByRole('button', { name: 'Tasks', exact: true }).click();
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
    expect(await tabB.locator('tbody tr').count()).toBe(3);
    expect(taskReads).toBe(0);
    console.log(`Killed and restarted API with the same SQLite file. Reconnected using since=${cursor}; missed create and status replayed, exactly 3 rows, 0 task-list fetches.`);
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
    await expect(tabB.locator('tbody tr')).toHaveCount(4);
    await expect(tabB.getByRole('row').filter({ hasText: thirdTask.title }).getByText(running, { exact: true })).toBeVisible();
    await row.getByRole('button').click();
    await expect(tabB.getByRole('region', { name: 'Task detail' })).toBeVisible();
    await tabB.screenshot({ path: '/tmp/loop-tasks-list.png' });
    expect(errors).toEqual([]);
    console.log('Saved /tmp/loop-chat.png and /tmp/loop-tasks-list.png at 1440x900; no browser runtime errors.');
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await stopApi();
    rmSync(dir, { recursive: true, force: true });
  }
});
