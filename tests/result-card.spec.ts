import { test, expect, type BrowserContext } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import type { Message, Task } from '@loop/types';
import { authedContext, seedSession, withAuth } from './auth';

test('a finished task can be accepted or rejected and sent back with a note', async ({ browser, request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-verdict-'));
  const session = seedSession(join(dir, 'loop.sqlite'));
  const request = withAuth(raw, session.token);
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    agents: [
      {
        id: 'echo',
        name: 'Echo',
        command: [process.execPath, '-e',
          "const n=process.env.LOOP_TASK_NOTE;process.stdout.write((n?'resent: '+n:'first-pass')+'\\n')"],
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

    await page.getByLabel('Message', { exact: true }).fill('/task Keep this :: proof');
    const postedKeep = page.waitForResponse((response) => response.url().endsWith('/messages') && response.request().method() === 'POST');
    await page.getByLabel('Message', { exact: true }).press('Enter');
    const keepMessage = await (await postedKeep).json() as Message;
    if (keepMessage.body.kind !== 'task') throw new Error('Expected task card');
    const keepId = keepMessage.body.taskId;

    await page.getByLabel('Message', { exact: true }).fill('/task Send this back :: proof');
    const postedSend = page.waitForResponse((response) => response.url().endsWith('/messages') && response.request().method() === 'POST');
    await page.getByLabel('Message', { exact: true }).press('Enter');
    const sendMessage = await (await postedSend).json() as Message;
    if (sendMessage.body.kind !== 'task') throw new Error('Expected task card');
    const sendId = sendMessage.body.taskId;

    const keepCard = page.locator('.chat-task').filter({ hasText: 'Keep this' });
    const sendCard = page.locator('.chat-task').filter({ hasText: 'Send this back' });
    await expect(keepCard.locator('.tp-chip')).toHaveText('done', { timeout: 10_000 });
    await expect(sendCard.locator('.tp-chip')).toHaveText('done', { timeout: 10_000 });
    await expect(keepCard.locator('[data-task-result]')).toHaveText('first-pass');
    await expect(sendCard.locator('[data-task-result]')).toHaveText('first-pass');
    await expect(keepCard.getByRole('button', { name: 'Accept', exact: true })).toBeVisible();
    await expect(keepCard.getByRole('button', { name: 'Reject', exact: true })).toBeVisible();
    await expect(sendCard.getByRole('button', { name: 'Accept', exact: true })).toBeVisible();

    const accepted = page.waitForResponse((response) => response.url().includes('/review') && response.request().method() === 'POST');
    await keepCard.getByRole('button', { name: 'Accept', exact: true }).click();
    expect((await accepted).status()).toBe(200);
    await expect(keepCard.locator('[data-task-verdict]')).toHaveText('Accepted by Moshe');
    await expect(keepCard.getByRole('button', { name: 'Accept', exact: true })).toHaveCount(0);
    await expect(keepCard.getByRole('button', { name: 'Reject', exact: true })).toHaveCount(0);
    await expect(keepCard.locator('.tp-chip')).toHaveText('done');
    await expect(sendCard.getByRole('button', { name: 'Reject', exact: true })).toBeVisible();
    // Visible is not reachable. A button half under the composer cannot be clicked.
    await expect(sendCard.getByRole('button', { name: 'Accept', exact: true })).toBeInViewport({ ratio: 1 });
    await expect(sendCard.getByRole('button', { name: 'Reject', exact: true })).toBeInViewport({ ratio: 1 });
    await expect(sendCard.getByLabel('Note')).toBeInViewport({ ratio: 1 });

    await page.screenshot({ path: resolve('docs/screenshots/result-card.png') });

    await sendCard.getByLabel('Note').fill('too thin');
    const rejected = page.waitForResponse((response) => response.url().includes('/review') && response.request().method() === 'POST');
    await sendCard.getByRole('button', { name: 'Reject', exact: true }).click();
    const rejectedResponse = await rejected;
    expect(rejectedResponse.status()).toBe(200);
    const requeued = await rejectedResponse.json() as Task;
    expect(requeued.status).toBe('queued');
    expect(requeued.runId).toBeNull();
    expect(requeued.result).toBeNull();
    expect(requeued.verdict).toBe('rejected');
    // The rejected verdict is observable on the API response above. In the browser
    // the re-run may already be finishing, so asserting the intermediate state here
    // would race it; the post-rerun assertions below are the real proof.
    await expect(sendCard.locator('.tp-chip')).toHaveText('done', { timeout: 10_000 });
    await expect(sendCard.locator('[data-task-result]')).toHaveText('resent: too thin');
    // The re-run is a NEW unreviewed result: the old verdict must be gone and the
    // buttons must come back, or a sent-back task can never be accepted.
    await expect(sendCard.locator('[data-task-verdict]')).toHaveCount(0);
    await expect(sendCard.getByRole('button', { name: 'Accept', exact: true })).toBeVisible();
    await sendCard.getByRole('button', { name: 'Accept', exact: true }).click();
    await expect(sendCard.locator('[data-task-verdict]')).toHaveText('Accepted by Moshe');

    const keepTask = await (await request.get(`${apiUrl}/tasks/${keepId}`)).json() as Task;
    const sendTask = await (await request.get(`${apiUrl}/tasks/${sendId}`)).json() as Task;
    expect(keepTask.status).toBe('done');
    expect(keepTask.verdict).toBe('accepted');
    expect(keepTask.verdictBy).toBe('Moshe');
    expect(keepTask.result).toBe('first-pass');
    expect(sendTask.status).toBe('done');
    expect(sendTask.verdict).toBe('accepted');
    expect(sendTask.verdictNote).toBeNull();
    expect(sendTask.result).toBe('resent: too thin');
  } finally {
    await Promise.all(contexts.map((item) => item.close()));
    await stopApi();
    rmSync(dir, { recursive: true, force: true });
  }
});
