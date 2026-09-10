import { test, expect, type BrowserContext } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import type { Message } from '@loop/types';

test('question card answers in the browser and the same task reaches done', async ({ browser, request }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-ask-'));
  let api: ChildProcess | undefined;
  let output = '';
  const contexts: BrowserContext[] = [];
  const apiUrl = 'http://127.0.0.1:3101/api';
  async function startApi() {
    api = spawn(process.execPath, ['dist/src/main.js'], {
      cwd: resolve('apps/api'),
      env: { ...process.env, PORT: '3101', WEB_ORIGIN: 'http://127.0.0.1:3100', DATABASE_PATH: join(dir, 'loop.sqlite'), LOOP_RUNNER: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    api.stdout?.on('data', (chunk) => { output += chunk; });
    api.stderr?.on('data', (chunk) => { output += chunk; });
    await expect.poll(async () => {
      if (api?.exitCode != null) throw new Error(output);
      return request.get(`${apiUrl}/tasks`).then((response) => response.status()).catch(() => 0);
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
    const a = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    contexts.push(a);
    const page = await a.newPage();
    await page.goto('http://127.0.0.1:3100');
    await expect(page.locator('[data-live]')).toHaveAttribute('data-live', '1');

    await page.getByLabel('Author', { exact: true }).fill('Moshe');
    await page.getByLabel('Message', { exact: true }).fill('/task ASK: what colour :: proof');
    const posted = page.waitForResponse((response) => response.url().endsWith('/messages') && response.request().method() === 'POST');
    await page.getByLabel('Message', { exact: true }).press('Enter');
    const cardMessage = await (await posted).json() as Message;
    if (cardMessage.body.kind !== 'task') throw new Error('Expected task card');
    const colourCard = page.locator('.chat-task').filter({ hasText: 'ASK: what colour' });
    await expect(colourCard).toBeVisible();
    await expect(colourCard.locator('.tp-chip')).toHaveText('needs_input', { timeout: 10_000 });
    await expect(colourCard.locator('[data-task-question]')).toHaveText('what colour');
    await expect(colourCard).toHaveClass(/question-card/);
    const rail = page.locator('[data-needs-human]');
    await expect(rail).toHaveAttribute('data-needs-human', '1');
    await expect(rail.locator('.needs-human-pill')).toHaveText('1');
    await expect(rail.locator('.needs-human-pill')).toHaveAttribute('aria-label', '1 task needs a human');
    await expect(page).toHaveTitle(/^\(1\) /);

    await page.getByLabel('Message', { exact: true }).fill('/task ASK: what shape :: proof');
    const secondPost = page.waitForResponse((response) => response.url().endsWith('/messages') && response.request().method() === 'POST');
    await page.getByLabel('Message', { exact: true }).press('Enter');
    await secondPost;
    const shapeCard = page.locator('.chat-task').filter({ hasText: 'ASK: what shape' });
    await expect(shapeCard.locator('.tp-chip')).toHaveText('needs_input', { timeout: 10_000 });
    await expect(shapeCard.locator('[data-task-question]')).toHaveText('what shape');
    await expect(rail).toHaveAttribute('data-needs-human', '2');
    await expect(rail.locator('.needs-human-pill')).toHaveText('2');
    await expect(rail.locator('.needs-human-pill')).toHaveAttribute('aria-label', '2 tasks need a human');
    await expect(page).toHaveTitle(/^\(2\) /);

    await colourCard.getByLabel('Answer').fill('blue');
    const answered = page.waitForResponse((response) => response.url().includes('/answer') && response.request().method() === 'POST');
    await colourCard.getByRole('button', { name: 'Submit answer', exact: true }).click();
    expect((await answered).status()).toBe(200);
    await expect(colourCard.locator('.tp-chip')).toHaveText('done', { timeout: 10_000 });
    await expect(colourCard.locator('[data-task-answer]')).toContainText('blue');
    // The answer is attributed to the composer's author, not a hardcoded name.
    await expect(colourCard.locator('[data-task-answer]')).toContainText('Moshe');
    await expect(colourCard.locator('[data-task-result]')).toHaveText('Answered: blue');
    await expect(shapeCard.locator('.tp-chip')).toHaveText('needs_input');
    await expect(shapeCard).toHaveClass(/question-card/);
    await expect(rail).toHaveAttribute('data-needs-human', '1');
    await expect(rail.locator('.needs-human-pill')).toHaveText('1');
    await expect(page).toHaveTitle(/^\(1\) /);
    // A pinned question is useless if you cannot reach its submit button.
    // toBeInViewport alone passes on a sliver, so assert the whole control.
    await expect(shapeCard.getByLabel('Answer')).toBeInViewport({ ratio: 1 });
    await expect(shapeCard.getByRole('button', { name: 'Submit answer', exact: true })).toBeInViewport({ ratio: 1 });

    await page.screenshot({ path: resolve('docs/screenshots/room-chat.png') });

    await shapeCard.getByLabel('Answer').fill('circle');
    const answeredShape = page.waitForResponse((response) => response.url().includes('/answer') && response.request().method() === 'POST');
    await shapeCard.getByRole('button', { name: 'Submit answer', exact: true }).click();
    expect((await answeredShape).status()).toBe(200);
    await expect(shapeCard.locator('.tp-chip')).toHaveText('done', { timeout: 10_000 });
    await expect(rail).toHaveAttribute('data-needs-human', '0');
    await expect(rail.locator('.needs-human-pill')).toHaveCount(0);
    await expect(page).not.toHaveTitle(/^\(\d+\) /);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await stopApi();
    rmSync(dir, { recursive: true, force: true });
  }
});
