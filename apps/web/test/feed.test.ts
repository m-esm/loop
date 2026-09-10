import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_STATUS, TASK_STATUSES, type Task, type TaskEvent } from '@loop/types';
import { applyTaskEvent, sseBackoffDelay } from '../lib/feed';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import MessageCard from '../components/MessageCard';

test('mixed replay keeps messages unique and a task card renders the updated task', () => {
  const task: Task = { id: 'task', roomId: 'default', title: 'Build', owner: 'Human', definitionOfDone: 'Proof', status: INITIAL_STATUS, createdAt: '', updatedAt: '' };
  const created: TaskEvent = { id: 1, room_id: 'default', subject_id: task.id, ts: '', kind: 'task_created', payload: { task } };
  const card: TaskEvent = { id: 2, room_id: 'default', subject_id: 'card', ts: '', kind: 'message_created', payload: {
    message: { id: 'card', roomId: 'default', author: 'Human', body: { kind: 'task', taskId: task.id }, createdAt: '' },
  } };
  const text: TaskEvent = { ...card, id: 3, subject_id: 'text', payload: { message: { ...card.payload.message, id: 'text', body: { kind: 'text', text: 'Hello' } } } };
  const before = [created, card, text, card].reduce(applyTaskEvent, { tasks: [], messages: [] });
  const after = applyTaskEvent(before, { ...created, id: 4, kind: 'task_status_changed', payload: {
    task: { ...task, status: TASK_STATUSES.at(-1)! }, previousStatus: task.status,
  } });
  assert.equal(after.messages.length, 2);
  assert.equal(before.tasks[0].status, INITIAL_STATUS);
  assert.equal(after.messages, before.messages);
  const html = renderToStaticMarkup(createElement(MessageCard, { message: after.messages[0], task: after.tasks[0] }));
  assert.ok(html.includes(TASK_STATUSES.at(-1)!));
  assert.ok(html.includes('Build'));
});

test('replay upserts the same row and live status updates replace it', () => {
  const task: Task = { id: 'a', roomId: 'default', title: 'Task', owner: 'Human', definitionOfDone: 'Proof', status: INITIAL_STATUS, createdAt: '', updatedAt: '' };
  const event: TaskEvent = { id: 1, subject_id: task.id, room_id: task.roomId, ts: '', kind: 'task_created', payload: { task } };
  const rows = applyTaskEvent(applyTaskEvent({ tasks: [], messages: [] }, event), event);
  assert.equal(rows.tasks.length, 1);
  const updated = applyTaskEvent(rows, { ...event, payload: { task: { ...task, status: TASK_STATUSES.at(-1)! } } });
  assert.equal(updated.tasks.length, 1);
  assert.equal(updated.tasks[0].status, TASK_STATUSES.at(-1));
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
