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
 *
 * Bounding one list was never the whole contract. The queue above was still
 * unbounded, so at sixteen parked it carried this whole section off the page on
 * every viewport at once (list y=1254.9 with height 0, toggle bottom 1286.9, at
 * 1440x900, 900x800 and 1440x700 alike) and no assertion here caught it, because
 * four and eight parked both still fit. So the sixteen deep case runs the same
 * body at the third viewport too, and adds the two things bounding a second box
 * can break: a section floored at nothing, and parked work no longer reachable.
 */
// One body, three queue depths. The titles below stay quoted literals because
// the evidence generator reads them with a regex that only matches a quoted
// string, so a template literal in a loop would drop this guard out of
// EVIDENCE.md.
async function keepsActivityListInsideViewport(
  seed: {
    parked: number;
    parkPerRoom: number;
    viewports?: { width: number; height: number }[];
    // True at the depth where the queue is deeper than the box it is given, so
    // the clip and the reachability of what it clips are both assertable.
    queueClips?: boolean;
  },
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
      const heading = activity.getByRole('heading', { name: 'Room activity', exact: true });
      const inbox = page.getByRole('region', { name: 'Inbox', exact: true });
      const queue = inbox.locator('.inbox-list');
      const queueRows = inbox.locator('[data-task-id]');
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

      for (const viewport of seed.viewports ?? [{ width: 1440, height: 900 }, { width: 900, height: 800 }]) {
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
        // The heading goes with them, because a section whose title is off the
        // fold is not on screen in any sense a human would accept.
        expect(await extent(heading)).toBeLessThanOrEqual(viewport.height);
        expect(await extent(list)).toBeLessThanOrEqual(viewport.height);
        expect(await extent(toggle)).toBeLessThanOrEqual(viewport.height);

        // Starvation, the other half of bounding a box: a section squeezed to
        // zero is bounded and useless, and an extent assertion alone is happy
        // with it. At eight parked on 900x800 this list resolved to 8.19px,
        // present and scrollable and too short for one row. The floor is not a
        // constant this test carries: it reads the pitch off a row that is
        // actually rendered, which is the same box the --inbox-row calc in
        // globals.css is written from, so restyling the row moves the rule and
        // this assertion together instead of leaving a number behind.
        const rowPitch = await rows.first().evaluate((el) =>
          el.getBoundingClientRect().height + parseFloat(getComputedStyle(el).marginBottom));
        expect(rowPitch).toBeGreaterThan(0);
        const listBox = await list.boundingBox();
        if (!listBox) throw new Error('the measured element has no box');
        expect(listBox.height).toBeGreaterThanOrEqual(rowPitch);

        // Both sections are bounded now, so between them they stop growing the
        // page instead of handing the overflow down to it.
        expect(await page.evaluate(() => {
          const box = document.querySelector('main') as HTMLElement;
          return box.scrollHeight - box.clientHeight;
        })).toBeLessThanOrEqual(0);

        // Shut, the list is a scrolling box rather than a truncated one, so every
        // room is present and the tail is reachable by scrolling it.
        await expect(rows).toHaveCount(9);
        expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

        if (seed.queueClips) {
          // The queue is bounded the same way, so at this depth it clips, and a
          // clip is only acceptable if it is a scroll. Proving the scroll is
          // proving no parked work was deleted from the page to make room.
          const clip = await queue.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
          expect(clip.scrollHeight).toBeGreaterThan(clip.clientHeight);
          expect(await extent(queue)).toBeLessThanOrEqual(viewport.height);

          // Reachability, task by task rather than by counting: every seeded row
          // is scrolled to inside the queue's own box and has to land inside it,
          // which is also inside the viewport because the box is.
          await expect(queueRows).toHaveCount(seed.parked);
          const queueBox = await queue.boundingBox();
          if (!queueBox) throw new Error('the measured element has no box');
          for (let n = 0; n < seed.parked; n += 1) {
            const row = queueRows.nth(n);
            await row.scrollIntoViewIfNeeded();
            const rowBox = await row.boundingBox();
            if (!rowBox) throw new Error('the measured element has no box');
            expect(rowBox.y).toBeGreaterThanOrEqual(queueBox.y - 1);
            expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(queueBox.y + queueBox.height + 1);
            expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(viewport.height);
          }
          // Scrolling the queue is what moved, not the page under it.
          await queue.evaluate((el) => { el.scrollTop = 0; });
          await atTop();
        }

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

test('Home keeps the room activity section on screen and scrolls a sixteen deep queue inside its own box', async ({ browser, request }) => {
  await keepsActivityListInsideViewport({
    parked: 16,
    parkPerRoom: 4,
    // The reviewer's depth, at all three of the viewports the reviewer measured
    // it on. 1440x700 is the one four and eight parked never needed: it is short
    // enough that both sections are bounded at once, so it is where a floor that
    // only works on a tall viewport comes apart.
    viewports: [{ width: 1440, height: 900 }, { width: 900, height: 800 }, { width: 1440, height: 700 }],
    queueClips: true,
  }, browser, request);
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

/**
 * The derivation guard, and the defect it closes.
 *
 * The floor under both Home lists used to be a calc in globals.css that
 * restated the rules on .inbox-row, .inbox-title and .inbox-sub term by term.
 * It restated them, it did not read them, so the row's styling lived in two
 * places and drifted apart in silence. The reproduction the reviewer ran is the
 * body below: a direct `.inbox-title { font-size: 22px }` override moves the
 * rendered pitch to about 75.69px while the transcribed calc stays at 64.89px,
 * and both sections then floor roughly 11px below one row at 700, 560 and 500
 * while every other spec in this file stays green, because the seeded depths
 * leave enough slack at those heights to hide it.
 *
 * A custom property shared between the row rule and the calc would not catch
 * this. The override is direct, it never touches a variable, so the shared
 * version passes a tidy test and fails this one. What this asserts is that the
 * floor MOVED: the list is at least the pitch of a row measured under the
 * override, read off the page rather than written down here, so the only
 * implementation that satisfies it is one that reads a rendered row.
 *
 * The queue depth is part of the instrument, not a detail. min-height is a
 * floor, so a stale floor is invisible until the section is actually squeezed
 * down onto it, and how hard it is squeezed is set by the queue above. At
 * sixteen parked the activity list is handed 131.22px at 700 and 78.66px at
 * 560, both already above a row, and only the 500 case reaches the floor and
 * exposes it. At thirty two parked the queue is deep enough that the section
 * sits on its floor at all three heights, which is where the transcribed calc
 * pins the list to 64.89px against a row that needs 75.69px and the same case
 * measures 75.69px once the floor is derived. So the depth is chosen to make
 * the floor binding at every height this asserts, rather than at one of them.
 *
 * It also has to prove the measurement settles. This puts a second
 * ResizeObserver on Home next to the activity overflow gate above, and one
 * observer's write is the other's read: the pitch observer writes
 * --inbox-row-measured, that moves the min-height of both lists, and resizing
 * the activity list is exactly what the overflow observer watches for. So the
 * console is captured and asserted free of "ResizeObserver loop completed with
 * undelivered notifications", which is what Chromium emits when two observers
 * thrash, and the published value is read twice with a wait between, after a
 * viewport resize and again after a queue depth change arrives over SSE.
 */
test('Home floors both lists on the measured row pitch when a direct style override restyles the row', async ({ browser, request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-row-floor-derived-'));
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
  const tick = () => new Promise((done) => setTimeout(done, 25));
  // The number the old calc laid out at, kept here only to prove this case is
  // genuinely the drift case. The assertions below never floor against it; they
  // floor against a pitch read off the page.
  const transcribedPitch = 64.89;
  try {
    await expect.poll(async () => {
      if (api.exitCode !== null) throw new Error(output);
      return request.get(`${apiUrl}/rooms/default`).then((response) => response.status()).catch(() => 0);
    }).toBe(200);

    // Nine rooms, thirty two parked: the same shape the overflow cases above
    // use, at the depth that presses both sections onto their floors at every
    // height below, so the shut activity list clips and its toggle exists to be
    // measured.
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
    for (const name of ['Design', 'Research', 'Billing', 'Launch']) {
      for (let n = 0; n < 8; n += 1) {
        await park(await addTask(`Approve the ${name} note ${n + 1}`, made[name]));
        await tick();
      }
    }

    context = await authedContext(browser, session.token);
    const page = await context.newPage();

    // Cheap instrumentation, test side only: every ResizeObserver the page
    // constructs reports which element it delivered an entry for, so one resize
    // can be attributed to the pitch observer (.inbox-row) and the activity
    // overflow observer (.inbox-list) separately.
    await page.addInitScript(() => {
      const native = window.ResizeObserver;
      const fires: string[] = [];
      (window as unknown as { __roFires: string[] }).__roFires = fires;
      window.ResizeObserver = class extends native {
        constructor(callback: ResizeObserverCallback) {
          super((entries, observer) => {
            for (const entry of entries) fires.push(entry.target.className);
            callback(entries, observer);
          });
        }
      };
    });
    // Chromium reports observer thrash on the console rather than by throwing,
    // so the console is the instrument. Page errors are collected with it.
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => { consoleErrors.push(error.message); });

    const activity = page.getByRole('region', { name: 'Room activity', exact: true });
    const activityRows = activity.locator('[data-activity-room]');
    const list = page.locator('#room-activity-list');
    const toggle = activity.getByRole('button', { name: /rooms?$/ });
    const heading = activity.getByRole('heading', { name: 'Room activity', exact: true });
    const inbox = page.getByRole('region', { name: 'Inbox', exact: true });
    const queue = inbox.locator('.inbox-list');
    const queueRows = inbox.locator('[data-task-id]');

    async function extent(target: typeof list): Promise<number> {
      const box = await target.boundingBox();
      if (!box) throw new Error('the measured element has no box');
      return box.y + box.height;
    }
    // The pitch a rendered row actually repeats at: its border box plus the
    // margin that separates it from the next row, which is how every floor
    // assertion in this file has always measured it.
    const renderedPitch = () => activityRows.first().evaluate((el) =>
      el.getBoundingClientRect().height + parseFloat(getComputedStyle(el).marginBottom));
    // What the page published, read back off the container that carries it.
    const publishedPitch = () => page.evaluate(() => {
      const home = document.querySelector('main');
      return home ? getComputedStyle(home).getPropertyValue('--inbox-row-measured').trim() : '';
    });
    const resetFires = () => page.evaluate(() => { (window as unknown as { __roFires: string[] }).__roFires.length = 0; });
    const readFires = () => page.evaluate(() => (window as unknown as { __roFires: string[] }).__roFires.slice());
    const atTop = async () => {
      await page.evaluate(() => { const box = document.querySelector('main'); if (box) box.scrollTop = 0; });
    };

    await page.setViewportSize({ width: 1440, height: 700 });
    await page.goto('http://127.0.0.1:3100/');
    await expect(activity).toBeVisible();
    await expect(activityRows).toHaveCount(9);
    await expect(queueRows).toHaveCount(32);

    // The reviewer's override: a direct rule on the title, touching no variable
    // any calc could have been sharing. This is the whole point of the case.
    await page.addStyleTag({ content: '.inbox-title { font-size: 22px }' });

    for (const height of [700, 560, 500]) {
      await page.setViewportSize({ width: 1440, height });
      expect(page.viewportSize()?.height).toBe(height);
      await expect(activity).toBeVisible();
      await atTop();

      const pitch = await renderedPitch();
      // The override landed and moved the row past what the transcribed calc
      // described. Without this the case could pass while proving nothing.
      expect(pitch).toBeGreaterThan(transcribedPitch);

      // The floor moved with it. On the transcribed calc the list floors at
      // 64.89px while a row needs about 75.69px, so this is the assertion that
      // separates a derived floor from a restated one.
      await expect.poll(async () => {
        const box = await list.boundingBox();
        return box ? box.height : 0;
      }).toBeGreaterThanOrEqual(pitch);
      const queueBox = await queue.boundingBox();
      if (!queueBox) throw new Error('the measured element has no box');
      expect(queueBox.height).toBeGreaterThanOrEqual(pitch);

      // Floored is only half of it. The section still has to be on screen, so
      // the heading, the list and the only way out of the clipped list are all
      // inside the viewport at the same time.
      expect(await extent(heading)).toBeLessThanOrEqual(height);
      expect(await extent(list)).toBeLessThanOrEqual(height);
      await expect(toggle).toBeVisible();
      expect(await extent(toggle)).toBeLessThanOrEqual(height);

      // The published property tracks the rendered row rather than lagging it.
      const published = await publishedPitch();
      expect(parseFloat(published)).toBeCloseTo(pitch, 1);

      // Settled, not merely correct once. Two observers share this page and a
      // write by either is a read for the other, so the value has to be the
      // same after the page has had time to thrash if it were going to.
      await page.waitForTimeout(400);
      expect(await publishedPitch()).toBe(published);
      expect(await renderedPitch()).toBeCloseTo(pitch, 1);
    }

    // One resize, attributed per observer. This is the loop risk stated as a
    // number rather than a hope, and the number is the reason the pair cannot
    // fight: a viewport height change resizes the lists, not the row inside
    // them, so the pitch observer is not even woken. It observes a row, whose
    // box is a function of the row's own content and width, and the width here
    // is fixed at 1440. The overflow observer answers the resize alone and its
    // answer writes no custom property, so there is nothing to bounce back.
    await resetFires();
    await page.setViewportSize({ width: 1440, height: 640 });
    await expect(activity).toBeVisible();
    await page.waitForTimeout(400);
    const fires = await readFires();
    const pitchFires = fires.filter((name) => name.includes('inbox-row')).length;
    const overflowFires = fires.filter((name) => name.includes('inbox-list')).length;
    expect(pitchFires).toBe(0);
    // The overflow gate is bounded too. At this depth both sections are already
    // sitting on their floors, so a height change moves the queue between them
    // and leaves the activity list at exactly one row: it is allowed to answer
    // the resize and allowed to stay silent, but a thrashing pair runs into the
    // hundreds here, and that is what this rules out.
    expect(overflowFires).toBeLessThanOrEqual(8);

    // A queue depth change over SSE, which is the case the activity overflow
    // gate already handles and the one most likely to make the two observers
    // argue: the queue grows, both sections are handed different amounts of
    // room, and the row itself never changes size.
    const settled = await publishedPitch();
    await park(await addTask('Approve the late arrival', made.Launch));
    await expect(queueRows).toHaveCount(33);
    await page.waitForTimeout(400);
    expect(await publishedPitch()).toBe(settled);
    await page.waitForTimeout(300);
    expect(await publishedPitch()).toBe(settled);

    // The floor still holds at the shortest viewport after all of that.
    await page.setViewportSize({ width: 1440, height: 500 });
    await atTop();
    const finalPitch = await renderedPitch();
    await expect.poll(async () => {
      const box = await list.boundingBox();
      return box ? box.height : 0;
    }).toBeGreaterThanOrEqual(finalPitch);
    expect(await extent(toggle)).toBeLessThanOrEqual(500);

    // The other direction, and the one that does wake the pitch observer:
    // restyle the row itself while the page is up. This is the live drift the
    // derivation exists to absorb, and it is where a loop would start if one
    // were going to, because now the write really does change the min-heights
    // that size the list the other observer is watching.
    await resetFires();
    await page.addStyleTag({ content: '.inbox-title { font-size: 26px }' });
    await expect.poll(async () => parseFloat(await publishedPitch())).toBeGreaterThan(finalPitch);
    await page.waitForTimeout(400);
    const restyleFires = await readFires();
    const restylePitchFires = restyleFires.filter((name) => name.includes('inbox-row')).length;
    const restyleOverflowFires = restyleFires.filter((name) => name.includes('inbox-list')).length;
    expect(restylePitchFires).toBeGreaterThan(0);
    expect(restylePitchFires).toBeLessThanOrEqual(8);
    expect(restyleOverflowFires).toBeLessThanOrEqual(8);
    // It tracked the new row and then stopped moving, which is the epsilon
    // guard in apps/web/lib/rowPitch.ts doing the work it is there for.
    const restyled = await publishedPitch();
    expect(parseFloat(restyled)).toBeCloseTo(await renderedPitch(), 1);
    await page.waitForTimeout(400);
    expect(await publishedPitch()).toBe(restyled);

    // Chromium's thrash report, asserted absent. This is the second observer's
    // licence to exist.
    const loops = consoleErrors.filter((text) => /ResizeObserver loop/i.test(text));
    expect(loops, `console reported observer thrash: ${loops.join(' | ')}`).toHaveLength(0);
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
 * The effect guard, under live perturbation, and the question that produced
 * this case.
 *
 * The render used to gate this control on `open || overflows`. The `open ||`
 * half was there so the control could not vanish while the list was expanded
 * and strand the human with no way to collapse it, and the review record says
 * deleting it left every spec green. It did, and the reason is that it could
 * never fire: the control is only there to click while `overflows` is true, and
 * the effect above declines to re-measure while open, so `open` true with
 * `overflows` false is not a state this component has. Thirty odd perturbations
 * of an open list were driven through the real app with the disjunct deleted
 * and the control was present on every frame of all of them. So the disjunct
 * went, and what is left holding the escape hatch open is the `if (open) return`
 * in the effect, alone.
 *
 * Deleting that early return turns three of the cases above red on
 * `toHaveAttribute('aria-expanded', 'true')` with `element(s) not found`. It
 * only does so with the disjunct gone: while `open ||` was there it masked the
 * guard, and the same deletion left all six of them green.
 *
 * That is what this pins, and it pins it where the existing open and close case
 * does not look: after the list is already open. The cases above open the list,
 * assert the control survived, and close it again without touching anything in
 * between. Everything that can move under an open list moves here instead, and
 * the instrument is a per frame reading rather than a poll, so a control that
 * unmounts for one frame and comes back is caught as well as one that leaves
 * for good. The log is cleared once the list is open, so any entry at all at the
 * end is the control changing presence while the human was inside it.
 */
test('Home keeps the room activity toggle through resize, queue depth and row restyle while the list is open', async ({ browser, request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-activity-open-'));
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
  const tick = () => new Promise((done) => setTimeout(done, 25));
  try {
    await expect.poll(async () => {
      if (api.exitCode !== null) throw new Error(output);
      return request.get(`${apiUrl}/rooms/default`).then((response) => response.status()).catch(() => 0);
    }).toBe(200);

    // The same nine room, four parked shape the cases above seed, which is the
    // shallowest depth at which the shut list clips and the control exists.
    const made: Record<string, string> = { Loop: 'default' };
    for (const name of ['Launch', 'Billing', 'Research', 'Design', 'Infra', 'Support', 'Docs', 'Quiet']) {
      made[name] = (await addRoom(name)).id;
    }
    await addTask('Confirm the room copy', 'default');
    await tick();
    for (const name of ['Docs', 'Support', 'Infra']) { await addTask(`Work in ${name}`, made[name]); await tick(); }
    for (const name of ['Design', 'Research', 'Billing']) {
      await park(await addTask(`Approve the ${name} note 1`, made[name]));
      await tick();
    }
    const running = await addTask('Choose the release scope', made.Launch);
    expect((await request.patch(`${apiUrl}/tasks/${running.id}/status`, { data: { status: 'running' } })).ok()).toBeTruthy();
    await park(await addTask('Approve the launch note 1', made.Launch));

    context = await authedContext(browser, session.token);
    // Per frame presence of the control, recorded as transitions. A poll can
    // step over a control that leaves and returns inside one frame; this cannot.
    await context.addInitScript(() => {
      const log: string[] = [];
      (window as unknown as { __toggleLog: string[] }).__toggleLog = log;
      let last: boolean | null = null;
      const check = () => {
        const present = !!document.querySelector('.room-activity-toggle');
        const expanded = document.querySelector('.room-activity')?.getAttribute('data-expanded');
        if (present !== last) { log.push(`present=${present} expanded=${expanded}`); last = present; }
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
    const page = await context.newPage();
    const activity = page.getByRole('region', { name: 'Room activity', exact: true });
    const rows = activity.locator('[data-activity-room]');
    const list = page.locator('#room-activity-list');
    const toggle = activity.getByRole('button', { name: /rooms?$/ });
    const inbox = page.getByRole('region', { name: 'Inbox', exact: true });
    const queueRows = inbox.locator('[data-task-id]');
    const clearLog = () => page.evaluate(() => { (window as unknown as { __toggleLog: string[] }).__toggleLog.length = 0; });
    const readLog = () => page.evaluate(() => (window as unknown as { __toggleLog: string[] }).__toggleLog.slice());
    // The control is still the way back after each perturbation, not merely
    // present in the tree: it carries the open state and the collapse label.
    async function stillTheWayBack(label: string) {
      await expect(toggle, label).toHaveCount(1);
      await expect(toggle, label).toBeVisible();
      await expect(toggle, label).toHaveAttribute('aria-expanded', 'true');
      await expect(toggle, label).toHaveText('Show fewer rooms');
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('http://127.0.0.1:3100/');
    await expect(activity).toBeVisible();
    await expect(rows).toHaveCount(9);
    await expect(queueRows).toHaveCount(4);
    // Shut and clipping, so the control is earned rather than assumed.
    await expect(toggle).toBeVisible();
    expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // Open, the list runs to its natural height, so the reading that revealed
    // this control is now false and only the effect guard keeps it from being
    // written. Everything below happens in that state.
    expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(false);
    await clearLog();

    for (const viewport of [
      { width: 1440, height: 2400 }, { width: 1440, height: 1400 }, { width: 1440, height: 300 },
      { width: 600, height: 900 }, { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(150);
      await stillTheWayBack(`resized to ${viewport.width}x${viewport.height} while open`);
    }

    // The queue above grows over SSE, which hands this section a different
    // amount of room, and shrinks again.
    const surge: Task[] = [];
    for (let n = 0; n < 12; n += 1) {
      const task = await addTask(`Approve the surge note ${n + 1}`, made.Design);
      await park(task);
      surge.push(task);
    }
    await expect(queueRows).toHaveCount(16);
    await stillTheWayBack('queue grown to sixteen over SSE while open');
    for (const task of surge) {
      expect((await request.patch(`${apiUrl}/tasks/${task.id}/status`, { data: { status: 'running' } })).ok()).toBeTruthy();
    }
    await expect(queueRows).toHaveCount(4);
    await stillTheWayBack('queue shrunk back to four over SSE while open');

    // Rooms created by another client are not a perturbation of this list at
    // all, and that is worth holding still rather than assuming: Room.tsx
    // fetches /rooms once per authenticated attempt and nothing streams that
    // list, so six rooms created over the API leave the rendered row count where
    // it was. The only path that grows it is `createRoom` appending to local
    // state in this tab, and that pushes straight to the new room and unmounts
    // this section, so it cannot move the count under an open list either.
    for (let n = 0; n < 6; n += 1) { await addRoom(`Surge ${n + 1}`); await tick(); }
    await page.waitForTimeout(500);
    await expect(rows).toHaveCount(9);
    await stillTheWayBack('six rooms created while open');

    // The row is restyled in both directions, so the list box moves under the
    // observer that is watching it.
    await page.addStyleTag({ content: '.inbox-title { font-size: 26px }' });
    await page.waitForTimeout(250);
    await stillTheWayBack('row restyled larger while open');
    await page.addStyleTag({ content: '.inbox-title { font-size: 6px } .inbox-sub { font-size: 6px }' });
    await page.waitForTimeout(250);
    await stillTheWayBack('row restyled smaller while open');

    // Nothing above changed the control's presence on any frame.
    expect(await readLog(), 'the control changed presence while the list was open').toEqual([]);

    // And it is still the way back: clicking it returns the bounded box.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toHaveCount(1);
    expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
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
