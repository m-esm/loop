export interface TaskSpawn {
  title: string;
  definitionOfDone: string;
  agentId?: string;
}

const TITLE_MAX = 200;
const DONE_MAX = 8000;
const AGENT_MAX = 100;

export function parseTaskSpawn(raw: string): { spawn: TaskSpawn } | { error: string } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'invalid JSON';
    return { error: `Malformed spawn: ${reason}` };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'Malformed spawn: expected a JSON object' };
  }
  const row = value as Record<string, unknown>;
  if (!('title' in row)) return { error: 'Malformed spawn: missing title' };
  if (!('definitionOfDone' in row)) return { error: 'Malformed spawn: missing definitionOfDone' };
  if (typeof row.title !== 'string' || !row.title.trim()) {
    return { error: 'Malformed spawn: title must be a nonempty string' };
  }
  if (typeof row.definitionOfDone !== 'string' || !row.definitionOfDone.trim()) {
    return { error: 'Malformed spawn: definitionOfDone must be a nonempty string' };
  }
  const title = row.title.trim();
  const definitionOfDone = row.definitionOfDone.trim();
  if (title.length > TITLE_MAX) {
    return { error: `Malformed spawn: title must be at most ${TITLE_MAX} characters` };
  }
  if (definitionOfDone.length > DONE_MAX) {
    return { error: `Malformed spawn: definitionOfDone must be at most ${DONE_MAX} characters` };
  }
  if (row.agentId !== undefined) {
    if (typeof row.agentId !== 'string' || !row.agentId.trim() || row.agentId.trim().length > AGENT_MAX) {
      return { error: 'Malformed spawn: agentId must be a nonempty string of at most 100 characters' };
    }
  }
  const spawn: TaskSpawn = { title, definitionOfDone };
  if (typeof row.agentId === 'string') spawn.agentId = row.agentId.trim();
  return { spawn };
}
