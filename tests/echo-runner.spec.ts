import { test, expect, type BrowserContext } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import type { Message, Task, TaskEvent } from '@loop/types';

test('echo runner finishes /task without PATCH and fails FAIL: titles', async ({ browser, request }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-echo-'));
  let api: ChildProcess | undefined;
  let output = '';
  const contexts: BrowserContext[] = [];
  const apiUrl = 'http://127.0.0.1:3101/api';
  async function startApi() {
    api = spawn(process.execPath, ['dist/src/main.js'], {
      cwd: resolve('apps/api'),
      env: { ...process.env, PORT: '3101', WEB_ORIGIN: 'http://127.0.0.1:3100', DATABASE_PATH: join(dir, 'loop.sqlite'), LOOP_RUNNER: '1' },
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
    await Promise.all([tabA.goto('http://127.0.0.1:3100'), tabB.goto('http://127.0.0.1:3100')]);
    await expect(tabA.locator('[data-live]')).toHaveAttribute('data-live', '1');
    await expect(tabB.locator('[data-live]')).toHaveAttribute('data-live', '1');

    const stream = await fetch(`${apiUrl}/stream?since=0`);
    const reader = stream.body!.getReader();
    let buffer = '';
    const events: TaskEvent[] = [];
    const pump = async () => {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += new TextDecoder().decode(chunk.value);
        let end: number;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = frame.split('\n').find((line) => line.startsWith('data: '));
          if (data) events.push(JSON.parse(data.slice(6)) as TaskEvent);
        }
      }
    };
    const pumping = pump();

    await tabA.getByLabel('Author', { exact: true }).fill('Moshe');
    await tabA.getByLabel('Message', { exact: true }).fill('/task Echo me :: proof');
    const posted = tabA.waitForResponse((response) => response.url().endsWith('/messages') && response.request().method() === 'POST');
    await tabA.getByLabel('Message', { exact: true }).press('Enter');
    const cardMessage = await (await posted).json() as Message;
    if (cardMessage.body.kind !== 'task') throw new Error('Expected task card');
    const echoId = cardMessage.body.taskId;
    const echoCardA = tabA.locator('.chat-task').filter({ hasText: 'Echo me' });
    const echoCardB = tabB.locator('.chat-task').filter({ hasText: 'Echo me' });
    await expect(echoCardA).toBeVisible();
    await expect(echoCardB).toBeVisible();
    await expect(echoCardA.locator('.tp-chip')).toHaveText('done', { timeout: 10_000 });
    await expect(echoCardB.locator('.tp-chip')).toHaveText('done');
    await expect(echoCardA.locator('[data-task-result]')).toHaveText('Echo: Echo me');
    await expect(echoCardB.locator('[data-task-result]')).toHaveText('Echo: Echo me');
    await echoCardB.locator('summary').click();
    await expect(echoCardB.locator('[data-task-log]')).toContainText('Echo started');
    await expect(echoCardB.locator('[data-task-log]')).toContainText('Echo finished');
    await expect(tabB.getByRole('log').locator('.message-card')).toHaveCount(1);
    const echo = await (await request.get(`${apiUrl}/tasks/${echoId}`)).json() as Task;
    await expect.poll(() => foldedStatuses(events, echoId)).toEqual(['queued', 'running', 'done']);
    expect(echo.status).toBe('done');
    expect(echo.result).toBe('Echo: Echo me');
    expect(echo.log.length).toBeGreaterThan(0);

    await tabA.getByLabel('Message', { exact: true }).fill('/task FAIL: boom :: x');
    const failedPost = tabA.waitForResponse((response) => response.url().endsWith('/messages') && response.request().method() === 'POST');
    await tabA.getByLabel('Message', { exact: true }).press('Enter');
    const failMessage = await (await failedPost).json() as Message;
    if (failMessage.body.kind !== 'task') throw new Error('Expected task card');
    const failId = failMessage.body.taskId;
    const failCard = tabB.locator('.chat-task').filter({ hasText: 'FAIL: boom' });
    await expect(failCard.locator('.tp-chip')).toHaveText('failed', { timeout: 10_000 });
    await expect(failCard.locator('[data-task-error]')).toHaveText('boom');
    await expect(tabA.locator('.chat-task').filter({ hasText: 'FAIL: boom' }).locator('.tp-chip')).toHaveText('failed');
    await expect(tabB.getByRole('log').locator('.message-card')).toHaveCount(2);
    const failed = await (await request.get(`${apiUrl}/tasks/${failId}`)).json() as Task;
    await expect.poll(() => foldedStatuses(events, failId)).toEqual(['queued', 'running', 'failed']);
    expect(failed.error).toBe('boom');

    await tabB.screenshot({ path: resolve('docs/screenshots/room-chat.png') });
    await reader.cancel().catch(() => {});
    await pumping.catch(() => {});
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await stopApi();
    rmSync(dir, { recursive: true, force: true });
  }
});

function foldedStatuses(events: TaskEvent[], taskId: string) {
  const statuses: string[] = [];
  for (const event of events) {
    if (event.kind === 'message_created') continue;
    if (event.payload.task.id !== taskId) continue;
    const status = event.payload.task.status;
    if (statuses.at(-1) !== status) statuses.push(status);
  }
  return statuses;
}
