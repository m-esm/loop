import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAgents } from '../src/agents';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'loop-agents-'));
  dirs.push(dir);
  const path = join(dir, 'agents.json');
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
  return path;
}

test('loadAgents returns the seeded shape and rejects duplicates and empty commands', () => {
  const path = write({
    agents: [
      { id: 'a', name: 'A', command: [process.execPath, '-e', '0'] },
      { id: 'b', name: 'B', command: [process.execPath, '-e', '1'] },
    ],
  });
  const loaded = loadAgents(path);
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].id, 'a');
  assert.deepEqual(loaded[0].command.slice(0, 2), [process.execPath, '-e']);

  assert.throws(
    () => loadAgents(write({ agents: [
      { id: 'echo', name: 'One', command: ['node', '-e', '0'] },
      { id: 'echo', name: 'Two', command: ['node', '-e', '1'] },
    ] })),
    /duplicate agent id echo/,
  );
  assert.throws(
    () => loadAgents(write({ agents: [{ id: 'echo', name: 'Echo', command: [] }] })),
    /command must be a nonempty array of strings/,
  );
  assert.throws(
    () => loadAgents(write({ agents: [{ id: 'echo', name: 'Echo', command: ['node', 1] }] })),
    /command must be a nonempty array of strings/,
  );
});

test('a missing agents file is empty; malformed JSON crashes loudly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-agents-'));
  dirs.push(dir);
  assert.deepEqual(loadAgents(join(dir, 'nope.json')), []);
  assert.throws(() => loadAgents(write('{')), /Malformed agents file/);
  assert.throws(() => loadAgents(write({ notAgents: [] })), /expected \{ agents: \[\.\.\.\] \}/);
});
