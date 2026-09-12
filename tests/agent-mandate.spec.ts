import { test, expect, type BrowserContext } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { authedContext, seedSession, withAuth } from './auth';

const apiUrl = 'http://127.0.0.1:3101/api';
const MANDATE = 'stay on the happy path';

function probeAgents() {
  return {
    agents: [
      {
        id: 'echo',
        name: 'Echo',
        command: [process.execPath, '-e', "process.stdout.write('ok\\n')"],
      },
      {
        id: 'probe',
        name: 'Probe',
        command: [process.execPath, '-e', "process.stdout.write('ok\\n')"],
      },
    ],
  };
}

test('an owner edits a room agent mandate in the inspector profile and it persists', async ({ browser, request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-agent-mandate-'));
  const session = seedSession(join(dir, 'loop.sqlite'));
  const request = withAuth(raw, session.token);
  writeFileSync(join(dir, 'agents.json'), JSON.stringify(probeAgents()));
  const { stop } = await startApi(dir, request);
  const contexts: BrowserContext[] = [];
  try {
    const created = await request.post(`${apiUrl}/rooms/default/agents`, {
      data: { catalogId: 'probe', name: 'scout' },
    });
    expect(created.status()).toBe(201);
    const agent = await created.json() as { id: string };

    const context = await authedContext(browser, session.token);
    contexts.push(context);
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:3100');
    await expect(page.locator('[data-live]')).toHaveAttribute('data-live', '1');

    const teamHeading = page.getByRole('heading', { name: 'Team' });
    const agentsHeading = page.getByRole('heading', { name: 'Agents' });
    const close = page.getByRole('button', { name: 'Close' });
    const empty = page.locator('.inspector-empty');
    const profile = page.getByRole('region', { name: 'Agent profile' });
    const agentBody = page.locator('[data-inspector-body="agent"]');

    await expect(empty).toBeVisible();
    await expect(profile).toHaveCount(0);
    await expect(teamHeading).toHaveCount(0);
    await expect(agentsHeading).toHaveCount(0);

    await page.getByRole('button', { name: 'Agents' }).click();
    await page.getByRole('button', { name: '@scout' }).click();
    await expect(page.locator('.inspector-kind')).toHaveText('AGENT');
    await expect(agentBody).toHaveCount(1);
    await expect(profile).toBeVisible();
    await expect(profile.getByRole('form', { name: 'Edit mandate' })).toBeVisible();
    await expect(agentsHeading).toHaveCount(0);
    await expect(teamHeading).toHaveCount(0);

    await profile.getByRole('textbox', { name: 'Mandate' }).fill(MANDATE);
    // Sabotage: skip the PATCH and only set local state; reload would fail.
    const saved = page.waitForResponse((response) =>
      response.url().includes(`/rooms/default/agents/`) && response.request().method() === 'PATCH');
    await profile.getByRole('button', { name: 'Save' }).click();
    expect((await saved).status()).toBe(200);
    await expect(profile.getByRole('textbox', { name: 'Mandate' })).toHaveValue(MANDATE);
    await expect(page.locator('.inspector-kind')).toHaveText('AGENT');
    await expect(agentBody).toHaveCount(1);
    await expect(close).toBeVisible();
    await expect(agentsHeading).toHaveCount(0);
    await page.screenshot({ path: resolve('docs/screenshots/agent-mandate.png') });

    await page.reload();
    await expect(page.locator('[data-live]')).toHaveAttribute('data-live', '1');
    await page.getByRole('button', { name: 'Agents' }).click();
    await page.getByRole('button', { name: '@scout' }).click();
    await expect(profile.getByRole('textbox', { name: 'Mandate' })).toHaveValue(MANDATE);

    const registered = await raw.post(`${apiUrl}/auth/register`, {
      data: { email: 'mandate-member@loop.local', password: 'password1', displayName: 'Member' },
    });
    expect(registered.status()).toBe(201);
    const setCookie = registered.headers()['set-cookie'] ?? '';
    const token = /loop_session=([^;]+)/.exec(Array.isArray(setCookie) ? setCookie.join(';') : setCookie)?.[1];
    if (!token) throw new Error('expected session cookie');
    const member = withAuth(raw, token);
    const denied = await member.patch(`${apiUrl}/rooms/default/agents/${agent.id}`, {
      data: { mandate: 'nope' },
    });
    expect(denied.status()).toBe(403);
    const missing = await request.patch(`${apiUrl}/rooms/default/agents/missing-agent`, {
      data: { mandate: 'gone' },
    });
    expect(missing.status()).toBe(404);
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
      LOOP_ALLOW_REGISTER: '1',
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
