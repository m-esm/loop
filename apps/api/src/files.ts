import { BadRequestException, Inject, Injectable, NotFoundException, OnModuleInit, PayloadTooLargeException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, readFileSync, unlink, unlinkSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import type { RoomFile } from '@loop/types';
import type { Principal } from './auth';
import { Database } from './database';
import { roomId } from './field';
import { files } from './schema';
import { MessageStore } from './message-store';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export function filesRoot(): string {
  return process.env.LOOP_FILES_PATH ?? resolve(process.cwd(), 'data/files');
}

export function ensureFilesRoot() {
  mkdirSync(filesRoot(), { recursive: true });
}

export function listTaskFiles(database: Database, room: string): { id: string; name: string; path: string }[] {
  return database.db.select().from(files).where(eq(files.roomId, room)).all().map((row) => ({
    id: row.id,
    name: row.name,
    path: resolve(filesRoot(), row.storedPath),
  }));
}

function tooLarge(): Error {
  const error = new Error('File too large');
  (error as Error & { code: string }).code = 'LIMIT_FILE_SIZE';
  return error;
}

export type StoredUpload = {
  originalname: string;
  mimetype: string;
  size: number;
  path: string;
  filename: string;
  sha256?: string;
};

export function roomFileStorage() {
  return {
    _handleFile(
      req: { params: { room?: string } },
      file: { stream: NodeJS.ReadableStream },
      cb: (error: Error | null, info?: { path: string; size: number; filename: string; destination: string }) => void,
    ) {
      let room: string;
      try {
        room = roomId(req.params.room);
      } catch (error) {
        cb(error instanceof Error ? error : new Error('Unknown room'));
        return;
      }
      const filename = randomUUID();
      const destination = join(filesRoot(), room);
      mkdirSync(destination, { recursive: true });
      const path = join(destination, filename);
      const hash = createHash('sha256');
      let size = 0;
      let settled = false;
      const out = createWriteStream(path);
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        if ('destroy' in file.stream && typeof file.stream.destroy === 'function') {
          file.stream.destroy(error);
        }
        out.destroy();
        unlink(path, () => cb(error));
      };
      out.on('error', fail);
      file.stream.on('error', (error: Error) => fail(error));
      file.stream.on('data', (chunk: Buffer | string) => {
        if (settled) return;
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        size += buf.length;
        if (size > MAX_FILE_BYTES) {
          fail(tooLarge());
          return;
        }
        hash.update(buf);
        if (!out.write(buf) && 'pause' in file.stream && typeof file.stream.pause === 'function') {
          file.stream.pause();
        }
      });
      out.on('drain', () => {
        if ('resume' in file.stream && typeof file.stream.resume === 'function') file.stream.resume();
      });
      file.stream.on('end', () => {
        if (settled) return;
        out.end(() => {
          if (settled) return;
          settled = true;
          (file as { sha256?: string }).sha256 = hash.digest('hex');
          cb(null, { path, size, filename, destination });
        });
      });
    },
    _removeFile(_req: unknown, file: { path: string }, cb: (error: Error | null) => void) {
      unlink(file.path, () => cb(null));
    },
  };
}

function displayName(original: string): string {
  const trimmed = original.trim() || 'file';
  return trimmed.slice(0, 255);
}

export function contentDisposition(name: string): string {
  const base = name.replace(/["\r\n]/g, '_').slice(0, 200) || 'file';
  return `attachment; filename="${base}"`;
}

function toPublic(row: typeof files.$inferSelect): RoomFile {
  return {
    id: row.id,
    roomId: row.roomId,
    name: row.name,
    size: row.size,
    contentType: row.contentType,
    sha256: row.sha256,
    uploadedBy: row.uploadedBy,
    createdAt: row.createdAt,
  };
}

@Injectable()
export class FileStore implements OnModuleInit {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(MessageStore) private readonly messages: MessageStore,
  ) {}

  onModuleInit() { ensureFilesRoot(); }

  list(room: string): RoomFile[] {
    return this.database.db.select().from(files).where(eq(files.roomId, room))
      .orderBy(asc(files.createdAt), asc(files.id)).all().map(toPublic);
  }

  getInRoom(room: string, id: string) {
    const row = this.database.db.select().from(files)
      .where(and(eq(files.id, id), eq(files.roomId, room))).get();
    if (!row) throw new NotFoundException('File not found');
    return row;
  }

  absolutePath(row: { storedPath: string; roomId: string }): string {
    const root = resolve(filesRoot());
    const roomRoot = resolve(root, row.roomId);
    const abs = resolve(root, row.storedPath);
    const prefix = roomRoot.endsWith(sep) ? roomRoot : roomRoot + sep;
    if (abs !== roomRoot && !abs.startsWith(prefix)) throw new NotFoundException('File not found');
    return abs;
  }

  saveUpload(room: string, principal: Principal, file: StoredUpload): RoomFile {
    if (file.size > MAX_FILE_BYTES) {
      unlinkQuiet(file.path);
      throw new PayloadTooLargeException('File too large');
    }
    const storedPath = `${room}/${file.filename}`;
    const expected = resolve(filesRoot(), storedPath);
    if (resolve(file.path) !== expected) {
      unlinkQuiet(file.path);
      throw new BadRequestException('file could not be stored');
    }
    const sha256 = file.sha256
      ?? createHash('sha256').update(readFileSync(file.path)).digest('hex');
    const id = file.filename;
    const ts = new Date().toISOString();
    try {
      this.database.db.insert(files).values({
        id,
        roomId: room,
        name: displayName(file.originalname),
        size: file.size,
        contentType: (file.mimetype || 'application/octet-stream').slice(0, 100),
        sha256,
        storedPath,
        uploadedBy: principal.id,
        createdAt: ts,
      }).run();
    } catch (error) {
      unlinkQuiet(file.path);
      throw error;
    }
    try {
      this.messages.attachFile(room, principal.displayName, id, principal.id);
    } catch (error) {
      this.database.db.delete(files).where(eq(files.id, id)).run();
      unlinkQuiet(file.path);
      throw error;
    }
    return toPublic(this.getInRoom(room, id));
  }
}

function unlinkQuiet(path: string) {
  try { unlinkSync(path); } catch { /* already gone */ }
}
