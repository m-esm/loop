import { test, expect, type BrowserContext } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { authedContext, seedSession, withAuth } from './auth';

const apiUrl = 'http://127.0.0.1:3101/api';
const DISTINCTIVE = 'hello from artifact';

function upload(request: ReturnType<typeof withAuth>, room: string, name: string, body: Buffer, mimeType = 'text/plain') {
  return request.post(`${apiUrl}/rooms/${room}/files`, {
    multipart: { file: { name, mimeType, buffer: body } },
  });
}

test('clicking a room file opens a closable artifact preview in the inspector', async ({ browser, request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-artifact-preview-'));
  const session = seedSession(join(dir, 'loop.sqlite'));
  const request = withAuth(raw, session.token);
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ agents: [] }));
  const { stop } = await startApi(dir, request);
  const contexts: BrowserContext[] = [];
  try {
    const created = await upload(request, 'default', 'brief.txt', Buffer.from(`${DISTINCTIVE}\nsecond line\n`));
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
    const preview = page.getByRole('region', { name: 'Artifact preview' });
    const taskDetail = page.getByRole('region', { name: 'Task detail' });
    const artifactBody = page.locator('[data-inspector-body="artifact"]');

    await expect(empty).toBeVisible();
    await expect(empty).toHaveText('Pick a task, Team, Agents, or a thread.');
    await expect(close).toHaveCount(0);
    await expect(artifactBody).toHaveCount(0);
    await expect(preview).toHaveCount(0);
    await expect(teamHeading).toHaveCount(0);
    await expect(agentsHeading).toHaveCount(0);
    await page.screenshot({ path: resolve('docs/screenshots/artifact-preview-closed.png') });

    await page.getByRole('button', { name: 'Files', exact: true }).click();
    const row = page.locator('[data-file-row]').filter({ hasText: 'brief.txt' });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'brief.txt' }).click();

    await expect(page.locator('.inspector-kind')).toHaveText('FILE');
    await expect(page.locator('.inspector-title')).toHaveText('brief.txt');
    await expect(close).toBeVisible();
    await expect(close).toBeInViewport({ ratio: 1 });
    await expect(artifactBody).toHaveCount(1);
    await expect(artifactBody).toBeVisible();
    await expect(artifactBody).toBeInViewport({ ratio: 1 });
    await expect(preview).toHaveCount(1);
    await expect(preview).toBeVisible();
    await expect(preview).toBeInViewport({ ratio: 1 });
    await expect(preview.getByText('brief.txt')).toBeVisible();
    await expect(preview.getByText(DISTINCTIVE)).toBeVisible();
    await expect(teamHeading).toHaveCount(0);
    await expect(agentsHeading).toHaveCount(0);
    await expect(taskDetail).toHaveCount(0);
    await expect(page.getByRole('form', { name: 'Add agent' })).toHaveCount(0);
    await expect(page.getByRole('form', { name: 'Invite to room' })).toHaveCount(0);
    await expect(page.locator('[data-inspector-body="agents"]')).toHaveCount(0);
    await expect(page.locator('[data-inspector-body="team"]')).toHaveCount(0);
    await expect(page.locator('[data-inspector-body="task"]')).toHaveCount(0);
    await expect(page.locator('[data-inspector-body="thread"]')).toHaveCount(0);
    await expect(page.locator('[data-inspector-body="agent"]')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Files' })).toBeVisible();
    await expect(row).toBeVisible();
    await page.screenshot({ path: resolve('docs/screenshots/artifact-preview-open.png') });

    await close.click();
    await expect(empty).toBeVisible();
    await expect(preview).toHaveCount(0);
    await expect(artifactBody).toHaveCount(0);
    await expect(close).toHaveCount(0);
    await expect(agentsHeading).toHaveCount(0);
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
      LOOP_FILES_PATH: join(dir, 'files'),
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
