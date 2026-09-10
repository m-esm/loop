import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/app';
import { Database } from '../src/database';
import { OPERATOR, seedOperator } from '../src/session-seed';

export { OPERATOR };

export async function startAuthedApp(): Promise<{
  app: INestApplication;
  url: string;
  token: string;
  cookie: string;
  principalId: string;
}> {
  const app = await createApp(false);
  await app.listen(0, '127.0.0.1');
  const seeded = seedOperator(app.get(Database).sqlite);
  return {
    app,
    url: `${await app.getUrl()}/api`,
    token: seeded.token,
    cookie: `loop_session=${seeded.token}`,
    principalId: seeded.principalId,
  };
}

export function jsonHeaders(cookie: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Cookie: cookie };
}
