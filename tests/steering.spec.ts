import { test, expect, type BrowserContext } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import type { RoomSummary, Task } from '@loop/types';
import { authedContext, seedSession, withAuth } from './auth';

const apiUrl = 'http://127.0.0.1:3101/api';

test('room steering persists, pauses the runner, wraps up one turn, and stays out of threads', async ({ browser, request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-steering-browser-'));
  const session = seedSession(join(dir, 'loop.sqlite'));
  const request = withAuth(raw, session.token);
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ agents: [{
    id: 'probe', name: 'Probe', command: [process.execPath, '-e',
      "console.log(process.env.LOOP_TASK_STEERING || 'ordinary turn')"],
  }] }));
  const contexts: BrowserContext[] = [];
  let output = '';
  const api = spawn(process.execPath, ['dist/src/main.js'], {
    cwd: resolve('apps/api'),
    env: {
      ...process.env, PORT: '3101', WEB_ORIGIN: 'http://127.0.0.1:3100',
      DATABASE_PATH: join(dir, 'loop.sqlite'), LOOP_RUNNER: '1',
      LOOP_AGENTS_PATH: join(dir, 'agents.json'), LOOP_ALLOW_REGISTER: '1',
    }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  api.stdout?.on('data', (chunk) => { output += chunk; });
  api.stderr?.on('data', (chunk) => { output += chunk; });
  try {
    await expect.poll(async () => {
      if (api.exitCode !== null) throw new Error(output);
      return request.get(`${apiUrl}/rooms/default`).then((response) => response.status()).catch(() => 0);
    }).toBe(200);
    const context = await authedContext(browser, session.token);
    contexts.push(context);
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:3100/?room=default');
    await expect(page.locator('[data-live]')).toHaveAttribute('data-live', '1');
    const controls = page.getByRole('group', { name: 'Room steering' });
    await expect(controls.getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
    await page.getByLabel('Message', { exact: true }).fill('Keep this pass focused on a concrete result.');
    await page.getByLabel('Message', { exact: true }).press('Enter');
    await expect(page.getByRole('log')).toContainText('Keep this pass focused');
    await expect(controls.getByRole('button', { name: 'Wrap up' })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: resolve('docs/screenshots/steering.png') });

    await controls.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(controls.getByRole('button', { name: 'Resume' })).toBeEnabled();
    const state = async () => (await (await request.get(`${apiUrl}/rooms/default`)).json()) as RoomSummary;
    expect((await state()).paused).toBe(true);
    await page.reload();
    await expect(controls.getByRole('button', { name: 'Resume' })).toBeEnabled();
    await controls.getByRole('button', { name: 'Wrap up' }).click();
    await expect(controls).toContainText('Wrap up queued.');
    expect((await state()).wrapUp).toBe(true);
    const created = await request.post(`${apiUrl}/tasks`, {
      data: { title: 'Converge now', definitionOfDone: 'One wrap up instruction' },
    });
    expect(created.status()).toBe(201);
    const task = await created.json() as Task;
    // Wait longer than a runner tick, then assert that no claim occurred.
    await page.waitForTimeout(1200);
    const queued = await (await request.get(`${apiUrl}/tasks/${task.id}`)).json() as Task;
    expect(queued.status).toBe('queued');
    expect(queued.runId).toBeNull();
    expect((await state()).wrapUp).toBe(true);
    await controls.getByRole('button', { name: 'Resume' }).click();
    await expect.poll(async () => (await (await request.get(`${apiUrl}/tasks/${task.id}`)).json() as Task).result)
      .toContain('Wrap up: converge on a concrete result');
    await expect(controls.getByRole('button', { name: 'Wrap up' })).toBeEnabled();
    expect((await state()).wrapUp).toBe(false);
    const next = await (await request.post(`${apiUrl}/tasks`, {
      data: { title: 'Next turn', definitionOfDone: 'Ordinary input' },
    })).json() as Task;
    await expect.poll(async () => (await (await request.get(`${apiUrl}/tasks/${next.id}`)).json() as Task).result)
      .toBe('ordinary turn');

    await page.getByRole('log').getByRole('button', { name: 'Reply', exact: true }).click();
    const thread = page.locator('[data-thread-composer]');
    await expect(thread).toBeVisible();
    await expect(thread.getByRole('group', { name: 'Room steering' })).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Room steering' })).toHaveCount(1);

    const registration = await raw.post(`${apiUrl}/auth/register`, {
      data: { email: 'steering-member@loop.local', password: 'password1', displayName: 'Member' },
    });
    expect(registration.status()).toBe(201);
    const token = /loop_session=([^;]+)/.exec(registration.headers()['set-cookie'] ?? '')?.[1];
    if (!token) throw new Error('expected session cookie');
    const member = withAuth(raw, token);
    expect((await member.patch(`${apiUrl}/rooms/default/steer`, { data: { paused: true } })).status()).toBe(403);
    expect((await member.patch(`${apiUrl}/rooms/default/steer`, { data: { wrapUp: true } })).status()).toBe(403);
    const memberContext = await authedContext(browser, token);
    contexts.push(memberContext);
    const memberPage = await memberContext.newPage();
    await memberPage.goto('http://127.0.0.1:3100/?room=default');
    const memberControls = memberPage.getByRole('group', { name: 'Room steering' });
    await expect(memberControls.getByRole('button', { name: 'Pause', exact: true })).toBeDisabled();
    await expect(memberControls.getByRole('button', { name: 'Wrap up' })).toBeDisabled();

    // Another client changes the room; the existing owner composer refreshes.
    expect((await request.patch(`${apiUrl}/rooms/default/steer`, { data: { paused: true } })).status()).toBe(200);
    await expect(controls.getByRole('button', { name: 'Resume' })).toBeEnabled();
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    if (api.exitCode === null) {
      const exited = once(api, 'exit');
      api.kill('SIGKILL');
      await exited;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
