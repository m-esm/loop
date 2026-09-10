import { Logger } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type AgentConfig = {
  id: string;
  name: string;
  command: string[];
  /** Where the command runs. Defaults to a temp dir, never the API's cwd. */
  cwd?: string;
};

const logger = new Logger('Agents');
let warnedMissing = false;

export function agentsPath(): string {
  if (process.env.LOOP_AGENTS_PATH) return process.env.LOOP_AGENTS_PATH;
  let dir = process.cwd();
  for (;;) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
        if (pkg.name === 'loop') return join(dir, 'agents.json');
      } catch {
        // keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return join(process.cwd(), 'agents.json');
    dir = parent;
  }
}

export function loadAgents(path = agentsPath()): AgentConfig[] {
  if (!existsSync(path)) {
    if (!warnedMissing) {
      warnedMissing = true;
      logger.warn(`agents file missing at ${path}; no tasks will run`);
    }
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'invalid JSON';
    throw new Error(`Malformed agents file at ${path}: ${reason}`);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { agents?: unknown }).agents)) {
    throw new Error(`Malformed agents file at ${path}: expected { agents: [...] }`);
  }
  const rows = (parsed as { agents: unknown[] }).agents;
  const ids = new Set<string>();
  const agents: AgentConfig[] = [];
  for (const [index, item] of rows.entries()) {
    if (!item || typeof item !== 'object') {
      throw new Error(`Malformed agents file at ${path}: agents[${index}] is not an object`);
    }
    const row = item as Record<string, unknown>;
    if (typeof row.id !== 'string' || row.id.length === 0) {
      throw new Error(`Malformed agents file at ${path}: agents[${index}].id must be a nonempty string`);
    }
    if (typeof row.name !== 'string' || row.name.length === 0) {
      throw new Error(`Malformed agents file at ${path}: agents[${index}].name must be a nonempty string`);
    }
    if (!Array.isArray(row.command) || row.command.length === 0 || row.command.some((part) => typeof part !== 'string')) {
      throw new Error(`Malformed agents file at ${path}: agents[${index}].command must be a nonempty array of strings`);
    }
    if (row.cwd !== undefined && (typeof row.cwd !== 'string' || row.cwd.length === 0)) {
      throw new Error(`Malformed agents file at ${path}: agents[${index}].cwd must be a nonempty string`);
    }
    if (ids.has(row.id)) {
      throw new Error(`Malformed agents file at ${path}: duplicate agent id ${row.id}`);
    }
    ids.add(row.id);
    agents.push({ id: row.id, name: row.name, command: row.command as string[], ...(row.cwd ? { cwd: row.cwd as string } : {}) });
  }
  return agents;
}
