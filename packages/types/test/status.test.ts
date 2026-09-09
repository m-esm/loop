import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TASK_STATUS, TASK_STATUSES, ACTIVE_STATUSES, isActiveStatus, isRunningStatus, isTaskStatus, relativeTime } from '../src';

test('status helpers derive every classification from the vocabulary', () => {
  for (const status of TASK_STATUSES) {
    assert.ok(isTaskStatus(status));
    assert.equal(ACTIVE_STATUSES.has(status), TASK_STATUS[status].active);
    assert.equal(isActiveStatus(status), TASK_STATUS[status].active);
    assert.equal(isRunningStatus(status), TASK_STATUS[status].running);
  }
  assert.equal(isTaskStatus('__proto__'), false);
  assert.equal(isRunningStatus('missing'), false);
  assert.equal(relativeTime('bad date'), '');
});
