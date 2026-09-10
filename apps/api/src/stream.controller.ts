import { BadRequestException, Controller, Get, Inject, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService, type AuthedRequest } from './auth';
import { EventBus } from './bus';

const SESSION_POLL_MS = 200;

/** Port of 3DVP stream/route.ts, using the raw Nest response for comment heartbeats. */
@Controller('stream')
export class StreamController {
  constructor(
    @Inject(EventBus) private readonly bus: EventBus,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  @Get()
  stream(@Query('since') since: unknown, @Req() req: Request, @Res() res: Response) {
    const authed = req as AuthedRequest;
    if (!authed.principal || !authed.sessionTokenHash) throw new UnauthorizedException();
    const rooms = this.auth.roomIds(authed.principal.id);
    const tokenHash = authed.sessionTokenHash;
    const raw = since ?? req.headers['last-event-id'] ?? '0';
    if (typeof raw !== 'string' || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      throw new BadRequestException('since must be a nonnegative event id');
    }
    let cursor = Number(raw);
    let closed = false;
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
      'Content-Encoding': 'identity',
    });
    res.flushHeaders();
    const send = async (chunk: string) => {
      if (closed || res.destroyed) return;
      if (!res.write(chunk)) {
        await new Promise<void>((resolve) => {
          const ready = () => {
            res.off('drain', ready);
            res.off('close', ready);
            resolve();
          };
          res.once('drain', ready);
          res.once('close', ready);
        });
      }
    };
    const drop = () => {
      if (closed) return;
      closed = true;
      res.end();
    };
    let pumping = false;
    const pump = async () => {
      if (pumping || closed) return;
      if (!this.auth.isSessionLive(tokenHash)) { drop(); return; }
      pumping = true;
      try {
        // SQLite is the durable queue. Live bus signals drain it without polling.
        // Re-query after each page so events arriving during a drain wait survive.
        while (!closed && !res.destroyed) {
          const replay = this.bus.since(cursor, rooms);
          if (!replay.length) break;
          for (const event of replay) {
            if (closed || res.destroyed) break;
            await send(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
            cursor = event.id;
          }
        }
      } catch { res.destroy(); }
      finally { pumping = false; }
    };
    const unsubscribe = this.bus.subscribe((event) => {
      if (!rooms.includes(event.room_id)) return;
      void pump();
    });
    const heartbeat = setInterval(() => {
      if (!this.auth.isSessionLive(tokenHash)) { drop(); return; }
      if (!pumping && !res.writableNeedDrain) void send(': heartbeat\n\n');
    }, 25_000);
    const watch = setInterval(() => {
      if (!this.auth.isSessionLive(tokenHash)) drop();
    }, SESSION_POLL_MS);
    res.on('close', () => {
      closed = true;
      clearInterval(heartbeat);
      clearInterval(watch);
      unsubscribe();
    });
    void pump();
  }
}
