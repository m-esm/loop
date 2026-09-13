import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { setImmediate as defer, setInterval, setTimeout, clearInterval, clearTimeout } from 'node:timers';
import type { Readable } from 'node:stream';
import { INITIAL_STATUS, parseTaskProposal, parseTaskSpawn, type Task } from '@loop/types';
import { loadAgents, type AgentConfig } from './agents';
import { listRoomAgents, syncCatalogRoomAgents } from './room-agents';
import { EventBus } from './bus';
import { MessageStore } from './message-store';
import { syncAgentPrincipals } from './principals';
import { listTaskFiles } from './files';
import { RunFenceError, TaskStore } from './task-store';
import { and, eq, isNull, isNotNull } from 'drizzle-orm';
import { rooms } from './schema';

const PROGRESS_MIN_INTERVAL_MS = 500;
const ASK_PREFIX = 'LOOP_ASK: ';
const PROPOSE_PREFIX = 'LOOP_PROPOSE: ';
const SPAWN_PREFIX = 'LOOP_SPAWN: ';

function wallMs() {
  const value = Number(process.env.LOOP_WALL_MS);
  return Number.isFinite(value) && value > 0 ? value : 30_000;
}

function attachLines(stream: Readable, onLine: (line: string) => void): () => void {
  let buffer = '';
  const emit = (line: string) => {
    onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
  };
  const drain = (flushTail: boolean) => {
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      emit(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
    if (flushTail && buffer.length) {
      emit(buffer);
      buffer = '';
    }
  };
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    drain(false);
  });
  return () => drain(true);
}

@Injectable()
export class TaskRunner implements OnModuleInit, OnModuleDestroy {
  private busy = false;
  private started = false;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void) | undefined;
  private workAbort: AbortController | undefined;
  private readonly agents: AgentConfig[];

  constructor(
    @Inject(TaskStore) private readonly store: TaskStore,
    @Inject(EventBus) private readonly bus: EventBus,
    @Inject(MessageStore) private readonly messages: MessageStore,
  ) {
    this.agents = loadAgents();
  }

  onModuleInit() {
    if (process.env.LOOP_RUNNER !== '1') return;
    this.start();
  }

  onModuleDestroy() { this.stop(); }

  start() {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    syncAgentPrincipals(this.store.database, this.agents);
    // A custom agents.json still needs a mention in the default room, or a task
    // there resolves nothing and every run fails with "no agents".
    syncCatalogRoomAgents(this.store.database, this.agents);
    this.store.reclaimLost();
    this.unsubscribe = this.bus.subscribe((event) => {
      if (event.kind === 'task_created' || event.kind === 'task_status_changed') this.wake();
    });
    this.timer = setInterval(() => this.wake(), 1000);
    this.wake();
  }

  stop() {
    this.stopped = true;
    this.started = false;
    this.workAbort?.abort();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  /** Off the EventEmitter stack so claim cannot land between task_created and message_created. */
  wake() {
    if (this.stopped) return;
    defer(() => this.claimNext());
  }

  private claimNext() {
    if (this.busy || this.stopped) return;
    const paused = new Set(this.store.database.db.select({ id: rooms.id }).from(rooms)
      .where(isNotNull(rooms.pausedAt)).all().map((room) => room.id));
    const next = this.store.list().tasks.filter((task) => task.status === INITIAL_STATUS && !paused.has(task.roomId)).at(-1);
    if (!next) return;
    const resolved = this.resolveAgent(next);
    const claimed = this.store.claim(next.id, resolved.claimedAs);
    if (!claimed?.runId) return;
    if ('error' in resolved) {
      this.store.finish(claimed.id, claimed.runId, { status: 'failed', error: resolved.error });
      this.wake();
      return;
    }
    this.startClaimed(claimed, resolved.agent);
  }

  /**
   * Agents are per room now. A task names the room's display name, which maps to a
   * catalog id; the catalog holds the command. There is no `agents[0]` default: a
   * task in a room with no agents fails loudly rather than running a stranger's
   * command that the room never registered.
   */
  private resolveAgent(task: Task): { agent: AgentConfig; claimedAs: string } | { error: string; claimedAs: string } {
    const rows = listRoomAgents(this.store.database, task.roomId);
    const known = this.agents.map((item) => item.id).join(', ') || '(none)';
    if (task.agentId) {
      const row = rows.find((item) => item.name === task.agentId);
      if (!row) {
        return { error: `Unknown agent ${task.agentId}. Known: ${known}`, claimedAs: task.agentId };
      }
      const agent = this.agents.find((item) => item.id === row.catalogId);
      if (!agent) {
        return { error: `Unknown agent ${row.catalogId}. Known: ${known}`, claimedAs: row.catalogId };
      }
      return { agent, claimedAs: row.catalogId };
    }
    const first = rows
      .map((row) => ({ row, agent: this.agents.find((item) => item.id === row.catalogId) }))
      .find((pair) => pair.agent);
    if (!first?.agent) {
      return { error: 'This room has no agents.', claimedAs: '(none)' };
    }
    return { agent: first.agent, claimedAs: first.row.catalogId };
  }

  private startClaimed(claimed: Task, agent: AgentConfig) {
    this.busy = true;
    // Claim and spawn stay on the same event-loop turn so a pause request cannot
    // land between them. The initial claim itself is already deferred by wake.
    void this.execute(claimed, agent);
  }

  private async execute(task: Task, agent: AgentConfig) {
    const id = task.id;
    const runId = task.runId!;
    const abort = new AbortController();
    this.workAbort = abort;
    const wall = setTimeout(() => abort.abort(), wallMs());
    let asked = false;
    let child: ChildProcess | undefined;
    const pending: string[] = [];
    let lastProgress = 0;
    let lastStdout: string | undefined;
    let lastStderr: string | undefined;
    const flush = () => {
      if (!pending.length) return;
      try {
        this.store.progress(id, runId, pending.splice(0, pending.length));
        lastProgress = Date.now();
      } catch (error) {
        pending.length = 0;
        if (!(error instanceof RunFenceError)) throw error;
      }
    };
    const push = (line: string, sink: 'stdout' | 'stderr') => {
      if (asked) return;
      if (line.length) {
        if (sink === 'stdout') lastStdout = line;
        else lastStderr = line;
      }
      pending.push(line);
      if (lastProgress === 0 || Date.now() - lastProgress >= PROGRESS_MIN_INTERVAL_MS) flush();
    };
    const onStdout = (line: string) => {
      if (asked) return;
      if (line.startsWith(ASK_PREFIX)) {
        flush();
        asked = true;
        try {
          this.store.ask(id, runId, line.slice(ASK_PREFIX.length));
        } catch (error) {
          if (!(error instanceof RunFenceError)) throw error;
        }
        child?.kill('SIGKILL');
        return;
      }
      if (line.startsWith(PROPOSE_PREFIX)) {
        flush();
        asked = true;
        try {
          const parsed = parseTaskProposal(line.slice(PROPOSE_PREFIX.length));
          if ('error' in parsed) {
            this.store.finish(id, runId, { status: 'failed', error: parsed.error });
          } else {
            this.store.propose(id, runId, parsed.proposal);
          }
        } catch (error) {
          if (!(error instanceof RunFenceError)) throw error;
        }
        child?.kill('SIGKILL');
        return;
      }
      if (line.startsWith(SPAWN_PREFIX)) {
        const parsed = parseTaskSpawn(line.slice(SPAWN_PREFIX.length));
        if ('error' in parsed) {
          push(parsed.error, 'stderr');
          return;
        }
        try {
          const childTask = this.store.create({
            roomId: task.roomId,
            owner: agent.name,
            ownerPrincipalId: agent.id,
            title: parsed.spawn.title,
            definitionOfDone: parsed.spawn.definitionOfDone,
            parentTaskId: id,
            ...(parsed.spawn.agentId ? { agentId: parsed.spawn.agentId } : {}),
          });
          this.messages.attachTask(task.roomId, agent.name, childTask.id, agent.id);
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'spawn failed';
          push(reason, 'stderr');
        }
        return;
      }
      push(line, 'stdout');
    };
    const onStderr = (line: string) => push(line, 'stderr');
    try {
      // Allowlist, not `{ ...process.env }`. An agent command is arbitrary code
      // from a config file; inheriting the API's environment would hand it every
      // secret the server holds. PATH and HOME are what a command needs to run.
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: process.env.LANG,
        TZ: process.env.TZ,
        LOOP_TASK_TITLE: task.title,
        LOOP_TASK_ID: task.id,
        LOOP_TASK_DONE_WHEN: task.definitionOfDone,
        LOOP_TASK_FILES: JSON.stringify(listTaskFiles(this.store.database, task.roomId)),
      };
      if (task.answer) env.LOOP_TASK_ANSWER = task.answer;
      if (task.verdictNote) env.LOOP_TASK_NOTE = task.verdictNote;
      if (task.proposalChoice) env.LOOP_TASK_CHOICE = task.proposalChoice;

      const wrapped = this.store.database.db.update(rooms).set({ wrapUp: false })
        .where(and(eq(rooms.id, task.roomId), isNull(rooms.pausedAt), eq(rooms.wrapUp, true)))
        .returning({ id: rooms.id }).get();
      if (wrapped) env.LOOP_TASK_STEERING = 'Wrap up: converge on a concrete result. Summarize the outcome and remaining blockers; avoid opening new work.';

      child = spawn(agent.command[0], agent.command.slice(1), {
        shell: false,
        env,
        // Explicit, so a child cannot write relative paths into the API's cwd.
        cwd: agent.cwd ?? tmpdir(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const closed = once(child, 'close') as Promise<[number | null, NodeJS.Signals | null]>;
      let spawnError: Error | undefined;
      child.once('error', (error: Error) => { spawnError = error; });
      const kill = () => { child?.kill('SIGKILL'); };
      if (abort.signal.aborted) kill();
      else abort.signal.addEventListener('abort', kill, { once: true });
      const flushStdout = child.stdout ? attachLines(child.stdout, onStdout) : () => {};
      const flushStderr = child.stderr ? attachLines(child.stderr, onStderr) : () => {};
      const [code, signal] = await closed;
      flushStdout();
      flushStderr();
      if (asked) return;
      if (this.stopped) return;
      if (abort.signal.aborted) {
        flush();
        this.store.finish(id, runId, { status: 'failed', error: 'timed out' });
        return;
      }
      if (spawnError) {
        flush();
        this.store.finish(id, runId, { status: 'failed', error: spawnError.message });
        return;
      }
      flush();
      if (code === 0) {
        this.store.finish(id, runId, { status: 'done', result: lastStdout || 'Exited 0' });
      } else {
        this.store.finish(id, runId, { status: 'failed', error: lastStderr || `Exited ${code ?? signal ?? 'unknown'}` });
      }
    } catch (error) {
      if (!this.stopped && !asked) {
        try { flush(); } catch (flushError) {
          if (!(flushError instanceof RunFenceError)) throw flushError;
        }
        const message = error instanceof Error ? error.message : 'failed';
        this.store.finish(id, runId, { status: 'failed', error: message });
      }
    } finally {
      clearTimeout(wall);
      child?.kill('SIGKILL');
      if (this.workAbort === abort) this.workAbort = undefined;
      this.busy = false;
      if (!this.stopped) this.wake();
    }
  }
}
