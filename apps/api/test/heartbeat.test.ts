import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { StreamController } from '../src/stream.controller';
import type { EventBus } from '../src/bus';

test('SSE sends a comment at 25 seconds and cleans up on disconnect', (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const response = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const frames: string[] = [];
  let unsubscribed = false;
  response.status = () => response;
  response.set = () => response;
  response.flushHeaders = () => {};
  response.write = (chunk: string) => { frames.push(chunk); return true; };
  const bus = {
    since: () => [],
    subscribe: () => () => { unsubscribed = true; },
  } as unknown as EventBus;
  new StreamController(bus).stream('0', { headers: {} } as Request, response as unknown as Response);
  context.mock.timers.tick(24_999);
  assert.deepEqual(frames, []);
  context.mock.timers.tick(1);
  assert.deepEqual(frames, [': heartbeat\n\n']);
  response.emit('close');
  assert.equal(unsubscribed, true);
  context.mock.timers.tick(25_000);
  assert.equal(frames.length, 1);
});
