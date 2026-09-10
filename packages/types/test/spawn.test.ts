import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskSpawn } from '../src';

const valid = { title: 'Review the split', definitionOfDone: 'child proof' };

test('parseTaskSpawn accepts a complete spawn and rejects malformed ones', () => {
  const ok = parseTaskSpawn(JSON.stringify(valid));
  assert.deepEqual(ok, { spawn: valid });
  const withAgent = parseTaskSpawn(JSON.stringify({ ...valid, agentId: 'reviewer' }));
  assert.deepEqual(withAgent, { spawn: { ...valid, agentId: 'reviewer' } });
  const trimmed = parseTaskSpawn(JSON.stringify({ title: '  Review the split  ', definitionOfDone: '  child proof  ' }));
  assert.deepEqual(trimmed, { spawn: valid });
  const badJson = parseTaskSpawn('{');
  assert.ok('error' in badJson);
  assert.match(badJson.error, /Malformed spawn/);
  const missingTitle = parseTaskSpawn(JSON.stringify({ definitionOfDone: 'x' }));
  assert.ok('error' in missingTitle);
  assert.match(missingTitle.error, /missing title/);
  const missingDone = parseTaskSpawn(JSON.stringify({ title: 'x' }));
  assert.ok('error' in missingDone);
  assert.match(missingDone.error, /missing definitionOfDone/);
  const emptyTitle = parseTaskSpawn(JSON.stringify({ title: '  ', definitionOfDone: 'x' }));
  assert.ok('error' in emptyTitle);
  assert.match(emptyTitle.error, /title must be a nonempty string/);
  const longTitle = parseTaskSpawn(JSON.stringify({ title: 'a'.repeat(201), definitionOfDone: 'x' }));
  assert.ok('error' in longTitle);
  assert.match(longTitle.error, /title must be at most 200/);
  const longDone = parseTaskSpawn(JSON.stringify({ title: 'x', definitionOfDone: 'a'.repeat(8001) }));
  assert.ok('error' in longDone);
  assert.match(longDone.error, /definitionOfDone must be at most 8000/);
  const emptyAgent = parseTaskSpawn(JSON.stringify({ ...valid, agentId: ' ' }));
  assert.ok('error' in emptyAgent);
  assert.match(emptyAgent.error, /agentId/);
  const notObject = parseTaskSpawn('[]');
  assert.ok('error' in notObject);
  assert.match(notObject.error, /expected a JSON object/);
});
