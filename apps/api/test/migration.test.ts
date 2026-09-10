import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Sqlite from 'better-sqlite3';

test('room migration preserves legacy task events and their replay ids', () => {
  const sqlite = new Sqlite(':memory:');
  sqlite.pragma('foreign_keys = ON');
  try {
    sqlite.exec(readFileSync('migrations/0000_tasks_events.sql', 'utf8'));
    const task = { id: 'old', title: 'Old task', owner: 'Human', definitionOfDone: 'Proof', status: 'queued', createdAt: 'then', updatedAt: 'then' };
    sqlite.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?)').run(...Object.values(task));
    sqlite.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?)').run(42, task.id, 'then', 'task_created', JSON.stringify({ task }));
    sqlite.exec(readFileSync('migrations/0001_rooms_messages.sql', 'utf8'));
    const event = sqlite.prepare('SELECT * FROM events').get() as { id: number; subject_id: string; room_id: string; payload: string };
    assert.equal(event.id, 42);
    assert.equal(event.subject_id, task.id);
    assert.equal(event.room_id, 'default');
    assert.deepEqual(JSON.parse(event.payload), { task: { ...task, roomId: 'default' } });
    assert.deepEqual(sqlite.prepare('SELECT id FROM rooms').all(), [{ id: 'default' }]);
    assert.deepEqual(sqlite.pragma('foreign_key_check'), []);
    sqlite.exec(readFileSync('migrations/0002_task_run.sql', 'utf8'));
    const columns = sqlite.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
    assert.deepEqual(
      columns.map((column) => column.name).filter((name) => ['claimed_by', 'run_id', 'log', 'result', 'error'].includes(name)),
      ['claimed_by', 'run_id', 'log', 'result', 'error'],
    );
    const migrated = sqlite.prepare('SELECT claimed_by, run_id, log, result, error FROM tasks WHERE id = ?').get(task.id) as {
      claimed_by: null; run_id: null; log: string; result: null; error: null;
    };
    assert.equal(migrated.log, '[]');
    assert.equal(migrated.claimed_by, null);
    assert.deepEqual(sqlite.pragma('foreign_key_check'), []);
    sqlite.exec(readFileSync('migrations/0003_task_question.sql', 'utf8'));
    const questionCols = sqlite.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
    assert.deepEqual(
      questionCols.map((column) => column.name).filter((name) => ['question', 'answer', 'answered_by'].includes(name)),
      ['question', 'answer', 'answered_by'],
    );
    const asked = sqlite.prepare('SELECT question, answer, answered_by FROM tasks WHERE id = ?').get(task.id) as {
      question: null; answer: null; answered_by: null;
    };
    assert.equal(asked.question, null);
    assert.equal(asked.answer, null);
    assert.equal(asked.answered_by, null);
    assert.deepEqual(sqlite.pragma('foreign_key_check'), []);
    sqlite.exec(readFileSync('migrations/0004_task_agent.sql', 'utf8'));
    const agentCols = sqlite.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
    assert.ok(agentCols.some((column) => column.name === 'agent_id'));
    const assigned = sqlite.prepare('SELECT agent_id FROM tasks WHERE id = ?').get(task.id) as { agent_id: null };
    assert.equal(assigned.agent_id, null);
    assert.deepEqual(sqlite.pragma('foreign_key_check'), []);
  } finally { sqlite.close(); }
});
