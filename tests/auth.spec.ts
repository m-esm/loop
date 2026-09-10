import { test, expect, type BrowserContext } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import { cookieHeader, OPERATOR, seedSession } from './auth';

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
    await page.goto('http://127.0.0.1:3100');
    await expect(page.getByRole('form', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('form', { name: 'Create account' })).toBeVisible();
    const loginShot = resolve('/tmp/loop-auth-login.png');
    await page.screenshot({ path: loginShot });

    const signIn = page.getByRole('form', { name: 'Sign in' });
    await signIn.getByLabel('Email').fill(OPERATOR.email);
    await signIn.getByLabel('Password').fill(OPERATOR.password);
    await signIn.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('[data-live]')).toHaveAttribute('data-live', '1');
    await expect(page.getByText(`Signed in as ${OPERATOR.displayName}`)).toBeVisible();
    const roomShot = resolve('/tmp/loop-auth-room.png');
    await page.screenshot({ path: roomShot });

    const loginB64 = readFileSync(loginShot).toString('base64');
    const roomB64 = readFileSync(roomShot).toString('base64');
    const collage = await browser.newPage();
    await collage.setViewportSize({ width: 1440, height: 900 });
    await collage.setContent(
      `<html><body style="margin:0;background:#fff">
        <img src="data:image/png;base64,${loginB64}" style="display:block;width:1440px" />
        <img src="data:image/png;base64,${roomB64}" style="display:block;width:1440px" />
      </body></html>`,
    );
    await collage.screenshot({ path: resolve('docs/screenshots/auth.png'), fullPage: true });
    await collage.close();
  } finally {
    await Promise.all(contexts.map((item) => item.close()));
    await stopApi();
    rmSync(dir, { recursive: true, force: true });
  }
});
