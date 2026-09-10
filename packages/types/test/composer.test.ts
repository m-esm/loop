import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseComposer } from '../src';

test('composer grammar: text, task, done when, unknown command and escaped slash', () => {
  assert.deepEqual(parseComposer(' hello\nworld '), { kind: 'text', text: 'hello\nworld' });
  assert.deepEqual(parseComposer('/task Build Loop'), { kind: 'task', title: 'Build Loop', definitionOfDone: 'Build Loop' });
  assert.deepEqual(parseComposer('/task Build :: Tests pass'), { kind: 'task', title: 'Build', definitionOfDone: 'Tests pass' });
  assert.deepEqual(parseComposer('//task literal'), { kind: 'text', text: '/task literal' });
  for (const input of ['/ask human', '/tasks thing', '/']) {
    const result = parseComposer(input);
    assert.equal(result.kind, 'error');
    if (result.kind === 'error') assert.equal(result.code, 'unknown_command');
  }
  for (const input of ['', ' ', '/task', '/task :: proof', '/task title :: ', `/task ${'a'.repeat(201)}`]) {
    assert.equal(parseComposer(input).kind, 'error');
  }
});
