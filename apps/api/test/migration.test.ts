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
  } finally { sqlite.close(); }
});
