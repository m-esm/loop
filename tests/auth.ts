import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { APIRequestContext, Browser, BrowserContext } from '@playwright/test';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { OPERATOR, seedOperator } from '../apps/api/src/session-seed';

export { OPERATOR };

export function seedSession(dbPath: string): ReturnType<typeof seedOperator> {
  mkdirSync(dirname(dbPath), { recursive: true });
  const sqlite = new Sqlite(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  migrate(drizzle(sqlite), { migrationsFolder: resolve('apps/api/migrations') });
  const seeded = seedOperator(sqlite);
  sqlite.close();
  return seeded;
}

export function cookieHeader(token: string): { Cookie: string } {
  return { Cookie: `loop_session=${token}` };
}

export function withAuth(request: APIRequestContext, token: string) {
  const headers = cookieHeader(token);
  return {
    get: (url: string, options?: Parameters<APIRequestContext['get']>[1]) =>
      request.get(url, { ...options, headers: { ...headers, ...(options?.headers as Record<string, string> | undefined) } }),
    post: (url: string, options?: Parameters<APIRequestContext['post']>[1]) =>
      request.post(url, { ...options, headers: { ...headers, ...(options?.headers as Record<string, string> | undefined) } }),
    patch: (url: string, options?: Parameters<APIRequestContext['patch']>[1]) =>
      request.patch(url, { ...options, headers: { ...headers, ...(options?.headers as Record<string, string> | undefined) } }),
  };
}

export async function authedContext(browser: Browser, token: string): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{
    name: 'loop_session',
    value: token,
    domain: '127.0.0.1',
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
  }]);
  return context;
}
