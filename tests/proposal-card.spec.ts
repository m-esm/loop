import { test, expect, type BrowserContext } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import type { Message, Task } from '@loop/types';

test('proposal card approves another option and discuss both re-run with LOOP_TASK_CHOICE', async ({ browser, request }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-propose-'));
  const payload = {
    question: 'Which store?',
    options: ['SQLite', 'Postgres'],
    pick: 'SQLite',
    why: 'one file, no service',
  };
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    agents: [
      {
        id: 'echo',
        name: 'Echo',
        command: [process.execPath, '-e',
          `const c=process.env.LOOP_TASK_CHOICE;if(c){process.stdout.write('chose '+c+'\\n')}else{process.stdout.write(${JSON.stringify(`LOOP_PROPOSE: ${JSON.stringify(payload)}\n`)})}`],
      },
    ],
  }));
  let api: ChildProcess | undefined;
  let output = '';
  const contexts: BrowserContext[] = [];
  const apiUrl = 'http://127.0.0.1:3101/api';
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
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    contexts.push(context);
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:3100');
    await expect(page.locator('[data-live]')).toHaveAttribute('data-live', '1');

    await page.getByLabel('Author', { exact: true }).fill('Moshe');
    await page.getByLabel('Message', { exact: true }).fill('/task Pick a store :: proof');
    const postedStore = page.waitForResponse((response) => response.url().endsWith('/messages') && response.request().method() === 'POST');
    await page.getByLabel('Message', { exact: true }).press('Enter');
    const storeMessage = await (await postedStore).json() as Message;
    if (storeMessage.body.kind !== 'task') throw new Error('Expected task card');
    const storeId = storeMessage.body.taskId;

    await page.getByLabel('Message', { exact: true }).fill('/task Talk it through :: proof');
    const postedTalk = page.waitForResponse((response) => response.url().endsWith('/messages') && response.request().method() === 'POST');
    await page.getByLabel('Message', { exact: true }).press('Enter');
    const talkMessage = await (await postedTalk).json() as Message;
    if (talkMessage.body.kind !== 'task') throw new Error('Expected task card');
    const talkId = talkMessage.body.taskId;

    const storeCard = page.locator('.chat-task').filter({ hasText: 'Pick a store' });
    const talkCard = page.locator('.chat-task').filter({ hasText: 'Talk it through' });
    await expect(storeCard.locator('.tp-chip')).toHaveText('needs_input', { timeout: 10_000 });
    await expect(talkCard.locator('.tp-chip')).toHaveText('needs_input', { timeout: 10_000 });
    await expect(storeCard.locator('[data-task-proposal]')).toContainText('Which store?');
    await expect(storeCard.locator('[data-proposal-option="SQLite"] input')).toBeChecked();
    await expect(storeCard.locator('[data-proposal-option="SQLite"]')).toContainText("agent's pick");
    await expect(storeCard.locator('[data-proposal-option="Postgres"] input')).not.toBeChecked();
    await expect(storeCard.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
    await expect(storeCard.getByRole('button', { name: 'Discuss', exact: true })).toBeVisible();
    // Two cards park at once and one card is taller than half the transcript, so
    // both cannot be on screen together. The pin shows the newest arrival, so
    // reach the older one the way a human does, by scrolling to it.
    await storeCard.scrollIntoViewIfNeeded();
    await expect(storeCard.getByRole('button', { name: 'Approve', exact: true })).toBeInViewport({ ratio: 1 });
    // A control that renders is not a control that renders correctly. An unsized
    // radio stretches to the row width and pushes its own label off the edge,
    // which every presence and viewport assertion happily passes.
    const radioWidth = await storeCard.locator('[data-proposal-option="SQLite"] input')
      .evaluate((el) => Math.round(el.getBoundingClientRect().width));
    expect(radioWidth).toBeLessThan(40);
    await expect(storeCard.locator('[data-proposal-option="Postgres"]')).toBeInViewport({ ratio: 1 });
    await expect(page.locator('[data-needs-human]')).toHaveAttribute('data-needs-human', '2');

    await page.screenshot({ path: resolve('docs/screenshots/proposal-card.png') });

    await storeCard.locator('[data-proposal-option="Postgres"] input').check();
    const approved = page.waitForResponse((response) => response.url().includes('/decide') && response.request().method() === 'POST');
    await storeCard.getByRole('button', { name: 'Approve', exact: true }).click();
    expect((await approved).status()).toBe(200);
    await expect(storeCard.locator('.tp-chip')).toHaveText('done', { timeout: 10_000 });
    await expect(storeCard.locator('[data-task-result]')).toHaveText('chose Postgres');
    await expect(talkCard.locator('.tp-chip')).toHaveText('needs_input');
    await expect(talkCard.getByRole('button', { name: 'Discuss', exact: true })).toBeVisible();

    const discussed = page.waitForResponse((response) => response.url().includes('/decide') && response.request().method() === 'POST');
    await talkCard.getByRole('button', { name: 'Discuss', exact: true }).click();
    const discussedResponse = await discussed;
    expect(discussedResponse.status()).toBe(200);
    const requeued = await discussedResponse.json() as Task;
    expect(requeued.status).toBe('queued');
    expect(requeued.proposalChoice).toBe('discuss');
    await expect(talkCard.locator('.tp-chip')).toHaveText('done', { timeout: 10_000 });
    await expect(talkCard.locator('[data-task-result]')).toHaveText('chose discuss');

    const storeTask = await (await request.get(`${apiUrl}/tasks/${storeId}`)).json() as Task;
    const talkTask = await (await request.get(`${apiUrl}/tasks/${talkId}`)).json() as Task;
    expect(storeTask.status).toBe('done');
    expect(storeTask.result).toBe('chose Postgres');
    expect(storeTask.proposalChoice).toBeNull();
    // The decided proposal must not survive the run it belongs to, in the row or
    // on the card. A finished task showing its old options reads as pending.
    expect(storeTask.proposal).toBeNull();
    await expect(storeCard.locator('[data-task-proposal]')).toHaveCount(0);
    expect(talkTask.status).toBe('done');
    expect(talkTask.result).toBe('chose discuss');
    expect(talkTask.proposalChoice).toBeNull();
  } finally {
    await Promise.all(contexts.map((item) => item.close()));
    await stopApi();
    rmSync(dir, { recursive: true, force: true });
  }
});
