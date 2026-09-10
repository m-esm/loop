import {
  BadRequestException, ForbiddenException, Inject, Injectable, OnModuleInit, UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, count, eq, isNull } from 'drizzle-orm';
import type { Request } from 'express';
import { loadAgents } from './agents';
import {
  clearSessionCookie, hashPassword, hashToken, newToken, readCookie, SESSION_COOKIE,
  sessionCookie, sessionExpiry, verifyPassword,
} from './auth-crypto';
import { Database } from './database';
import { syncAgentPrincipals } from './principals';
import { credentials, principals, roomMembers, sessions } from './schema';

export type Principal = {
  id: string;
  kind: 'human' | 'agent';
  displayName: string;
  email: string | null;
};

export type AuthedRequest = Request & {
  principal: Principal;
  sessionTokenHash: string;
};

export function actor(req: Request): Principal {
  const principal = (req as AuthedRequest).principal;
  if (!principal) throw new UnauthorizedException();
  return principal;
}

export function requireHuman(req: Request): Principal {
  const principal = actor(req);
  if (principal.kind !== 'human') {
    throw new ForbiddenException('A human must make this decision');
  }
  return principal;
}

@Injectable()
export class AuthService implements OnModuleInit {
  constructor(@Inject(Database) private readonly database: Database) {}

  onModuleInit() {
    syncAgentPrincipals(this.database, loadAgents());
  }

  authenticate(cookieHeader: string | undefined): { principal: Principal; tokenHash: string } | null {
    const token = readCookie(cookieHeader, SESSION_COOKIE);
    if (!token) return null;
    return this.liveSession(hashToken(token));
  }

  isSessionLive(tokenHash: string): boolean {
    return this.liveSession(tokenHash) !== null;
  }

  roomIds(principalId: string): string[] {
    return this.database.db.select({ roomId: roomMembers.roomId }).from(roomMembers)
      .where(eq(roomMembers.principalId, principalId)).all().map((row) => row.roomId);
  }

  me(principalId: string): Principal {
    const row = this.database.db.select({
      id: principals.id,
      kind: principals.kind,
      displayName: principals.displayName,
      email: credentials.email,
    }).from(principals)
      .leftJoin(credentials, eq(credentials.principalId, principals.id))
      .where(eq(principals.id, principalId)).get();
    if (!row) throw new UnauthorizedException();
    return { id: row.id, kind: row.kind, displayName: row.displayName, email: row.email ?? null };
  }

  register(input: { email: string; password: string; displayName: string }): { token: string; principal: Principal } {
    const email = normalizeEmail(input.email);
    const displayName = input.displayName.trim();
    const password = input.password;
    if (!email || !email.includes('@') || email.length > 254) {
      throw new BadRequestException('email must be a valid address of at most 254 characters');
    }
    if (displayName.length < 1 || displayName.length > 100) {
      throw new BadRequestException('displayName must be nonempty text of at most 100 characters');
    }
    if (password.length < 8 || password.length > 200) {
      throw new BadRequestException('password must be 8 to 200 characters');
    }
    return this.database.sqlite.transaction(() => {
      const humans = this.database.db.select({ n: count() }).from(principals)
        .where(eq(principals.kind, 'human')).get()?.n ?? 0;
      if (humans > 0 && process.env.LOOP_ALLOW_REGISTER !== '1') {
        throw new ForbiddenException('Registration is closed');
      }
      const ts = new Date().toISOString();
      const id = randomUUID();
      try {
        this.database.db.insert(principals).values({
          id, kind: 'human', displayName, createdAt: ts,
        }).run();
        this.database.db.insert(credentials).values({
          principalId: id, email, passwordHash: hashPassword(password), createdAt: ts,
        }).run();
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (/unique/i.test(message)) throw new ForbiddenException('email is already registered');
        throw error;
      }
      this.database.db.insert(roomMembers).values({
        roomId: 'default', principalId: id, role: humans === 0 ? 'owner' : 'member',
      }).run();
      const token = this.createSession(id, ts);
      return { token, principal: { id, kind: 'human' as const, displayName, email } };
    })();
  }

  login(input: { email: string; password: string }): { token: string; principal: Principal } {
    const email = normalizeEmail(input.email);
    const row = this.database.db.select({
      principalId: credentials.principalId,
      passwordHash: credentials.passwordHash,
      kind: principals.kind,
      displayName: principals.displayName,
      disabledAt: principals.disabledAt,
    }).from(credentials)
      .innerJoin(principals, eq(principals.id, credentials.principalId))
      .where(eq(credentials.email, email)).get();
    if (!row || row.kind !== 'human' || row.disabledAt || !verifyPassword(input.password, row.passwordHash)) {
      throw new UnauthorizedException('Invalid email or password');
    }
    const ts = new Date().toISOString();
    const token = this.createSession(row.principalId, ts);
    return {
      token,
      principal: { id: row.principalId, kind: 'human', displayName: row.displayName, email },
    };
  }

  logout(tokenHash: string) {
    const ts = new Date().toISOString();
    this.database.db.update(sessions).set({ revokedAt: ts })
      .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt))).run();
  }

  setSessionCookie(token: string): string {
    return sessionCookie(token);
  }

  clearCookie(): string {
    return clearSessionCookie();
  }

  private createSession(principalId: string, ts: string): string {
    const token = newToken();
    this.database.db.insert(sessions).values({
      tokenHash: hashToken(token),
      principalId,
      createdAt: ts,
      expiresAt: sessionExpiry().toISOString(),
    }).run();
    return token;
  }

  private liveSession(tokenHash: string): { principal: Principal; tokenHash: string } | null {
    const now = new Date().toISOString();
    const row = this.database.db.select({
      tokenHash: sessions.tokenHash,
      expiresAt: sessions.expiresAt,
      revokedAt: sessions.revokedAt,
      id: principals.id,
      kind: principals.kind,
      displayName: principals.displayName,
      disabledAt: principals.disabledAt,
      email: credentials.email,
    }).from(sessions)
      .innerJoin(principals, eq(principals.id, sessions.principalId))
      .leftJoin(credentials, eq(credentials.principalId, principals.id))
      .where(eq(sessions.tokenHash, tokenHash)).get();
    if (!row || row.revokedAt || row.disabledAt || row.expiresAt <= now) return null;
    return {
      tokenHash: row.tokenHash,
      principal: {
        id: row.id, kind: row.kind, displayName: row.displayName, email: row.email ?? null,
      },
    };
  }
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}
