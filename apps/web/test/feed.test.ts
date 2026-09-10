import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_STATUS, TASK_STATUSES, type Task, type TaskEvent } from '@loop/types';
import { applyTaskEvent, needsHumanCount, sseBackoffDelay } from '../lib/feed';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import MessageCard from '../components/MessageCard';
import TaskCard from '../components/TaskCard';

function taskOf(over: Partial<Task> = {}): Task {
  return {
    id: 'task', roomId: 'default', title: 'Build', owner: 'Human', definitionOfDone: 'Proof',
    status: INITIAL_STATUS, createdAt: '', updatedAt: '',
    agentId: null, claimedBy: null, runId: null, log: [], result: null, error: null,
    question: null, answer: null, answeredBy: null,
    verdict: null, verdictNote: null, verdictBy: null,
    proposal: null, proposalChoice: null, proposalBy: null, ...over,
  };
}

test('mixed replay keeps messages unique and a task card renders the updated task', () => {
  const task: Task = taskOf();
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
  const html = renderToStaticMarkup(createElement(MessageCard, { message: after.messages[0], task: after.tasks[0], author: 'Human' }));
  assert.ok(html.includes(TASK_STATUSES.at(-1)!));
  assert.ok(html.includes('Build'));
  const withAgent = renderToStaticMarkup(createElement(TaskCard, {
    task: taskOf({ agentId: 'reviewer' }), author: 'Human',
  }));
  assert.ok(withAgent.includes('Agent: reviewer'));
  const withoutAgent = renderToStaticMarkup(createElement(TaskCard, { task: taskOf(), author: 'Human' }));
  assert.equal(withoutAgent.includes('Agent:'), false);
  const finished = renderToStaticMarkup(createElement(TaskCard, {
    task: taskOf({ status: 'done', result: 'ok', log: ['one', 'two'] }), author: 'Moshe',
  }));
  assert.ok(finished.includes('Accept'));
  assert.ok(finished.includes('Reject'));
  assert.ok(finished.includes('What happened · 2 lines'));
  assert.equal(finished.includes('data-task-verdict'), false);
  const accepted = renderToStaticMarkup(createElement(TaskCard, {
    task: taskOf({ status: 'done', result: 'ok', verdict: 'accepted', verdictBy: 'Moshe' }), author: 'Moshe',
  }));
  assert.ok(accepted.includes('Accepted by Moshe'));
  assert.equal(accepted.includes('name="accepted"'), false);
  const running = renderToStaticMarkup(createElement(TaskCard, {
    task: taskOf({ status: 'running', log: ['working'] }), author: 'Moshe',
  }));
  assert.ok(running.includes('Work in progress · 1 line'));
  assert.equal(running.includes('Accept'), false);
  const proposal = {
    question: 'Which store?', options: ['SQLite', 'Postgres'], pick: 'SQLite', why: 'one file, no service',
  };
  const proposing = renderToStaticMarkup(createElement(TaskCard, {
    task: taskOf({ status: 'needs_input', proposal }), author: 'Moshe',
  }));
  assert.ok(proposing.includes('data-task-proposal'));
  assert.ok(proposing.includes('data-proposal-option="SQLite"'));
  assert.ok(proposing.includes('data-proposal-option="Postgres"'));
  assert.ok(proposing.includes('agent&#x27;s pick'));
  assert.ok(proposing.includes('Approve'));
  assert.ok(proposing.includes('Discuss'));
  const decided = renderToStaticMarkup(createElement(TaskCard, {
    task: taskOf({ proposal, proposalChoice: 'Postgres', proposalBy: 'Moshe' }), author: 'Moshe',
  }));
  assert.ok(decided.includes('data-task-choice'));
  assert.ok(decided.includes('Postgres by Moshe'));
  assert.equal(decided.includes('name="approve"'), false);
});

test('replay upserts the same row and live status updates replace it', () => {
  const task: Task = taskOf({ id: 'a', title: 'Task' });
  const event: TaskEvent = { id: 1, subject_id: task.id, room_id: task.roomId, ts: '', kind: 'task_created', payload: { task } };
  const rows = applyTaskEvent(applyTaskEvent({ tasks: [], messages: [] }, event), event);
  assert.equal(rows.tasks.length, 1);
  const updated = applyTaskEvent(rows, { ...event, payload: { task: { ...task, status: TASK_STATUSES.at(-1)! } } });
  assert.equal(updated.tasks.length, 1);
  assert.equal(updated.tasks[0].status, TASK_STATUSES.at(-1));
});
test('task_progress upserts the live log without adding a row', () => {
  const task = taskOf({ log: [] });
  const created: TaskEvent = { id: 1, subject_id: task.id, room_id: task.roomId, ts: '', kind: 'task_created', payload: { task } };
  const progress: TaskEvent = {
    id: 2, subject_id: task.id, room_id: task.roomId, ts: '', kind: 'task_progress',
    payload: { task: { ...task, status: 'running', log: ['Echo started'] } },
  };
  const after = applyTaskEvent(applyTaskEvent({ tasks: [], messages: [] }, created), progress);
  assert.equal(after.tasks.length, 1);
  assert.deepEqual(after.tasks[0].log, ['Echo started']);
  assert.equal(after.tasks[0].status, 'running');
  const html = renderToStaticMarkup(createElement(MessageCard, {
    message: { id: 'card', roomId: 'default', author: 'Human', body: { kind: 'task', taskId: task.id }, createdAt: '' },
    task: { ...after.tasks[0], status: 'done', result: 'Echo: Build', log: ['Echo started', 'Echo finished'] },
    author: 'Human',
  }));
  assert.ok(html.includes('Echo started'));
  assert.ok(html.includes('Echo: Build'));
});

test('needsHumanCount counts parked tasks, not cards, and drops when answered', () => {
  assert.equal(needsHumanCount([]), 0);
  assert.equal(needsHumanCount([taskOf(), taskOf({ id: 'run', status: 'running' })]), 0);
  const parkedA = taskOf({ id: 'a', status: 'needs_input', question: 'colour?' });
  const parkedB = taskOf({ id: 'b', status: 'needs_input', question: 'shape?' });
  const done = taskOf({ id: 'c', status: 'done' });
  assert.equal(needsHumanCount([parkedA, parkedB, done]), 2);
  const withCards = { tasks: [parkedA], messages: [] };
  assert.equal(needsHumanCount(withCards.tasks), 1);
  const afterAnswer = applyTaskEvent(withCards, {
    id: 9, room_id: 'default', subject_id: parkedA.id, ts: '', kind: 'task_status_changed',
    payload: { task: { ...parkedA, status: 'queued', question: null, answer: 'blue' }, previousStatus: 'needs_input' },
  });
  assert.equal(needsHumanCount(afterAnswer.tasks), 0);
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
