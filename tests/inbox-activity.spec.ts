import { test, expect, type APIRequestContext, type Browser, type BrowserContext } from '@playwright/test';
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

/**
 * The overflow guard. Nine rooms used to render a shut list whose last row ended
 * at y=1056 in a 900 high viewport, and the row count that replaced it was tuned
 * against one "Needs you" queue depth: the same six rows ended at y=862 under a
 * four deep queue and at y=1121 under an eight deep one. So this runs the same
 * assertions at two queue depths and two viewport heights, and a constant cannot
 * satisfy all four.
 *
 * The instrument is content extent, `y + height` read from `boundingBox()`,
 * never `main.scrollHeight`: the shell sets `main { height: 100vh }`, so
 * scrollHeight tracks the scroll box rather than where content ends and moves
 * even when nothing overflows. While the list is shut it is a scrolling box, so
 * the element that has to be on screen is the list's own box rather than its
 * last row, which sits inside that box and below its clip. The toggle is checked
 * with it: a reachable list behind an unreachable control is still broken.
 */
// One body, two queue depths. The titles below stay quoted literals because the
// evidence generator reads them with a regex that only matches a quoted string,
// so a template literal in a loop would drop this guard out of EVIDENCE.md.
async function keepsActivityListInsideViewport(
  seed: { parked: number; parkPerRoom: number },
  browser: Browser,
  raw: APIRequestContext,
) {
  {
    const dir = mkdtempSync(join(tmpdir(), 'loop-activity-overflow-'));
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
    async function addRoom(name: string): Promise<{ id: string; name: string }> {
      const response = await request.post(`${apiUrl}/rooms`, { data: { name } });
      expect(response.status()).toBe(201);
      return await response.json() as { id: string; name: string };
    }
    async function park(task: Task) {
      expect((await request.patch(`${apiUrl}/tasks/${task.id}/status`, { data: { status: 'needs_input' } })).ok()).toBeTruthy();
    }
    // Timestamps are millisecond ISO strings, so a short pause is enough to make
    // the touch order, and therefore the sort, deterministic.
    const tick = () => new Promise((done) => setTimeout(done, 25));
    try {
      await expect.poll(async () => {
        if (api.exitCode !== null) throw new Error(output);
        return request.get(`${apiUrl}/rooms/default`).then((response) => response.status()).catch(() => 0);
      }).toBe(200);

      // Nine rooms at both depths: the seeded default plus eight, touched oldest
      // first so the rendered order is known. "Quiet" is never touched and sorts
      // last. Only the number of parked tasks per room changes between the two
      // runs, so the queue above grows while the room order stays identical and
      // the same order assertions hold at both depths.
      const made: Record<string, string> = { Loop: 'default' };
      for (const name of ['Launch', 'Billing', 'Research', 'Design', 'Infra', 'Support', 'Docs', 'Quiet']) {
        made[name] = (await addRoom(name)).id;
      }
      await addTask('Confirm the room copy', 'default');
      await tick();
      for (const name of ['Docs', 'Support', 'Infra']) {
        await addTask(`Work in ${name}`, made[name]);
        await tick();
      }
      for (const name of ['Design', 'Research', 'Billing']) {
        for (let n = 0; n < seed.parkPerRoom; n += 1) {
          await park(await addTask(`Approve the ${name} note ${n + 1}`, made[name]));
          await tick();
        }
      }
      // Launch is touched last and holds one genuinely running task, which pins
      // the running count: queued, needs_input and cancelling are active but not
      // running and must never inflate it.
      const running = await addTask('Choose the release scope', made.Launch);
      expect((await request.patch(`${apiUrl}/tasks/${running.id}/status`, { data: { status: 'running' } })).ok()).toBeTruthy();
      for (let n = 0; n < seed.parkPerRoom; n += 1) {
        await park(await addTask(`Approve the launch note ${n + 1}`, made.Launch));
        await tick();
      }

      context = await authedContext(browser, session.token);
      const page = await context.newPage();
      const activity = page.getByRole('region', { name: 'Room activity', exact: true });
      const rows = activity.locator('[data-activity-room]');
      const list = page.locator('#room-activity-list');
      const toggle = activity.getByRole('button', { name: /rooms?$/ });
      const order = ['Launch', 'Billing', 'Research', 'Design', 'Infra', 'Support', 'Docs', 'Loop', 'Quiet'];

      // The extent instrument: where a rendered element actually ends on screen.
      async function extent(target: typeof list): Promise<number> {
        const box = await target.boundingBox();
        if (!box) throw new Error('the measured element has no box');
        return box.y + box.height;
      }
      // main is the scroll box on Home. Measure from the top of it every time, so
      // an extent reads where the layout puts content rather than where a click
      // happened to scroll it.
      const atTop = async () => {
        await page.evaluate(() => { const box = document.querySelector('main'); if (box) box.scrollTop = 0; });
      };

      for (const viewport of [{ width: 1440, height: 900 }, { width: 900, height: 800 }]) {
        await page.setViewportSize(viewport);
        await page.goto('http://127.0.0.1:3100/');
        await expect(activity).toBeVisible();
        expect(page.viewportSize()?.height).toBe(viewport.height);
        await expect(page.getByRole('region', { name: 'Inbox', exact: true }).locator('[data-task-id]')).toHaveCount(seed.parked);
        await atTop();

        // The render barrier, true whether the list bounds its own box or renders
        // a fixed number of rows, so reverting the fix fails on an extent below
        // rather than timing out here. This seed is the overflowing one, so the
        // gated control has to be here: a clipped list with no way to open it is
        // the mirror of the bug the gate exists to fix.
        await expect(toggle).toBeVisible();
        await expect(toggle).toHaveCount(1);

        // The assertions the fix exists to satisfy, ahead of every count and
        // label: where the shut list ends, and where its only escape hatch ends.
        expect(await extent(list)).toBeLessThanOrEqual(viewport.height);
        expect(await extent(toggle)).toBeLessThanOrEqual(viewport.height);

        // Shut, the list is a scrolling box rather than a truncated one, so every
        // room is present and the tail is reachable by scrolling it.
        await expect(rows).toHaveCount(9);
        expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

        // A shut list names what it holds, and the count reads straight off the
        // room list rather than off a measurement.
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await expect(toggle).toHaveText('Show all 9 rooms');
        await expect(toggle).toHaveAttribute('aria-controls', 'room-activity-list');
        await expect(list).toHaveCount(1);

        // Most recently touched first, untouched room last, at both depths.
        for (const [index, name] of order.entries()) {
          await expect(rows.nth(index)).toHaveAttribute('data-activity-room', made[name]);
        }
        await expect(rows.nth(0)).toContainText('Launch');
        await expect(rows.nth(0)).toContainText('1 task running');
        await expect(rows.nth(8)).toContainText('No activity yet');

        // Opening it is the opt in: natural height, and the tail is allowed to
        // run past the fold because the human asked for it.
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        await expect(toggle).toHaveText('Show fewer rooms');
        await expect(rows).toHaveCount(9);
        // The trap, pinned. Open, the list runs to its natural height and stops
        // scrolling, so the very condition that revealed this control now reads
        // false. A gate on the live reading would delete the human's only way
        // back while they are standing in the expanded state, so the control has
        // to survive its own gate going false.
        expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(false);
        await expect(toggle).toHaveCount(1);
        await expect(toggle).toBeVisible();
        await atTop();
        expect(await extent(rows.last())).toBeGreaterThan(viewport.height);
        for (const [index, name] of order.entries()) {
          await expect(rows.nth(index)).toHaveAttribute('data-activity-room', made[name]);
        }

        // Shutting it again restores the bounded box at the same viewport, which
        // is only reachable because the control stayed rendered while open.
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await expect(toggle).toHaveText('Show all 9 rooms');
        await expect(toggle).toHaveCount(1);
        expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
        await atTop();
        expect(await extent(list)).toBeLessThanOrEqual(viewport.height);
        expect(await extent(toggle)).toBeLessThanOrEqual(viewport.height);
      }
    } finally {
      await context?.close();
      if (api.exitCode === null) {
        const exited = once(api, 'exit');
        api.kill('SIGKILL');
        await exited;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

test('Home keeps the room activity list and its toggle inside the viewport with a four deep queue', async ({ browser, request }) => {
  await keepsActivityListInsideViewport({ parked: 4, parkPerRoom: 1 }, browser, request);
});

test('Home keeps the room activity list and its toggle inside the viewport with an eight deep queue', async ({ browser, request }) => {
  await keepsActivityListInsideViewport({ parked: 8, parkPerRoom: 2 }, browser, request);
});

/**
 * The other half of the gate, and the review that produced it. A control that
 * always rendered read "Show all 2 rooms" over a list already showing both of
 * them: the shut list measured scrollHeight 533 against clientHeight 533, so
 * nothing was clipped and clicking revealed nothing, 2 rows before and 2 after.
 * Its only effect was shrinking the section from 533.2px to 129.8px, because
 * open drops the section to its natural height. So this pins the empty case the
 * reviewer measured: when the shut list fits, no toggle exists to lie about it.
 */
test('Home renders no room activity toggle when the shut list already fits', async ({ browser, request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-activity-fits-'));
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

    // Two rooms and an empty queue, exactly the reviewer's seed. The one task is
    // left running rather than parked on a human, so the "Needs you" queue above
    // stays empty and the section gets the whole column to grow into.
    const launchResponse = await request.post(`${apiUrl}/rooms`, { data: { name: 'Launch' } });
    expect(launchResponse.status()).toBe(201);
    const launch = await launchResponse.json() as { id: string };
    const response = await request.post(`${apiUrl}/tasks`, {
      data: { title: 'Choose the release scope', definitionOfDone: 'The human decision is recorded.', roomId: launch.id },
    });
    expect(response.status()).toBe(201);
    const running = await response.json() as Task;
    expect((await request.patch(`${apiUrl}/tasks/${running.id}/status`, { data: { status: 'running' } })).ok()).toBeTruthy();

    context = await authedContext(browser, session.token);
    const page = await context.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('http://127.0.0.1:3100/');
    const activity = page.getByRole('region', { name: 'Room activity', exact: true });
    const rows = activity.locator('[data-activity-room]');
    const list = page.locator('#room-activity-list');
    const toggle = activity.getByRole('button', { name: /rooms?$/ });
    await expect(activity).toBeVisible();
    expect(page.viewportSize()?.height).toBe(900);
    // The queue is empty, so nothing above pushes this section down.
    await expect(page.getByRole('region', { name: 'Inbox', exact: true }).locator('[data-task-id]')).toHaveCount(0);

    // Both rooms render and both are on screen, so there is nothing to reveal.
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Launch');
    await expect(rows.nth(1)).toContainText('Loop');
    await expect(rows.nth(0)).toBeVisible();
    await expect(rows.nth(1)).toBeVisible();

    // The measurement the gate reads, at the state the gate is read in.
    const fit = await list.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
    expect(fit.scrollHeight).toBe(fit.clientHeight);

    // So no control, rather than one promising rooms it is already showing.
    await expect(toggle).toHaveCount(0);
    await expect(activity.locator('.room-activity-toggle')).toHaveCount(0);
    await expect(activity.locator('[aria-controls="room-activity-list"]')).toHaveCount(0);

    // And with no control there is no click that can shrink the box: the section
    // holds the height it laid out with rather than collapsing to its rows.
    const before = await list.boundingBox();
    if (!before) throw new Error('the measured element has no box');
    await page.waitForTimeout(250);
    const after = await list.boundingBox();
    if (!after) throw new Error('the measured element has no box');
    expect(after.height).toBe(before.height);
    expect(after.y + after.height).toBeLessThanOrEqual(900);
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
