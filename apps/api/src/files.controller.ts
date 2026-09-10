import {
  BadRequestException, Controller, Get, Inject, Param, Post, Req, Res, StreamableFile, UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { createReadStream, unlinkSync } from 'node:fs';
import { actor, AuthService } from './auth';
import { roomId } from './field';
import {
  contentDisposition, FileStore, MAX_FILE_BYTES, roomFileStorage, type StoredUpload,
} from './files';

@Controller('rooms/:room/files')
export class FilesController {
  constructor(
    @Inject(FileStore) private readonly files: FileStore,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  @Get()
  list(@Param('room') roomParam: string, @Req() req: Request) {
    const room = roomId(roomParam);
    this.auth.membership(actor(req).id, room);
    return { files: this.files.list(room) };
  }

  @Post()
  @UseInterceptors(FileInterceptor('file', {
    limits: { fileSize: MAX_FILE_BYTES, files: 1 },
    preservePath: true,
    storage: roomFileStorage(),
  }))
  upload(
    @Param('room') roomParam: string,
    @UploadedFile() file: StoredUpload | undefined,
    @Req() req: Request,
  ) {
    const room = roomId(roomParam);
    const principal = actor(req);
    try {
      this.auth.membership(principal.id, room);
      if (!file) throw new BadRequestException('file is required');
      return this.files.saveUpload(room, principal, file);
    } catch (error) {
      if (file?.path) {
        try { unlinkSync(file.path); } catch { /* already gone */ }
      }
      throw error;
    }
  }

  @Get(':id/content')
  content(
    @Param('room') roomParam: string,
    @Param('id') id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const room = roomId(roomParam);
    this.auth.membership(actor(req).id, room);
    const row = this.files.getInRoom(room, id);
    const abs = this.files.absolutePath(row);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', contentDisposition(row.name));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(createReadStream(abs));
  }
}
