import { test, expect, type BrowserContext } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import type { Message, Task } from '@loop/types';
import { authedContext, seedSession, withAuth } from './auth';

test('a spawned child shows lineage, stays linked after send-back', async ({ browser, request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-parent-'));
  const session = seedSession(join(dir, 'loop.sqlite'));
  const request = withAuth(raw, session.token);
  const spawnPayload = JSON.stringify({
    title: 'Review the split', definitionOfDone: 'child proof', agentId: 'echo',
  });
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    agents: [
      {
        id: 'planner',
        name: 'Planner',
        command: [process.execPath, '-e',
          // The parent keeps working AFTER spawning, on a later tick. Writing both
          // lines in one synchronous burst would survive even a SIGKILL on spawn,
          // so the test could not tell a live agent from a killed one.
          `process.stdout.write(${JSON.stringify(`LOOP_SPAWN: ${spawnPayload}\n`)});`
          + `setTimeout(function(){process.stdout.write('parent-done' + String.fromCharCode(10));}, 400)`],
      },
      {
        id: 'echo',
        name: 'Echo',
        command: [process.execPath, '-e',
          "const n=process.env.LOOP_TASK_NOTE;process.stdout.write((n?'child-resent '+n:'child-done')+'\\n')"],
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
    const context = await authedContext(browser, session.token);
    contexts.push(context);
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:3100');
    await expect(page.locator('[data-live]')).toHaveAttribute('data-live', '1');

    await page.getByLabel('Message', { exact: true }).fill('/task @planner Break this down :: proof');
    const posted = page.waitForResponse((response) => response.url().endsWith('/messages') && response.request().method() === 'POST');
    await page.getByLabel('Message', { exact: true }).press('Enter');
    const parentMessage = await (await posted).json() as Message;
    if (parentMessage.body.kind !== 'task') throw new Error('Expected task card');
    const parentId = parentMessage.body.taskId;

    // Filter on the title h3, not the whole card: the child card renders
    // "From: Break this down" as its lineage line and matches a card-wide text
    // filter, which is a strict mode violation resolving to both cards.
    const parentCard = page.locator('.chat-task')
      .filter({ has: page.locator('h3', { hasText: 'Break this down' }) });
    await expect(parentCard.locator('.tp-chip')).toHaveText('done', { timeout: 10_000 });
    await expect(parentCard.locator('[data-task-result]')).toHaveText('parent-done');

    // expect.poll returns undefined, not the polled value, so read the row again
    // once the poll has proven it exists.
    await expect.poll(async () => {
      const snapshot = await (await request.get(`${apiUrl}/tasks`)).json() as { tasks: Task[] };
      return snapshot.tasks.some((row) => row.parentTaskId === parentId);
    }, { timeout: 10_000 }).toBe(true);
    const listed = await (await request.get(`${apiUrl}/tasks`)).json() as { tasks: Task[] };
    const child = listed.tasks.find((row) => row.parentTaskId === parentId) as Task;
    expect(child.title).toBe('Review the split');
    expect(child.parentTaskId).toBe(parentId);
    expect(child.roomId).toBe('default');
    expect(child.agentId).toBe('echo');

    const childCard = page.locator('.chat-task').filter({ hasText: 'Review the split' });
    await expect(childCard.locator('.tp-chip')).toHaveText('done', { timeout: 10_000 });
    await expect(childCard.locator('[data-task-result]')).toHaveText('child-done');
    const lineage = childCard.locator('[data-task-parent]');
    await expect(lineage).toHaveText('From: Break this down');
    await childCard.scrollIntoViewIfNeeded();
    await expect(lineage).toBeInViewport({ ratio: 1 });
    const lineageBox = await lineage.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return { width: Math.round(box.width), height: Math.round(box.height) };
    });
    expect(lineageBox.width).toBeGreaterThan(80);
    expect(lineageBox.width).toBeLessThan(400);
    expect(lineageBox.height).toBeGreaterThan(12);
    expect(lineageBox.height).toBeLessThan(40);
    await expect(parentCard.locator('[data-task-parent]')).toHaveCount(0);

    await page.screenshot({ path: resolve('docs/screenshots/parent-task.png') });

    await childCard.getByLabel('Note').fill('tighten the split');
    const rejected = page.waitForResponse((response) => response.url().includes('/review') && response.request().method() === 'POST');
    await childCard.getByRole('button', { name: 'Reject', exact: true }).click();
    expect((await rejected).status()).toBe(200);
    await expect(childCard.locator('.tp-chip')).toHaveText('done', { timeout: 10_000 });
    await expect(childCard.locator('[data-task-result]')).toHaveText('child-resent tighten the split');
    await expect(childCard.locator('[data-task-parent]')).toHaveText('From: Break this down');
    const after = await (await request.get(`${apiUrl}/tasks/${child.id}`)).json() as Task;
    expect(after.parentTaskId).toBe(parentId);
    expect(after.result).toBe('child-resent tighten the split');
    const parentAfter = await (await request.get(`${apiUrl}/tasks/${parentId}`)).json() as Task;
    expect(parentAfter.parentTaskId).toBeNull();
    expect(parentAfter.result).toBe('parent-done');
  } finally {
    await Promise.all(contexts.map((item) => item.close()));
    await stopApi();
    rmSync(dir, { recursive: true, force: true });
  }
});
