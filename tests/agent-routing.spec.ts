import { test, expect, type BrowserContext } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import type { Message, Task } from '@loop/types';
import { authedContext, seedSession, withAuth } from './auth';

test('two /task posts route to two different agent commands', async ({ browser, request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-route-'));
  const session = seedSession(join(dir, 'loop.sqlite'));
  const request = withAuth(raw, session.token);
  const echoToken = `echo-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const reviewToken = `review-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    agents: [
      {
        id: 'echo',
        name: 'Echo',
        command: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(`${echoToken}\n`)})`],
      },
      {
        id: 'reviewer',
        name: 'Reviewer',
        command: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(`${reviewToken}\n`)})`],
      },
    ],
  }));
  let api: ChildProcess | undefined;
  let output = '';
  const contexts: BrowserContext[] = [];
  const apiUrl = 'http://127.0.0.1:3101/api';
  // This spec starts its API once against a fresh database.
  const expectedTasks = () => 0;
  async function startApi() {
    api = spawn(process.execPath, ['dist/src/main.js'], {
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
    await expect.poll(async () => {
      if (api?.exitCode != null) throw new Error(output);
      // A 200 only proves something answers on 3101. Every spec uses that port, so
      // a leftover server from an earlier spec passes this poll and then serves
      // this spec's requests against the wrong database and config. Require a task
      // list this spec's own fresh database is the only one that can return.
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
  try {
    await startApi();
    const context = await authedContext(browser, session.token);
    contexts.push(context);
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:3100');
    await expect(page.locator('[data-live]')).toHaveAttribute('data-live', '1');

    await page.getByLabel('Message', { exact: true }).fill('/task Unassigned probe :: proof');
    const postedEcho = page.waitForResponse((response) => response.url().endsWith('/messages') && response.request().method() === 'POST');
    await page.getByLabel('Message', { exact: true }).press('Enter');
    const echoMessage = await (await postedEcho).json() as Message;
    if (echoMessage.body.kind !== 'task') throw new Error('Expected task card');
    const echoId = echoMessage.body.taskId;

    await page.getByLabel('Message', { exact: true }).fill('/task @reviewer Named probe :: proof');
    const postedReview = page.waitForResponse((response) => response.url().endsWith('/messages') && response.request().method() === 'POST');
    await page.getByLabel('Message', { exact: true }).press('Enter');
    const reviewMessage = await (await postedReview).json() as Message;
    if (reviewMessage.body.kind !== 'task') throw new Error('Expected task card');
    const reviewId = reviewMessage.body.taskId;

    const echoCard = page.locator('.chat-task').filter({ hasText: 'Unassigned probe' });
    const reviewCard = page.locator('.chat-task').filter({ hasText: 'Named probe' });
    await expect(echoCard.locator('.tp-chip')).toHaveText('done', { timeout: 10_000 });
    await expect(reviewCard.locator('.tp-chip')).toHaveText('done', { timeout: 10_000 });
    await expect(echoCard.locator('[data-task-result]')).toHaveText(echoToken);
    await expect(reviewCard.locator('[data-task-result]')).toHaveText(reviewToken);
    await expect(echoCard.locator('[data-task-agent]')).toHaveCount(0);
    await expect(reviewCard.locator('[data-task-agent]')).toHaveText('Agent: reviewer');
    // Its own file: room-chat.png is written by two other specs, so a shared
    // path means whichever spec runs last decides what the repo shows.
    await page.screenshot({ path: resolve('docs/screenshots/agent-routing.png') });

    const echoTask = await (await request.get(`${apiUrl}/tasks/${echoId}`)).json() as Task;
    const reviewTask = await (await request.get(`${apiUrl}/tasks/${reviewId}`)).json() as Task;
    expect(echoTask.result).toBe(echoToken);
    expect(echoTask.claimedBy).toBe('echo');
    expect(echoTask.agentId).toBeNull();
    expect(reviewTask.result).toBe(reviewToken);
    expect(reviewTask.claimedBy).toBe('reviewer');
    expect(reviewTask.agentId).toBe('reviewer');
    expect(echoTask.result).not.toBe(reviewTask.result);
  } finally {
    await Promise.all(contexts.map((item) => item.close()));
    await stopApi();
    rmSync(dir, { recursive: true, force: true });
  }
});
