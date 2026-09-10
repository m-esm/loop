import { test, expect, type BrowserContext } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import Sqlite from 'better-sqlite3';
import type { RoomFile, Task } from '@loop/types';
import { authedContext, seedSession, withAuth } from './auth';

const apiUrl = 'http://127.0.0.1:3101/api';
const MAX_FILE_BYTES = 10 * 1024 * 1024;

function upload(request: ReturnType<typeof withAuth>, room: string, name: string, body: Buffer, mimeType = 'text/plain') {
  return request.post(`${apiUrl}/rooms/${room}/files`, {
    multipart: { file: { name, mimeType, buffer: body } },
  });
}

test('a member of room A cannot fetch a file belonging to room B by id', async ({ request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-files-scope-'));
  const dbPath = join(dir, 'loop.sqlite');
  const session = seedSession(dbPath);
  const sqlite = new Sqlite(dbPath);
  sqlite.prepare('INSERT INTO rooms (id) VALUES (?)').run('other');
  sqlite.prepare('INSERT INTO room_members (room_id, principal_id, role) VALUES (?, ?, ?)').run('other', session.principalId, 'owner');
  sqlite.close();
  const request = withAuth(raw, session.token);
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ agents: [] }));
  const { stop } = await startApi(dir, request, { LOOP_ALLOW_REGISTER: '1' });
  try {
    const created = await upload(request, 'other', 'secret.txt', Buffer.from('room-b-secret\n'));
    expect(created.status()).toBe(201);
    const file = await created.json() as RoomFile;
    const mismatch = await request.get(`${apiUrl}/rooms/default/files/${file.id}/content`);
    expect(mismatch.status()).toBe(404);
    const registered = await raw.post(`${apiUrl}/auth/register`, {
      data: { email: 'member@loop.local', password: 'password1', displayName: 'Member' },
    });
    expect(registered.status()).toBe(201);
    const setCookie = registered.headers()['set-cookie'] ?? '';
    const token = /loop_session=([^;]+)/.exec(Array.isArray(setCookie) ? setCookie.join(';') : setCookie)?.[1];
    if (!token) throw new Error('expected session cookie');
    const member = withAuth(raw, token);
    expect((await member.get(`${apiUrl}/rooms/other/files/${file.id}/content`)).status()).toBe(403);
    expect((await member.get(`${apiUrl}/rooms/default/files/${file.id}/content`)).status()).toBe(404);
    const allowed = await request.get(`${apiUrl}/rooms/other/files/${file.id}/content`);
    expect(allowed.status()).toBe(200);
    expect(await allowed.text()).toBe('room-b-secret\n');
  } finally {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an upload over 10 MB is rejected with 413 and no row is written', async ({ request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-files-413-'));
  const session = seedSession(join(dir, 'loop.sqlite'));
  const request = withAuth(raw, session.token);
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ agents: [] }));
  const { stop } = await startApi(dir, request);
  try {
    const before = await (await request.get(`${apiUrl}/rooms/default/files`)).json() as { files: RoomFile[] };
    const denied = await upload(request, 'default', 'huge.bin', Buffer.alloc(MAX_FILE_BYTES + 1, 97), 'application/octet-stream');
    expect(denied.status()).toBe(413);
    const after = await (await request.get(`${apiUrl}/rooms/default/files`)).json() as { files: RoomFile[] };
    expect(after.files.length).toBe(before.files.length);
    const sqlite = new Sqlite(join(dir, 'loop.sqlite'));
    const count = sqlite.prepare('SELECT count(*) AS n FROM files').get() as { n: number };
    sqlite.close();
    expect(count.n).toBe(0);
  } finally {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a download response carries attachment and nosniff', async ({ request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-files-headers-'));
  const session = seedSession(join(dir, 'loop.sqlite'));
  const request = withAuth(raw, session.token);
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ agents: [] }));
  const { stop } = await startApi(dir, request);
  try {
    const created = await upload(request, 'default', 'page.html', Buffer.from('<script>alert(1)</script>'), 'text/html');
    expect(created.status()).toBe(201);
    const file = await created.json() as RoomFile;
    const response = await request.get(`${apiUrl}/rooms/default/files/${file.id}/content`);
    expect(response.status()).toBe(200);
    const disposition = response.headers()['content-disposition'] ?? '';
    expect(disposition).toMatch(/attachment/i);
    expect(response.headers()['x-content-type-options']).toBe('nosniff');
    expect(await response.text()).toBe('<script>alert(1)</script>');
  } finally {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the stored path does not contain the uploaded filename', async ({ request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-files-escape-'));
  const filesDir = join(dir, 'files');
  const session = seedSession(join(dir, 'loop.sqlite'));
  const request = withAuth(raw, session.token);
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ agents: [] }));
  const { stop } = await startApi(dir, request);
  try {
    const boundary = '----LoopFileBoundary';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="../../escape.txt"\r\nContent-Type: text/plain\r\n\r\n`),
      Buffer.from('escaped-bytes\n'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const created = await request.post(`${apiUrl}/rooms/default/files`, {
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      data: payload,
    });
    expect(created.status()).toBe(201);
    const file = await created.json() as RoomFile;
    expect(file.name).toBe('../../escape.txt');
    const sqlite = new Sqlite(join(dir, 'loop.sqlite'));
    const row = sqlite.prepare('SELECT stored_path, name FROM files WHERE id = ?').get(file.id) as {
      stored_path: string; name: string;
    };
    sqlite.close();
    expect(row.name).toBe('../../escape.txt');
    expect(row.stored_path).not.toContain('escape.txt');
    expect(row.stored_path).not.toContain('..');
    const abs = resolve(filesDir, row.stored_path);
    expect(abs.startsWith(resolve(filesDir, 'default') + '/')).toBe(true);
    expect(existsSync(abs)).toBe(true);
    expect(readFileSync(abs, 'utf8')).toBe('escaped-bytes\n');
    expect(existsSync(join(filesDir, 'escape.txt'))).toBe(false);
    expect(existsSync(join(dir, 'escape.txt'))).toBe(false);
  } finally {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LOOP_TASK_FILES lists only that room files and the agent can read one', async ({ request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-files-agent-'));
  const dbPath = join(dir, 'loop.sqlite');
  const session = seedSession(dbPath);
  const sqlite = new Sqlite(dbPath);
  sqlite.prepare('INSERT INTO rooms (id) VALUES (?)').run('other');
  sqlite.prepare('INSERT INTO room_members (room_id, principal_id, role) VALUES (?, ?, ?)').run('other', session.principalId, 'owner');
  sqlite.close();
  const request = withAuth(raw, session.token);
  const script = [
    'const files = JSON.parse(process.env.LOOP_TASK_FILES || "[]");',
    'const fs = require("fs");',
    'const first = files[0] ? fs.readFileSync(files[0].path, "utf8").split("\\n")[0] : "";',
    'process.stdout.write(JSON.stringify({ first, names: files.map((file) => file.name).sort() }) + "\\n");',
  ].join('');
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    agents: [{ id: 'echo', name: 'Echo', command: [process.execPath, '-e', script] }],
  }));
  const { stop } = await startApi(dir, request);
  try {
    expect((await upload(request, 'default', 'agent-notes.txt', Buffer.from('hello-from-file\nsecond line\n'))).status()).toBe(201);
    expect((await upload(request, 'other', 'other-secret.txt', Buffer.from('should-not-see\n'))).status()).toBe(201);
    const posted = await request.post(`${apiUrl}/messages`, {
      data: { roomId: 'default', body: '/task Read the notes :: first line printed' },
    });
    expect(posted.status()).toBe(201);
    const message = await posted.json() as { body: { kind: string; taskId?: string } };
    if (message.body.kind !== 'task' || !message.body.taskId) throw new Error('Expected task card');
    const taskId = message.body.taskId;
    await expect.poll(async () => {
      const task = await (await request.get(`${apiUrl}/tasks/${taskId}`)).json() as Task;
      return task.status;
    }).toBe('done');
    const task = await (await request.get(`${apiUrl}/tasks/${taskId}`)).json() as Task;
    const payload = JSON.parse(task.result ?? '{}') as { first?: string; names?: string[] };
    expect(payload.first).toBe('hello-from-file');
    expect(payload.names).toEqual(['agent-notes.txt']);
  } finally {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Files view shows an uploaded file and a member sees the file card', async ({ browser, request: raw }) => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-files-ui-'));
  const session = seedSession(join(dir, 'loop.sqlite'));
  const request = withAuth(raw, session.token);
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ agents: [] }));
  const { stop } = await startApi(dir, request, { LOOP_ALLOW_REGISTER: '1' });
  const contexts: BrowserContext[] = [];
  try {
    const ownerContext = await authedContext(browser, session.token);
    contexts.push(ownerContext);
    const page = await ownerContext.newPage();
    await page.goto('http://127.0.0.1:3100');
    await expect(page.locator('[data-live]')).toHaveAttribute('data-live', '1');
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    const form = page.getByRole('form', { name: 'Upload file' });
    await expect(form).toBeVisible();
    await form.locator('[data-file-upload]').setInputFiles({
      name: 'brief.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('from the ui\n'),
    });
    await form.getByRole('button', { name: 'Upload' }).click();
    const row = page.locator('[data-file-row]');
    await expect(row).toBeVisible();
    await expect(row.getByText('brief.txt')).toBeVisible();
    await expect(form.getByLabel('Upload file')).toBeInViewport({ ratio: 1 });
    await expect(form.getByRole('button', { name: 'Upload' })).toBeInViewport({ ratio: 1 });
    await expect(row).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: resolve('docs/screenshots/files.png') });

    const registered = await raw.post(`${apiUrl}/auth/register`, {
      data: { email: 'reader@loop.local', password: 'password1', displayName: 'Reader' },
    });
    expect(registered.status()).toBe(201);
    const setCookie = registered.headers()['set-cookie'] ?? '';
    const token = /loop_session=([^;]+)/.exec(Array.isArray(setCookie) ? setCookie.join(';') : setCookie)?.[1];
    if (!token) throw new Error('expected session cookie');
    const memberContext = await authedContext(browser, token);
    contexts.push(memberContext);
    const memberPage = await memberContext.newPage();
    await memberPage.goto('http://127.0.0.1:3100');
    await expect(memberPage.locator('[data-live]')).toHaveAttribute('data-live', '1');
    const card = memberPage.locator('.file-card').filter({ hasText: 'brief.txt' });
    await expect(card).toBeVisible();
    await expect(card.getByRole('link', { name: 'Download' })).toBeVisible();
    await memberPage.getByRole('button', { name: 'Files', exact: true }).click();
    await expect(memberPage.locator('[data-file-row]').filter({ hasText: 'brief.txt' })).toBeVisible();
  } finally {
    await Promise.all(contexts.map((item) => item.close()));
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function startApi(
  dir: string,
  request: ReturnType<typeof withAuth>,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ stop: () => Promise<void>; output: string }> {
  let output = '';
  const api = spawn(process.execPath, ['dist/src/main.js'], {
    cwd: resolve('apps/api'),
    env: {
      ...process.env,
      PORT: '3101',
      WEB_ORIGIN: 'http://127.0.0.1:3100',
      DATABASE_PATH: join(dir, 'loop.sqlite'),
      LOOP_FILES_PATH: join(dir, 'files'),
      LOOP_RUNNER: '1',
      LOOP_AGENTS_PATH: join(dir, 'agents.json'),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  api.stdout?.on('data', (chunk) => { output += chunk; });
  api.stderr?.on('data', (chunk) => { output += chunk; });
  const expectedTasks = () => 0;
  await expect.poll(async () => {
    if (api.exitCode != null) throw new Error(output);
    return request.get(`${apiUrl}/tasks`)
      .then(async (response) => (response.status() === 200
        && ((await response.json()) as { tasks: unknown[] }).tasks.length === expectedTasks() ? 200 : 0))
      .catch(() => 0);
  }).toBe(200);
  return {
    output,
    stop: async () => {
      if (!api || api.exitCode !== null) return;
      const exited = once(api, 'exit');
      api.kill('SIGKILL');
      await exited;
    },
  };
}
