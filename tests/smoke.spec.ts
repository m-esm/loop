import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import { authedContext, seedSession, withAuth } from './auth';

// The fast one. Every other spec proves one feature in depth; this proves the
// product still does its two basic things, so it is cheap enough to run after
// every change rather than only before a PR.
test('smoke: a chat message appears and a short task finishes', async ({ browser, request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-smoke-'));
  // Auth: the API rejects anonymous calls, so seed a session and use it for
  // both the readiness poll and the browser, the same way every other spec does.
  const session = seedSession(join(dir, 'loop.sqlite'));
  const request = withAuth(raw, session.token);
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    agents: [
      {
        id: 'echo',
        name: 'Echo',
        // Finishes immediately. A smoke test that waits on a slow agent stops
        // being a smoke test.
        command: [process.execPath, '-e', "process.stdout.write('smoke-ok\\n')"],
      },
    ],
  }));
  let api: ChildProcess | undefined;
  let output = '';
  const apiUrl = 'http://127.0.0.1:3101/api';
  try {
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
    // Same identity poll as every other spec: a bare 200 on 3101 can come from a
    // leftover server owning a different database.
    await expect.poll(async () => {
      if (api?.exitCode != null) throw new Error(output);
      return request.get(`${apiUrl}/tasks`)
        .then(async (response) => (response.status() === 200
          && ((await response.json()) as { tasks: unknown[] }).tasks.length === 0 ? 200 : 0))
        .catch(() => 0);
    }).toBe(200);

    const context = await authedContext(browser, session.token);
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:3100');
    await expect(page.locator('[data-live]')).toHaveAttribute('data-live', '1');

    // 1. Chat: a plain message reaches the transcript.
    await page.getByLabel('Message', { exact: true }).fill('smoke hello');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.message-card').filter({ hasText: 'smoke hello' })).toBeVisible();

    // 2. Task: /task runs a real command and reaches done with its stdout.
    await page.getByLabel('Message', { exact: true }).fill('/task smoke work :: it finishes');
    await page.getByRole('button', { name: 'Send' }).click();
    const card = page.locator('.chat-task').filter({ has: page.locator('h3', { hasText: 'smoke work' }) });
    await expect(card.locator('.tp-chip')).toHaveText('done', { timeout: 15_000 });
    await expect(card.locator('[data-task-result]')).toHaveText('smoke-ok');

    await context.close();
  } finally {
    if (api && api.exitCode === null) {
      const exited = once(api, 'exit');
      api.kill('SIGKILL');
      await exited;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
