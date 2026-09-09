import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_STATUS, TASK_STATUSES, type Task, type TaskEvent } from '@loop/types';
import { applyTaskEvent, sseBackoffDelay } from '../lib/feed';

test('replay upserts the same row and live status updates replace it', () => {
  const task: Task = { id: 'a', title: 'Task', owner: 'Human', definitionOfDone: 'Proof', status: INITIAL_STATUS, createdAt: '', updatedAt: '' };
  const event: TaskEvent = { id: 1, task_id: task.id, ts: '', kind: 'task_created', payload: { task } };
  const rows = applyTaskEvent(applyTaskEvent([], event), event);
  assert.equal(rows.length, 1);
  const updated = applyTaskEvent(rows, { ...event, payload: { task: { ...task, status: TASK_STATUSES.at(-1)! } } });
  assert.equal(updated.length, 1);
  assert.equal(updated[0].status, TASK_STATUSES.at(-1));
});
test('jitter stays within the exponential envelope and 30 second cap', () => {
  for (let attempt = 0; attempt < 20; attempt++) {
    const base = Math.min(2000 * 2 ** attempt, 30_000);
    for (let sample = 0; sample < 20; sample++) {
      const delay = sseBackoffDelay(attempt);
      assert.ok(delay >= base * .75 && delay <= Math.min(base * 1.25, 30_000));
    }
  }
});
