import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { authedContext, seedSession, withAuth } from './auth';

// The collapse is the feature, so assert it before expanding. A bare
// "expand if not already expanded" passes against a panel that is open at
// rest, which is exactly the stance this change removed.
async function expandSteering(page: Page) {
  const group = page.getByRole('group', { name: 'Room steering' });
  const toggle = group.locator('.room-steering-toggle');
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(group.getByRole('button')).toHaveCount(1);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

test('owners persist the verbosity dial, members cannot steer, and threads omit controls', async ({ browser, request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-verbosity-browser-'));
  const session = seedSession(join(dir, 'loop.sqlite'));
  const request = withAuth(raw, session.token);
  const apiUrl = 'http://127.0.0.1:3101/api';
  const contexts: BrowserContext[] = [];
  let output = '';
  const api = spawn(process.execPath, ['dist/src/main.js'], {
    cwd: resolve('apps/api'),
    env: { ...process.env, PORT: '3101', WEB_ORIGIN: 'http://127.0.0.1:3100',
      DATABASE_PATH: join(dir, 'loop.sqlite'), LOOP_RUNNER: '0', LOOP_ALLOW_REGISTER: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
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
    const controls = page.getByRole('group', { name: 'Room steering', exact: true });
    await expandSteering(page);
    await expect(controls.getByRole('button', { name: 'Normal', exact: true })).toHaveAttribute('aria-pressed', 'true');
    for (const label of ['Quiet', 'Verbose', 'Normal']) {
      // The panel is already open here: either from the expand above or from
      // the post-reload expand at the end of the previous iteration.
      await controls.getByRole('button', { name: label, exact: true }).click();
      await expect(controls.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-pressed', 'true');
      expect((await (await request.get(`${apiUrl}/rooms/default`)).json()).verbosity).toBe(label.toLowerCase());
      await page.reload();
      await expandSteering(page);
      await expect(controls.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-pressed', 'true');
    }
    await page.getByLabel('Message', { exact: true }).fill('Keep progress quiet while we focus. Switch to Verbose to inspect every line.');
    await page.getByLabel('Message', { exact: true }).press('Enter');
    await expect(page.getByRole('log')).toContainText('Keep progress quiet');
    for (const label of ['Pause', 'Wrap up', 'Quiet', 'Normal', 'Verbose']) {
      await expect(controls.getByRole('button', { name: label, exact: true })).toBeInViewport({ ratio: 1 });
    }
    await page.screenshot({ path: resolve('docs/screenshots/verbosity.png') });
    await page.getByRole('log').getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(page.locator('[data-thread-composer]')).toBeVisible();
    await expect(page.locator('[data-thread-composer]').getByRole('group', { name: 'Room steering' })).toHaveCount(0);
    const registration = await raw.post(`${apiUrl}/auth/register`, {
      data: { email: 'verbosity-member@loop.local', password: 'password1', displayName: 'Member' },
    });
    expect(registration.status()).toBe(201);
    const token = /loop_session=([^;]+)/.exec(registration.headers()['set-cookie'] ?? '')?.[1];
    if (!token) throw new Error('expected session cookie');
    expect((await withAuth(raw, token).patch(`${apiUrl}/rooms/default/steer`, { data: { verbosity: 'quiet' } })).status()).toBe(403);
    const memberContext = await authedContext(browser, token);
    contexts.push(memberContext);
    const memberPage = await memberContext.newPage();
    await memberPage.goto('http://127.0.0.1:3100/?room=default');
    await expandSteering(memberPage);
    const memberControls = memberPage.getByRole('group', { name: 'Verbosity', exact: true });
    await expect(memberControls.getByRole('button', { name: 'Normal', exact: true })).toHaveAttribute('aria-pressed', 'true');
    for (const label of ['Quiet', 'Normal', 'Verbose']) {
      await expect(memberControls.getByRole('button', { name: label, exact: true })).toBeDisabled();
    }
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
