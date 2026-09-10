import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setImmediate as defer, setInterval, setTimeout, clearInterval, clearTimeout } from 'node:timers';
import type { Readable } from 'node:stream';
import { INITIAL_STATUS, type Task } from '@loop/types';
import { loadAgents, type AgentConfig } from './agents';
import { EventBus } from './bus';
import { RunFenceError, TaskStore } from './task-store';

const PROGRESS_MIN_INTERVAL_MS = 500;
const ASK_PREFIX = 'LOOP_ASK: ';

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
    const agent = this.agents[0];
    if (!agent) return;
    const next = this.store.list().tasks.filter((task) => task.status === INITIAL_STATUS).at(-1);
    if (!next) return;
    const claimed = this.store.claim(next.id, agent.id);
    if (!claimed?.runId) return;
    this.busy = true;
    defer(() => { void this.execute(claimed, agent); });
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
      push(line, 'stdout');
    };
    const onStderr = (line: string) => push(line, 'stderr');
    try {
      const env = { ...process.env };
      env.LOOP_TASK_TITLE = task.title;
      env.LOOP_TASK_ID = task.id;
      env.LOOP_TASK_DONE_WHEN = task.definitionOfDone;
      if (task.answer) env.LOOP_TASK_ANSWER = task.answer;
      else delete env.LOOP_TASK_ANSWER;

      child = spawn(agent.command[0], agent.command.slice(1), {
        shell: false,
        env,
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
