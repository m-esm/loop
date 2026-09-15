import { test, expect, type BrowserContext } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import type { Task } from '@loop/types';
import { authedContext, seedSession, withAuth } from './auth';

const apiUrl = 'http://127.0.0.1:3101/api';

test('a short room sits by the composer and the header says what is happening, not where', async ({ browser, request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-chrome-'));
  const session = seedSession(join(dir, 'loop.sqlite'));
  const request = withAuth(raw, session.token);
  let context: BrowserContext | undefined;
  let output = '';
  const api = spawn(process.execPath, ['dist/src/main.js'], {
    cwd: resolve('apps/api'),
    env: { ...process.env, PORT: '3101', WEB_ORIGIN: 'http://127.0.0.1:3100',
      DATABASE_PATH: join(dir, 'loop.sqlite'), LOOP_RUNNER: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  api.stdout?.on('data', (chunk) => { output += chunk; });
  api.stderr?.on('data', (chunk) => { output += chunk; });
  try {
    await expect.poll(async () => {
      if (api.exitCode !== null) throw new Error(output);
      return request.get(`${apiUrl}/rooms/default`).then((response) => response.status()).catch(() => 0);
    }).toBe(200);
    const room = await (await request.post(`${apiUrl}/rooms`, { data: { name: 'Klonk' } })).json();
    await request.post(`${apiUrl}/messages`, { data: { roomId: room.id, body: 'First note.' } });
    context = await authedContext(browser, session.token);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:3100/?room=${room.id}`);
    await expect(page.locator('[data-live]')).toHaveAttribute('data-live', '1');

    // The rail names the room, so the heading must not repeat it.
    await expect(page.locator(`#projects-rail [data-room="${room.id}"]`)).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#room-context')).toHaveText('Klonk');
    await expect(page.locator('#room-heading')).not.toHaveText('Klonk');
    await expect(page.locator('#room-heading')).toHaveText('Nothing running');

    // One message must sit next to the composer, not under the tab row with
    // the pane empty below it.
    const gap = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.message-card')];
      const last = cards.at(-1)!.getBoundingClientRect();
      const transcript = document.querySelector('.transcript')!.getBoundingClientRect();
      return Math.round(transcript.bottom - last.bottom);
    });
    expect(gap).toBeLessThan(60);

    // The headline tracks room state rather than being decoration.
    const task = await (await request.post(`${apiUrl}/tasks`, {
      data: { title: 'Decide the lock body', definitionOfDone: 'A human decides.', roomId: room.id },
    })).json() as Task;
    expect((await request.patch(`${apiUrl}/tasks/${task.id}/status`, { data: { status: 'needs_input' } })).ok()).toBeTruthy();
    await expect(page.locator('#room-heading')).toHaveText('1 task needs you');
    expect((await request.patch(`${apiUrl}/rooms/${room.id}/steer`, { data: { paused: true } })).ok()).toBeTruthy();
    await expect(page.locator('#room-heading')).toHaveText('Paused');

    // A long transcript still scrolls: the auto margin must collapse.
    for (let i = 0; i < 30; i++) {
      await request.post(`${apiUrl}/messages`, { data: { roomId: room.id, body: `Filler ${i}` } });
    }
    await expect.poll(async () => page.evaluate(() => {
      const el = document.querySelector('.transcript')!;
      return el.scrollHeight > el.clientHeight;
    })).toBe(true);
  } finally {
    await context?.close();
    if (api.exitCode === null) {
      const exited = once(api, 'exit');
      api.kill('SIGKILL');
      await exited;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
