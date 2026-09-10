import { test, expect, type BrowserContext } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import type { Message, Task } from '@loop/types';

test('a /task finishes with stdout no one hardcoded', async ({ browser, request }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-agent-'));
  const token = `live-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    agents: [{
      id: 'probe',
      name: 'Probe',
      command: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(`${token}\n`)})`],
    }],
  }));
  let api: ChildProcess | undefined;
  let output = '';
  const contexts: BrowserContext[] = [];
  const apiUrl = 'http://127.0.0.1:3101/api';
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
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    contexts.push(context);
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:3100');
    await expect(page.locator('[data-live]')).toHaveAttribute('data-live', '1');

    await page.getByLabel('Author', { exact: true }).fill('Moshe');
    await page.getByLabel('Message', { exact: true }).fill('/task Probe the runtime :: proof');
    const posted = page.waitForResponse((response) => response.url().endsWith('/messages') && response.request().method() === 'POST');
    await page.getByLabel('Message', { exact: true }).press('Enter');
    const cardMessage = await (await posted).json() as Message;
    if (cardMessage.body.kind !== 'task') throw new Error('Expected task card');
    const taskId = cardMessage.body.taskId;
    const card = page.locator('.chat-task').filter({ hasText: 'Probe the runtime' });
    await expect(card).toBeVisible();
    await expect(card.locator('.tp-chip')).toHaveText('done', { timeout: 10_000 });
    await expect(card.locator('[data-task-result]')).toHaveText(token);
    const task = await (await request.get(`${apiUrl}/tasks/${taskId}`)).json() as Task;
    expect(task.status).toBe('done');
    expect(task.result).toBe(token);
    expect(task.log).toContain(token);
    expect(task.result).not.toBe('Echo: Probe the runtime');
  } finally {
    await Promise.all(contexts.map((item) => item.close()));
    await stopApi();
    rmSync(dir, { recursive: true, force: true });
  }
});
