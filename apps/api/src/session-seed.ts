import { randomUUID } from 'node:crypto';
import type Sqlite from 'better-sqlite3';
import { hashPassword, hashToken, newToken, sessionExpiry } from './auth-crypto';

export const OPERATOR = {
  email: 'operator@loop.local',
  password: 'test-password-ok',
  displayName: 'Moshe',
};

/** Insert a human owner of the default room plus a live session. Caller migrates first. */
export function seedOperator(sqlite: Sqlite.Database, opts?: { token?: string }): {
  token: string;
  principalId: string;
  email: string;
  password: string;
  displayName: string;
} {
  const token = opts?.token ?? newToken();
  const principalId = randomUUID();
  const ts = new Date().toISOString();
  const expires = sessionExpiry().toISOString();
  sqlite.prepare(
    'INSERT INTO principals (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)',
  ).run(principalId, 'human', OPERATOR.displayName, ts);
  sqlite.prepare(
    'INSERT INTO credentials (principal_id, email, password_hash, created_at) VALUES (?, ?, ?, ?)',
  ).run(principalId, OPERATOR.email, hashPassword(OPERATOR.password), ts);
  sqlite.prepare(
    'INSERT INTO sessions (token_hash, principal_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run(hashToken(token), principalId, ts, expires);
  sqlite.prepare(
    'INSERT INTO room_members (room_id, principal_id, role) VALUES (?, ?, ?)',
  ).run('default', principalId, 'owner');
  return { token, principalId, email: OPERATOR.email, password: OPERATOR.password, displayName: OPERATOR.displayName };
}
