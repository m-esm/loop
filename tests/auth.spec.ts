import { test, expect, type BrowserContext } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import { cookieHeader, OPERATOR, seedSession } from './auth';
import { captureFlow } from './capture';

test('login form then the room after login', async ({ browser, request }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-auth-ui-'));
  const session = seedSession(join(dir, 'loop.sqlite'));
  let api: ChildProcess | undefined;
  let output = '';
  const contexts: BrowserContext[] = [];
  const apiUrl = 'http://127.0.0.1:3101/api';
  async function startApi() {
    api = spawn(process.execPath, ['dist/src/main.js'], {
      cwd: resolve('apps/api'),
      env: { ...process.env, PORT: '3101', WEB_ORIGIN: 'http://127.0.0.1:3100', DATABASE_PATH: join(dir, 'loop.sqlite'), LOOP_RUNNER: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    api.stdout?.on('data', (chunk) => { output += chunk; });
    api.stderr?.on('data', (chunk) => { output += chunk; });
    await expect.poll(async () => {
      if (api?.exitCode != null) throw new Error(output);
      return request.get(`${apiUrl}/tasks`, { headers: cookieHeader(session.token) })
        .then(async (response) => (response.status() === 200
          && ((await response.json()) as { tasks: unknown[] }).tasks.length === 0 ? 200 : 0))
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
    await page.goto('http://127.0.0.1:3100/?room=default');
    // One form at a time: sign-in is the default, register is a click away,
    // and the signed-out page shows none of the app shell.
    await expect(page.getByRole('form', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('form', { name: 'Create account' })).toHaveCount(0);
    await expect(page.locator('.projects')).toBeHidden();
    await expect(page.locator('#inspector')).toBeHidden();
    await page.getByRole('button', { name: 'Create one' }).click();
    await expect(page.getByRole('form', { name: 'Create account' })).toBeVisible();
    await expect(page.getByRole('form', { name: 'Sign in' })).toHaveCount(0);
    // The switch link shares its accessible name with the submit button.
    await page.locator('.auth-switch').getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('form', { name: 'Sign in' })).toBeVisible();
    // One frame at 1440x900, not a two-frame collage: a capture taller than the
    // viewport documents a page nobody sees at that size.
    await captureFlow(page, 'auth');

    const signIn = page.getByRole('form', { name: 'Sign in' });
    await signIn.getByLabel('Email').fill(OPERATOR.email);
    await signIn.getByLabel('Password').fill(OPERATOR.password);
    await signIn.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('[data-live]')).toHaveAttribute('data-live', '1');
    await expect(page.locator('.account-chrome')).toContainText(OPERATOR.displayName);
    await expect(page.getByRole('navigation', { name: 'Room views' }).getByRole('button', { name: 'Log out' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page.getByRole('form', { name: 'Sign in' })).toBeVisible();
  } finally {
    await Promise.all(contexts.map((item) => item.close()));
    await stopApi();
    rmSync(dir, { recursive: true, force: true });
  }
});
