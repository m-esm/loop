import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseComposer } from '../src';

test('composer grammar: text, task, done when, unknown command and escaped slash', () => {
  assert.deepEqual(parseComposer(' hello\nworld '), { kind: 'text', text: 'hello\nworld' });
  assert.deepEqual(parseComposer('/task Build Loop'), { kind: 'task', title: 'Build Loop', definitionOfDone: 'Build Loop' });
  assert.deepEqual(parseComposer('/task Build :: Tests pass'), { kind: 'task', title: 'Build', definitionOfDone: 'Tests pass' });
  assert.deepEqual(parseComposer('//task literal'), { kind: 'text', text: '/task literal' });
  assert.deepEqual(parseComposer('/task @reviewer check the diff :: proof'), {
    kind: 'task', title: 'check the diff', definitionOfDone: 'proof', agentId: 'reviewer',
  });
  assert.deepEqual(parseComposer('/task email @ 9am :: proof'), {
    kind: 'task', title: 'email @ 9am', definitionOfDone: 'proof',
  });
  assert.deepEqual(parseComposer('/task @ :: proof'), {
    kind: 'task', title: '@', definitionOfDone: 'proof',
  });
  assert.deepEqual(parseComposer('//task @reviewer check :: proof'), { kind: 'text', text: '/task @reviewer check :: proof' });
  for (const input of ['/ask human', '/tasks thing', '/']) {
    const result = parseComposer(input);
    assert.equal(result.kind, 'error');
    if (result.kind === 'error') assert.equal(result.code, 'unknown_command');
  }
  for (const input of ['', ' ', '/task', '/task :: proof', '/task title :: ', `/task ${'a'.repeat(201)}`]) {
    assert.equal(parseComposer(input).kind, 'error');
  }
  const mention = parseComposer('/task @');
  assert.equal(mention.kind, 'error');
  if (mention.kind === 'error') assert.equal(mention.code, 'malformed_mention');
  const nameless = parseComposer('/task @reviewer');
  assert.equal(nameless.kind, 'error');
  if (nameless.kind === 'error') assert.equal(nameless.code, 'invalid_task');
});
