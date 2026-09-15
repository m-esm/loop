import { test, expect, type BrowserContext } from '@playwright/test';
import type { Task } from '@loop/types';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { authedContext, seedSession, withAuth } from './auth';

test('Home lists recent activity per room, newest first, and opens the room', async ({ browser, request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-inbox-activity-'));
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
  async function addTask(title: string, roomId: string): Promise<Task> {
    const response = await request.post(`${apiUrl}/tasks`, {
      data: { title, definitionOfDone: 'The human decision is recorded.', roomId },
    });
    expect(response.status()).toBe(201);
    return await response.json() as Task;
  }
  try {
    await expect.poll(async () => {
      if (api.exitCode !== null) throw new Error(output);
      return request.get(`${apiUrl}/rooms/default`).then((response) => response.status()).catch(() => 0);
    }).toBe(200);
    // Four rooms: "Loop" (the seeded default) touched first, "Parked" next,
    // "Launch" touched last, and "Quiet" never touched at all.
    const launchResponse = await request.post(`${apiUrl}/rooms`, { data: { name: 'Launch' } });
    expect(launchResponse.status()).toBe(201);
    const launch = await launchResponse.json();
    const quietResponse = await request.post(`${apiUrl}/rooms`, { data: { name: 'Quiet' } });
    expect(quietResponse.status()).toBe(201);
    const quiet = await quietResponse.json();
    const parkedRoomResponse = await request.post(`${apiUrl}/rooms`, { data: { name: 'Parked' } });
    expect(parkedRoomResponse.status()).toBe(201);
    const parkedRoom = await parkedRoomResponse.json();

    // Oldest touch: one task in the default room. A new task is queued and the
    // runner is off here, so nothing in this room is running.
    await addTask('Confirm the room copy', 'default');
    await new Promise((done) => setTimeout(done, 1100));
    // A room whose only task is queued. This row pins the bug: queued is an
    // active status but not a running one, so it must not read "1 task running".
    await addTask('Draft the rollout plan', parkedRoom.id);
    await new Promise((done) => setTimeout(done, 1100));
    // Newest touch: two tasks in Launch, one genuinely running and one parked
    // on a human, so the row exercises both counts at once.
    const runningTask = await addTask('Choose the release scope', launch.id);
    expect((await request.patch(`${apiUrl}/tasks/${runningTask.id}/status`, { data: { status: 'running' } })).ok()).toBeTruthy();
    const parked = await addTask('Approve the launch note', launch.id);
    expect((await request.patch(`${apiUrl}/tasks/${parked.id}/status`, { data: { status: 'needs_input' } })).ok()).toBeTruthy();

    context = await authedContext(browser, session.token);
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:3100/');
    await expect(page).toHaveURL('http://127.0.0.1:3100/');
    const activity = page.getByRole('region', { name: 'Room activity', exact: true });
    await expect(activity).toBeVisible();
    await expect(activity.getByRole('heading', { name: 'Room activity', exact: true })).toBeVisible();

    const rows = activity.locator('[data-activity-room]');
    // Exactly the seeded rooms, most recently touched first, untouched last.
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toHaveAttribute('data-activity-room', launch.id);
    await expect(rows.nth(1)).toHaveAttribute('data-activity-room', parkedRoom.id);
    await expect(rows.nth(2)).toHaveAttribute('data-activity-room', 'default');
    await expect(rows.nth(3)).toHaveAttribute('data-activity-room', quiet.id);
    await expect(rows.nth(0)).toContainText('Launch');
    await expect(rows.nth(1)).toContainText('Parked');
    await expect(rows.nth(2)).toContainText('Loop');
    await expect(rows.nth(3)).toContainText('Quiet');

    // The counts the row renders, in the repository's task vocabulary. Only
    // accepted and running are running statuses; queued, needs_input and
    // cancelling are active but not running and must never inflate this count.
    await expect(rows.nth(0)).toContainText('1 task running');
    await expect(rows.nth(0)).toContainText('1 task needs a human');
    // A queued-only room is running nothing and must not claim otherwise.
    await expect(rows.nth(1).locator('.room-activity-summary')).toHaveText('No tasks running');
    await expect(rows.nth(1)).not.toContainText('1 task running');
    await expect(rows.nth(1)).not.toContainText('needs a human');
    await expect(rows.nth(2).locator('.room-activity-summary')).toHaveText('No tasks running');
    await expect(rows.nth(2)).not.toContainText('1 task running');
    await expect(rows.nth(2)).not.toContainText('needs a human');
    await expect(rows.nth(3)).toContainText('No activity yet');
    // A touched room carries a relative time; an untouched one carries none.
    await expect(rows.nth(0).locator('time')).toHaveCount(1);
    await expect(rows.nth(3).locator('time')).toHaveCount(0);
    // The rail is a separate control surface and stays unselected on Home.
    await expect(page.locator('#projects-rail [aria-current]')).toHaveCount(0);

    // Clicking a row opens that room exactly like the rail does.
    await rows.nth(0).click();
    await expect(page).toHaveURL(`http://127.0.0.1:3100/?room=${launch.id}`);
    await expect(page.locator(`#projects-rail [data-room="${launch.id}"]`)).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('region', { name: 'Room activity', exact: true })).toHaveCount(0);

    // Going back restores Home and the activity list.
    await page.goBack();
    await expect(page).toHaveURL('http://127.0.0.1:3100/');
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText('1 task running');
    await expect(rows.nth(0)).toContainText('1 task needs a human');
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
