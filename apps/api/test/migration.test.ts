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
    sqlite.exec(readFileSync('migrations/0005_task_verdict.sql', 'utf8'));
    const verdictCols = sqlite.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
    assert.deepEqual(
      verdictCols.map((column) => column.name).filter((name) => ['verdict', 'verdict_note', 'verdict_by'].includes(name)),
      ['verdict', 'verdict_note', 'verdict_by'],
    );
    const reviewed = sqlite.prepare('SELECT verdict, verdict_note, verdict_by FROM tasks WHERE id = ?').get(task.id) as {
      verdict: null; verdict_note: null; verdict_by: null;
    };
    assert.equal(reviewed.verdict, null);
    assert.equal(reviewed.verdict_note, null);
    assert.equal(reviewed.verdict_by, null);
    assert.deepEqual(sqlite.pragma('foreign_key_check'), []);
    sqlite.exec(readFileSync('migrations/0006_task_proposal.sql', 'utf8'));
    const proposalCols = sqlite.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
    assert.deepEqual(
      proposalCols.map((column) => column.name).filter((name) => ['proposal', 'proposal_choice', 'proposal_by'].includes(name)),
      ['proposal', 'proposal_choice', 'proposal_by'],
    );
    const proposed = sqlite.prepare('SELECT proposal, proposal_choice, proposal_by FROM tasks WHERE id = ?').get(task.id) as {
      proposal: null; proposal_choice: null; proposal_by: null;
    };
    assert.equal(proposed.proposal, null);
    assert.equal(proposed.proposal_choice, null);
    assert.equal(proposed.proposal_by, null);
    assert.deepEqual(sqlite.pragma('foreign_key_check'), []);
    sqlite.exec(readFileSync('migrations/0007_task_parent.sql', 'utf8'));
    const parentCols = sqlite.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
    assert.ok(parentCols.some((column) => column.name === 'parent_task_id'));
    const lineage = sqlite.prepare('SELECT parent_task_id FROM tasks WHERE id = ?').get(task.id) as {
      parent_task_id: null;
    };
    assert.equal(lineage.parent_task_id, null);
    sqlite.prepare('INSERT INTO tasks (id, room_id, title, owner, definition_of_done, status, created_at, updated_at, log, parent_task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('child', 'default', 'Child', 'Human', 'Proof', 'queued', 'then', 'then', '[]', task.id);
    const linked = sqlite.prepare('SELECT parent_task_id FROM tasks WHERE id = ?').get('child') as { parent_task_id: string };
    assert.equal(linked.parent_task_id, task.id);
    assert.deepEqual(sqlite.pragma('foreign_key_check'), []);
    sqlite.exec(readFileSync('migrations/0008_auth.sql', 'utf8'));
    const authCols = sqlite.prepare('PRAGMA table_info(principals)').all() as { name: string }[];
    assert.deepEqual(authCols.map((column) => column.name), ['id', 'kind', 'display_name', 'disabled_at', 'created_at']);
    const taskAuth = sqlite.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
    assert.ok(taskAuth.some((column) => column.name === 'owner_principal_id'));
    assert.ok(taskAuth.some((column) => column.name === 'answered_by_principal_id'));
    assert.ok(taskAuth.some((column) => column.name === 'verdict_by_principal_id'));
    assert.ok(taskAuth.some((column) => column.name === 'proposal_by_principal_id'));
    const leftover = sqlite.prepare('SELECT owner, owner_principal_id FROM tasks WHERE id = ?').get(task.id) as {
      owner: string; owner_principal_id: null;
    };
    assert.equal(leftover.owner, 'Human');
    assert.equal(leftover.owner_principal_id, null);
    assert.deepEqual(sqlite.pragma('foreign_key_check'), []);
    sqlite.exec(readFileSync('migrations/0009_room_agents.sql', 'utf8'));
    const roomAgentCols = sqlite.prepare('PRAGMA table_info(room_agents)').all() as { name: string }[];
    assert.deepEqual(
      roomAgentCols.map((column) => column.name),
      ['id', 'room_id', 'catalog_id', 'name', 'created_by', 'created_at'],
    );
    const seeded = sqlite.prepare('SELECT catalog_id, name FROM room_agents WHERE room_id = ? ORDER BY name').all('default') as {
      catalog_id: string; name: string;
    }[];
    assert.deepEqual(seeded, [
      { catalog_id: 'echo', name: 'echo' },
      { catalog_id: 'reviewer', name: 'reviewer' },
    ]);
    assert.deepEqual(sqlite.pragma('foreign_key_check'), []);
    sqlite.exec(readFileSync('migrations/0010_invites.sql', 'utf8'));
    const inviteCols = sqlite.prepare('PRAGMA table_info(invites)').all() as { name: string }[];
    assert.deepEqual(
      inviteCols.map((column) => column.name),
      ['id', 'room_id', 'email', 'role', 'token_hash', 'invited_by', 'created_at', 'accepted_at', 'expires_at'],
    );
    const inviteIndexes = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'invites' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name").all() as { name: string }[];
    assert.deepEqual(inviteIndexes.map((row) => row.name), ['invites_pending_room_email', 'invites_token_hash']);
    assert.deepEqual(sqlite.pragma('foreign_key_check'), []);
    sqlite.exec(readFileSync('migrations/0011_files.sql', 'utf8'));
    const fileCols = sqlite.prepare('PRAGMA table_info(files)').all() as { name: string }[];
    assert.deepEqual(
      fileCols.map((column) => column.name),
      ['id', 'room_id', 'name', 'size', 'content_type', 'sha256', 'stored_path', 'uploaded_by', 'created_at'],
    );
    assert.deepEqual(sqlite.pragma('foreign_key_check'), []);
  } finally { sqlite.close(); }
});
