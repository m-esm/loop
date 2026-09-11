import { test, expect, type BrowserContext } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import type { Message } from '@loop/types';
import { authedContext, seedSession, withAuth } from './auth';

const apiUrl = 'http://127.0.0.1:3101/api';

test('a message opens a thread in the inspector and replies stay off the main stream', async ({ browser, request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-thread-'));
  const session = seedSession(join(dir, 'loop.sqlite'));
  const request = withAuth(raw, session.token);
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    agents: [{ id: 'echo', name: 'Echo', command: [process.execPath, '-e', "process.stdout.write('ok\\n')"] }],
  }));
  const { stop } = await startApi(dir, request);
  const contexts: BrowserContext[] = [];
  try {
    expect((await request.post(`${apiUrl}/messages`, {
      data: { roomId: 'default', body: 'ghost', parentId: 'missing-parent' },
    })).status()).toBe(400);
    const other = await request.post(`${apiUrl}/rooms`, { data: { name: 'Other' } });
    expect(other.status()).toBe(201);
    const room = await other.json() as { id: string };
    const foreign = await request.post(`${apiUrl}/messages`, {
      data: { roomId: room.id, body: 'elsewhere' },
    });
    expect(foreign.status()).toBe(201);
    const foreignMsg = await foreign.json() as Message;
    expect((await request.post(`${apiUrl}/messages`, {
      data: { roomId: 'default', body: 'cross', parentId: foreignMsg.id },
    })).status()).toBe(400);

    const context = await authedContext(browser, session.token);
    contexts.push(context);
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:3100');
    await expect(page.locator('[data-live]')).toHaveAttribute('data-live', '1');

    const teamHeading = page.getByRole('heading', { name: 'Team' });
    const agentsHeading = page.getByRole('heading', { name: 'Agents' });
    const close = page.getByRole('button', { name: 'Close' });
    const empty = page.locator('.inspector-empty');
    const transcript = page.getByRole('log');

    await expect(teamHeading).toHaveCount(0);
    await expect(agentsHeading).toHaveCount(0);
    await expect(empty).toBeVisible();
    await expect(page.locator('[data-inspector-body="thread"]')).toHaveCount(0);
    await page.screenshot({ path: resolve('docs/screenshots/thread-closed.png') });

    const posted = page.waitForResponse((response) => response.url().endsWith('/messages') && response.request().method() === 'POST');
    await page.getByLabel('Message', { exact: true }).fill('hello');
    await page.getByLabel('Message', { exact: true }).press('Enter');
    const root = await (await posted).json() as Message;
    await expect(transcript.locator('[data-message-id]')).toHaveCount(1);
    await expect(transcript).toContainText('hello');
    await expect(transcript.getByRole('button', { name: 'Reply' })).toBeVisible();

    await transcript.getByRole('button', { name: 'Reply' }).click();
    await expect(page.locator('.inspector-kind')).toHaveText('THREAD');
    await expect(page.locator('.inspector-title')).toHaveText('hello');
    await expect(close).toBeVisible();
    await expect(close).toBeInViewport({ ratio: 1 });
    await expect(page.locator('[data-inspector-body="thread"]')).toBeVisible();
    await expect(page.locator('[data-thread-composer]')).toBeVisible();
    await expect(page.locator('[data-thread-composer]')).toBeInViewport({ ratio: 1 });
    await expect(teamHeading).toHaveCount(0);
    await expect(agentsHeading).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Task detail' })).toHaveCount(0);
    await page.screenshot({ path: resolve('docs/screenshots/thread-open.png') });

    await page.getByLabel('Reply', { exact: true }).fill('in thread');
    await page.locator('[data-thread-composer]').getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('[data-inspector-body="thread"]')).toContainText('in thread');
    await expect(transcript.locator('[data-message-id]')).toHaveCount(1);
    await expect(transcript.getByText('in thread')).toHaveCount(0);
    const summary = transcript.locator('[data-thread-summary]');
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('1 reply');
    await expect(transcript.getByRole('button', { name: 'Reply', exact: true })).toHaveCount(0);

    const live = await request.post(`${apiUrl}/messages`, {
      data: { roomId: 'default', body: 'from other tab', parentId: root.id },
    });
    expect(live.status()).toBe(201);
    await expect(page.locator('[data-inspector-body="thread"]')).toContainText('from other tab');
    await expect(transcript.getByText('from other tab')).toHaveCount(0);
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('2 replies');
    await expect(summary.locator('[data-participant]')).toHaveCount(1);
    await expect(summary.locator('[data-participant]')).toContainText('M');
    await expect(summary).toBeInViewport({ ratio: 1 });
    await expect(transcript.getByRole('button', { name: 'Reply', exact: true })).toHaveCount(0);
    await close.click();
    await expect(empty).toBeVisible();
    await page.screenshot({ path: resolve('docs/screenshots/thread-participants.png') });
    await summary.click();
    await expect(page.locator('.inspector-kind')).toHaveText('THREAD');
    await expect(page.locator('[data-inspector-body="thread"]')).toBeVisible();

    await close.click();
    await expect(empty).toBeVisible();
    await expect(page.locator('[data-inspector-body="thread"]')).toHaveCount(0);
    await expect(close).toHaveCount(0);
    await expect(teamHeading).toHaveCount(0);
    await expect(agentsHeading).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Task detail' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Team' }).click();
    await expect(teamHeading).toHaveCount(1);
    await expect(agentsHeading).toHaveCount(0);
    await close.click();
    await page.getByRole('button', { name: 'Agents' }).click();
    await expect(agentsHeading).toHaveCount(1);
    await expect(teamHeading).toHaveCount(0);
  } finally {
    await Promise.all(contexts.map((item) => item.close()));
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function startApi(
  dir: string,
  request: ReturnType<typeof withAuth>,
): Promise<{ stop: () => Promise<void>; output: string }> {
  let output = '';
  const api = spawn(process.execPath, ['dist/src/main.js'], {
    cwd: resolve('apps/api'),
    env: {
      ...process.env,
      PORT: '3101',
      WEB_ORIGIN: 'http://127.0.0.1:3100',
      DATABASE_PATH: join(dir, 'loop.sqlite'),
      LOOP_RUNNER: '0',
      LOOP_AGENTS_PATH: join(dir, 'agents.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  api.stdout?.on('data', (chunk) => { output += chunk; });
  api.stderr?.on('data', (chunk) => { output += chunk; });
  await expect.poll(async () => {
    if (api.exitCode != null) throw new Error(output);
    return request.get(`${apiUrl}/tasks`)
      .then(async (response) => (response.status() === 200
        && ((await response.json()) as { tasks: unknown[] }).tasks.length === 0 ? 200 : 0))
      .catch(() => 0);
  }).toBe(200);
  return {
    output,
    stop: async () => {
      if (!api || api.exitCode !== null) return;
      const exited = once(api, 'exit');
      api.kill('SIGKILL');
      await exited;
    },
  };
}
