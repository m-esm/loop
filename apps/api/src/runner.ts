import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { setImmediate as defer, setInterval, setTimeout, clearInterval, clearTimeout } from 'node:timers';
import { INITIAL_STATUS } from '@loop/types';
import { EventBus } from './bus';
import { RunFenceError, TaskStore } from './task-store';

export const ECHO_AGENT = { id: 'echo', name: 'Echo' } as const;
const WALL_MS = 30_000;
const ECHO_GAP_MS = 300;
const PROGRESS_MIN_INTERVAL_MS = 500;

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('timed out'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('timed out'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

@Injectable()
export class TaskRunner implements OnModuleInit, OnModuleDestroy {
  private busy = false;
  private started = false;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void) | undefined;
  private workAbort: AbortController | undefined;

  constructor(
    @Inject(TaskStore) private readonly store: TaskStore,
    @Inject(EventBus) private readonly bus: EventBus,
  ) {}

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
      if (event.kind === 'task_created') this.wake();
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
    const next = this.store.list().tasks.filter((task) => task.status === INITIAL_STATUS).at(-1);
    if (!next) return;
    const claimed = this.store.claim(next.id, ECHO_AGENT.id);
    if (!claimed?.runId) return;
    this.busy = true;
    defer(() => { void this.execute(claimed.id, claimed.runId!, claimed.title); });
  }

  private async execute(id: string, runId: string, title: string) {
    const fail = title.startsWith('FAIL:');
    const lines = fail ? ['Echo started', 'Echo failed'] : ['Echo started', 'Echo working', 'Echo finished'];
    const abort = new AbortController();
    this.workAbort = abort;
    const wall = setTimeout(() => abort.abort(), WALL_MS);
    const pending: string[] = [];
    let lastProgress = 0;
    const flush = () => {
      if (!pending.length) return;
      this.store.progress(id, runId, pending.splice(0, pending.length));
      lastProgress = Date.now();
    };
    try {
      for (const line of lines) {
        if (this.stopped) throw new Error('timed out');
        pending.push(line);
        if (lastProgress === 0 || Date.now() - lastProgress >= PROGRESS_MIN_INTERVAL_MS) flush();
        await sleep(ECHO_GAP_MS, abort.signal);
      }
      flush();
      if (fail) {
        this.store.finish(id, runId, { status: 'failed', error: title.slice(5).trim() || title });
      } else {
        this.store.finish(id, runId, { status: 'done', result: `Echo: ${title}` });
      }
    } catch (error) {
      if (!this.stopped) {
        try { flush(); } catch (flushError) {
          if (!(flushError instanceof RunFenceError)) throw flushError;
        }
        const message = error instanceof Error ? error.message : 'failed';
        this.store.finish(id, runId, { status: 'failed', error: message });
      }
    } finally {
      clearTimeout(wall);
      if (this.workAbort === abort) this.workAbort = undefined;
      this.busy = false;
      if (!this.stopped) this.wake();
    }
  }
}
