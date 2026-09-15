import { test, expect, type BrowserContext } from '@playwright/test';
import type { Task } from '@loop/types';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { authedContext, seedSession, withAuth } from './auth';

test('Inbox stays home, orders cross-room parked work, opens Task detail, and updates to empty', async ({ browser, request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-inbox-browser-'));
  const session = seedSession(join(dir, 'loop.sqlite'));
  const request = withAuth(raw, session.token);
  const apiUrl = 'http://127.0.0.1:3101/api';
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
    const roomResponse = await request.post(`${apiUrl}/rooms`, { data: { name: 'Launch' } });
    expect(roomResponse.status()).toBe(201);
    const room = await roomResponse.json();
    const tasks: Task[] = [];
    for (const [title, roomId] of [['Choose the release scope', room.id], ['Confirm the room copy', 'default']]) {
      const response = await request.post(`${apiUrl}/tasks`, {
        data: { title, definitionOfDone: 'The human decision is recorded.', roomId },
      });
      expect(response.status()).toBe(201);
      const task = await response.json() as Task;
      expect((await request.patch(`${apiUrl}/tasks/${task.id}/status`, { data: { status: 'needs_input' } })).ok()).toBeTruthy();
      tasks.push(task);
    }
    context = await authedContext(browser, session.token);
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:3100/');
    const inbox = page.getByRole('region', { name: 'Inbox', exact: true });
    const rows = inbox.locator('[data-task-id]');
    await expect(page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible();
    await expect(page.locator('[data-live]')).toHaveAttribute('data-live', '1');
    await expect(page).toHaveURL('http://127.0.0.1:3100/');
    await expect(page.locator('#projects-rail [aria-current]')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Chat', exact: true })).toHaveCount(0);
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText(tasks[0].title);
    await expect(rows.nth(1)).toContainText(tasks[1].title);
    await expect(rows.nth(0)).toContainText('Launch');
    await expect(page.getByRole('complementary', { name: 'Projects', exact: true })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Context panel', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Project name')).toHaveCount(0);
    await page.screenshot({ path: resolve('docs/screenshots/inbox.png') });
    await rows.first().click();
    await expect(page).toHaveURL(`http://127.0.0.1:3100/?room=${room.id}`);
    await expect(page.getByRole('region', { name: 'Task detail' })).toContainText(tasks[0].definitionOfDone);
    await expect(page.locator('.inspector-title')).toHaveText(tasks[0].title);
    await expect(page.locator(`#projects-rail [data-room="${room.id}"]`)).toHaveAttribute('aria-current', 'page');
    await page.goBack();
    await expect(rows).toHaveCount(2);
    await expect(page).toHaveURL('http://127.0.0.1:3100/');
    await expect(page.locator('#projects-rail [aria-current]')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Task detail' })).toHaveCount(0);
    await page.reload();
    await expect(rows).toHaveCount(2);
    await expect(page).toHaveURL('http://127.0.0.1:3100/');
    for (const task of tasks) {
      expect((await request.patch(`${apiUrl}/tasks/${task.id}/status`, { data: { status: 'queued' } })).ok()).toBeTruthy();
    }
    await expect(inbox.getByText('Nothing needs you', { exact: true })).toBeVisible();
    // A cleared queue is not a first run: no onboarding pitch, no create CTA.
    await expect(inbox.getByRole('button', { name: 'Create a project' })).toHaveCount(0);
    expect((await request.patch(`${apiUrl}/tasks/${tasks[0].id}/status`, { data: { status: 'done' } })).ok()).toBeTruthy();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Result waiting for review');
    expect((await request.post(`${apiUrl}/tasks/${tasks[0].id}/review`, { data: { verdict: 'accepted' } })).ok()).toBeTruthy();
    await expect(inbox.getByText('Nothing needs you', { exact: true })).toBeVisible();
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

test('the first-run Inbox explains itself and routes to the one create flow', async ({ browser, request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-inbox-firstrun-'));
  const session = seedSession(join(dir, 'loop.sqlite'));
  const request = withAuth(raw, session.token);
  const apiUrl = 'http://127.0.0.1:3101/api';
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
    context = await authedContext(browser, session.token);
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:3100/');
    const inbox = page.getByRole('region', { name: 'Inbox', exact: true });
    // No tasks have ever existed, so this is onboarding, not a cleared queue.
    await expect(inbox.getByText('Nothing needs you yet', { exact: true })).toBeVisible();
    await expect(inbox).toContainText('waits for you here');
    // The CTA must reach the rail's create form rather than open a second one.
    const create = inbox.getByRole('button', { name: 'Create a project' });
    await expect(create).toBeVisible();
    await expect(page.getByLabel('Project name')).toHaveCount(0);
    await create.click();
    await expect(page.getByLabel('Project name')).toBeFocused();
    await expect(page.getByRole('form', { name: 'New project' })).toHaveCount(1);
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

test('Home badges every waiting room in the rail, not just the selected one', async ({ browser, request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-rail-badges-'));
  const session = seedSession(join(dir, 'loop.sqlite'));
  const request = withAuth(raw, session.token);
  const apiUrl = 'http://127.0.0.1:3101/api';
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
    // Two rooms besides the seeded default, each with parked work, plus one
    // that stays quiet so the no-badge case is covered too.
    const made: string[] = [];
    for (const name of ['Launch', 'Mechlib']) {
      const response = await request.post(`${apiUrl}/rooms`, { data: { name } });
      expect(response.status()).toBe(201);
      made.push((await response.json()).id as string);
    }
    const quiet = await request.post(`${apiUrl}/rooms`, { data: { name: 'Quiet' } });
    expect(quiet.status()).toBe(201);
    const quietId = (await quiet.json()).id as string;
    for (const roomId of [made[0], made[0], made[1], 'default']) {
      const created = await request.post(`${apiUrl}/tasks`, {
        data: { title: `Decide ${roomId}`, definitionOfDone: 'A human decides.', roomId },
      });
      expect(created.status()).toBe(201);
      const task = await created.json() as Task;
      expect((await request.patch(`${apiUrl}/tasks/${task.id}/status`, { data: { status: 'needs_input' } })).ok()).toBeTruthy();
    }
    context = await authedContext(browser, session.token);
    const page = await context.newPage();
    // Home: nothing is selected, which is exactly when the old badge vanished.
    await page.goto('http://127.0.0.1:3100/');
    await expect(page.locator('#projects-rail [aria-current]')).toHaveCount(0);
    await expect(page.locator('#projects-rail .needs-human-pill')).toHaveCount(3);
    await expect(page.locator(`[data-room-badge="${made[0]}"]`)).toHaveText('2');
    await expect(page.locator(`[data-room-badge="${made[1]}"]`)).toHaveText('1');
    await expect(page.locator('[data-room-badge="default"]')).toHaveText('1');
    await expect(page.locator(`[data-room-badge="${made[0]}"]`))
      .toHaveAttribute('aria-label', 'Launch: 2 tasks need a human');
    // A room with nothing waiting carries no badge. 'Quiet' exists before the
    // page loads, because the rail only refetches rooms on navigation.
    await expect(page.locator(`[data-room="${quietId}"]`)).toBeVisible();
    await expect(page.locator(`[data-room-badge="${quietId}"]`)).toHaveCount(0);
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

test('the Inbox tells a failed result apart from one worth reviewing', async ({ browser, request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-inbox-failed-'));
  const session = seedSession(join(dir, 'loop.sqlite'));
  const request = withAuth(raw, session.token);
  const apiUrl = 'http://127.0.0.1:3101/api';
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
    const ids: Record<string, string> = {};
    for (const [key, status] of [['bad', 'failed'], ['good', 'done']] as const) {
      const created = await request.post(`${apiUrl}/tasks`, {
        data: { title: `${key} task`, definitionOfDone: 'Terminal.', roomId: 'default' },
      });
      expect(created.status()).toBe(201);
      const task = await created.json() as Task;
      ids[key] = task.id;
      expect((await request.patch(`${apiUrl}/tasks/${task.id}/status`, { data: { status } })).ok()).toBeTruthy();
    }
    context = await authedContext(browser, session.token);
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:3100/');
    const failedRow = page.locator(`[data-task-id="${ids.bad}"]`);
    const doneRow = page.locator(`[data-task-id="${ids.good}"]`);
    await expect(failedRow).toBeVisible();
    await expect(doneRow).toBeVisible();
    // The bug: both rendered the same string, so a failure read as a success.
    await expect(failedRow).toContainText('Failed. Needs a decision');
    await expect(doneRow).toContainText('Result waiting for review');
    await expect(failedRow.locator('[data-failed]')).toHaveCount(1);
    await expect(doneRow.locator('[data-failed]')).toHaveCount(0);
    // And they must not look alike either.
    const colourOf = (row: typeof failedRow) => row.locator('.inbox-reason')
      .evaluate((node) => getComputedStyle(node).color);
    expect(await colourOf(failedRow)).not.toBe(await colourOf(doneRow));
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
