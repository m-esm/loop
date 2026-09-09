import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

@Injectable()
export class Database implements OnModuleDestroy {
  readonly sqlite: Sqlite.Database;
  readonly db;

  constructor() {
    const path = process.env.DATABASE_PATH ?? resolve(process.cwd(), 'data/loop.sqlite');
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.sqlite = new Sqlite(path);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    this.db = drizzle(this.sqlite);
    migrate(this.db, { migrationsFolder: resolve(process.cwd(), 'migrations') });
  }

  onModuleDestroy() { this.sqlite.close(); }
}
