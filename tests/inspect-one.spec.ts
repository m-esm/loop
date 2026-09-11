import { test, expect, type BrowserContext } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { authedContext, seedSession, withAuth } from './auth';

const apiUrl = 'http://127.0.0.1:3101/api';

test('the inspector shows one of Task, Team, or Agents, and Close returns to empty', async ({ browser, request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-inspect-one-'));
  const session = seedSession(join(dir, 'loop.sqlite'));
  const request = withAuth(raw, session.token);
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    agents: [{ id: 'echo', name: 'Echo', command: [process.execPath, '-e', "process.stdout.write('ok\\n')"] }],
  }));
  const { stop } = await startApi(dir, request);
  const contexts: BrowserContext[] = [];
  try {
    const created = await request.post(`${apiUrl}/tasks`, {
      data: { title: 'inspect work', definitionOfDone: 'the inspector shows it', roomId: 'default' },
    });
    expect(created.status()).toBe(201);

    const context = await authedContext(browser, session.token);
    contexts.push(context);
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:3100');
    await expect(page.locator('[data-live]')).toHaveAttribute('data-live', '1');

    const teamHeading = page.getByRole('heading', { name: 'Team' });
    const agentsHeading = page.getByRole('heading', { name: 'Agents' });
    const close = page.getByRole('button', { name: 'Close' });
    const empty = page.locator('.inspector-empty');

    await expect(teamHeading).toHaveCount(0);
    await expect(agentsHeading).toHaveCount(0);
    await expect(page.getByRole('form', { name: 'Invite to room' })).toHaveCount(0);
    await expect(page.getByRole('form', { name: 'Add agent' })).toHaveCount(0);
    await expect(empty).toHaveText('Pick a task, Team, or Agents.');
    await expect(empty).toBeVisible();
    await expect(close).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Task', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Team' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Agents' })).toBeVisible();
    await page.screenshot({ path: resolve('docs/screenshots/inspect-one-closed.png') });

    await page.getByRole('button', { name: 'Team' }).click();
    await expect(page.getByRole('form', { name: 'Invite to room' })).toBeVisible();
    await expect(teamHeading).toHaveCount(1);
    await expect(agentsHeading).toHaveCount(0);
    await expect(close).toBeVisible();
    await expect(close).toBeInViewport({ ratio: 1 });
    await expect(page.locator('[data-inspector-body="team"]')).toBeInViewport({ ratio: 1 });
    await close.click();
    await expect(empty).toBeVisible();
    await expect(teamHeading).toHaveCount(0);
    await expect(agentsHeading).toHaveCount(0);
    await expect(close).toHaveCount(0);

    await page.getByRole('button', { name: 'Agents' }).click();
    await expect(page.getByRole('form', { name: 'Add agent' })).toBeVisible();
    await expect(agentsHeading).toHaveCount(1);
    await expect(teamHeading).toHaveCount(0);
    await expect(close).toBeVisible();

    await page.getByRole('button', { name: 'Tasks', exact: true }).click();
    await page.getByRole('button', { name: 'inspect work' }).click();
    await expect(page.locator('.inspector-title')).toHaveText('inspect work');
    await expect(page.getByRole('region', { name: 'Task detail' })).toBeVisible();
    await expect(teamHeading).toHaveCount(0);
    await expect(agentsHeading).toHaveCount(0);
    await expect(close).toBeVisible();
    await expect(close).toBeInViewport({ ratio: 1 });
    await expect(page.locator('[data-inspector-body="task"]')).toBeInViewport({ ratio: 1 });
    await expect(page.locator('[data-inspector-body="task"] .task-detail')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Task', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Team' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Agents' })).toBeVisible();
    await page.screenshot({ path: resolve('docs/screenshots/inspect-one-open.png') });

    await close.click();
    await expect(empty).toBeVisible();
    await expect(page.getByRole('region', { name: 'Task detail' })).toHaveCount(0);
    await expect(teamHeading).toHaveCount(0);
    await expect(agentsHeading).toHaveCount(0);
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
