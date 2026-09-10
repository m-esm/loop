import { test, expect, type BrowserContext } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import type { Message } from '@loop/types';
import { authedContext, seedSession, withAuth } from './auth';

test('an expanded running log follows its tail unless the human scrolled up', async ({ browser, request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-wip-log-'));
  const session = seedSession(join(dir, 'loop.sqlite'));
  const request = withAuth(raw, session.token);
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    agents: [
      {
        id: 'echo',
        name: 'Echo',
        command: [process.execPath, '-e',
          "const sleep=(ms)=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);};"
          + "for(let i=0;i<60;i++){process.stdout.write('log-line-'+i+'\\n');sleep(160);}"],
      },
    ],
  }));
  let api: ChildProcess | undefined;
  let output = '';
  const contexts: BrowserContext[] = [];
  const apiUrl = 'http://127.0.0.1:3101/api';
  const expectedTasks = () => 0;
  async function startApi() {
    api = spawn(process.execPath, ['dist/src/main.js'], {
      cwd: resolve('apps/api'),
      env: {
        ...process.env,
        PORT: '3101',
        WEB_ORIGIN: 'http://127.0.0.1:3100',
        DATABASE_PATH: join(dir, 'loop.sqlite'),
        LOOP_RUNNER: '1',
        LOOP_AGENTS_PATH: join(dir, 'agents.json'),
        LOOP_WALL_MS: '20000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    api.stdout?.on('data', (chunk) => { output += chunk; });
    api.stderr?.on('data', (chunk) => { output += chunk; });
    await expect.poll(async () => {
      if (api?.exitCode != null) throw new Error(output);
      return request.get(`${apiUrl}/tasks`)
        .then(async (response) => (response.status() === 200
          && ((await response.json()) as { tasks: unknown[] }).tasks.length === expectedTasks() ? 200 : 0))
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
    const context = await authedContext(browser, session.token);
    contexts.push(context);
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:3100');
    await expect(page.locator('[data-live]')).toHaveAttribute('data-live', '1');

    await page.getByLabel('Message', { exact: true }).fill('/task Watch the log :: proof');
    const posted = page.waitForResponse((response) => response.url().endsWith('/messages') && response.request().method() === 'POST');
    await page.getByLabel('Message', { exact: true }).press('Enter');
    const cardMessage = await (await posted).json() as Message;
    if (cardMessage.body.kind !== 'task') throw new Error('Expected task card');
    const card = page.locator('.chat-task').filter({ hasText: 'Watch the log' });
    const details = card.locator('details');
    const pre = card.locator('[data-task-log]');
    await expect(pre).toBeAttached({ timeout: 10_000 });
    await expect(details).not.toHaveAttribute('open');

    await details.locator('summary').click();
    await expect(details).toHaveAttribute('open', '');
    // Wait for a log tall enough that "scrolled up" is meaningfully far from the
    // bottom. Progress rows are compacted, so the pre grows in bursts.
    await expect.poll(() => pre.evaluate((el) => el.scrollHeight - el.clientHeight), { timeout: 15_000 }).toBeGreaterThan(160);
    await expect.poll(() => pre.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(80);

    const before = await pre.textContent();
    await pre.evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
    await expect.poll(async () => {
      const now = await pre.textContent();
      return (now?.length ?? 0) > (before?.length ?? 0);
    }, { timeout: 10_000 }).toBe(true);
    // Not pinned to 0: as content grows the browser may nudge scrollTop. The claim
    // is that it did NOT follow the tail, so assert it stayed far from the bottom.
    const distance = await pre.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    expect(distance).toBeGreaterThan(80);
  } finally {
    await Promise.all(contexts.map((ctx) => ctx.close()));
    await stopApi();
    rmSync(dir, { recursive: true, force: true });
  }
});
