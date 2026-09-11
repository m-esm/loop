import {
  BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException,
  OnModuleInit, UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, count, eq, gt, isNull, lte } from 'drizzle-orm';
import type { Request } from 'express';
import { loadAgents } from './agents';
import {
  clearSessionCookie, hashPassword, hashToken, newToken, readCookie, SESSION_COOKIE,
  sessionCookie, sessionExpiry, verifyPassword,
} from './auth-crypto';
import { Database } from './database';
import { roomSlug } from './field';
import { syncAgentPrincipals } from './principals';
import { syncCatalogRoomAgents } from './room-agents';
import { credentials, invites, principals, roomMembers, rooms, sessions } from './schema';

const INVITE_INVALID = 'That invite is not valid';

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

  listRooms(principalId: string): { id: string; name: string; role: 'owner' | 'member' }[] {
    return this.database.db.select({
      id: rooms.id,
      name: rooms.name,
      role: roomMembers.role,
    }).from(roomMembers)
      .innerJoin(rooms, eq(rooms.id, roomMembers.roomId))
      .where(eq(roomMembers.principalId, principalId))
      .all()
      .map((row) => ({ id: row.id, name: row.name, role: row.role as 'owner' | 'member' }));
  }

  createRoom(principalId: string, name: string): { id: string; name: string; role: 'owner' } {
    const id = roomSlug(name);
    return this.database.sqlite.transaction(() => {
      try {
        this.database.db.insert(rooms).values({ id, name }).run();
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (/unique/i.test(message)) throw new ConflictException('A room with this id already exists');
        throw error;
      }
      this.database.db.insert(roomMembers).values({
        roomId: id, principalId, role: 'owner',
      }).run();
      syncCatalogRoomAgents(this.database, loadAgents(), id);
      return { id, name, role: 'owner' as const };
    })();
  }

  /**
   * An unknown room is a bad request, not a 404: `roomId` arrives in the body
   * beside the other fields, so it is validated like them. Membership on a real
   * room is the separate, forbidden-shaped question below.
   */
  assertRoom(room: string) {
    const row = this.database.db.select({ id: rooms.id }).from(rooms)
      .where(eq(rooms.id, room)).get();
    if (!row) throw new BadRequestException('roomId must be an existing room');
  }

  membership(principalId: string, room: string): { role: 'owner' | 'member' } {
    this.assertRoom(room);
    const row = this.database.db.select({ role: roomMembers.role }).from(roomMembers)
      .where(and(eq(roomMembers.principalId, principalId), eq(roomMembers.roomId, room))).get();
    if (!row) throw new ForbiddenException('Not a member of this room');
    return { role: row.role as 'owner' | 'member' };
  }

  /** Membership is not ownership. Registering an agent runs code, so it is administration. */
  requireOwner(principalId: string, room: string) {
    const { role } = this.membership(principalId, room);
    if (role !== 'owner') throw new ForbiddenException('Only a room owner can do this');
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

  register(input: {
    email: string; password: string; displayName: string; inviteToken?: string;
  }): { token: string; principal: Principal } {
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
      const invite = input.inviteToken ? this.validInvite(input.inviteToken, email) : null;
      const humans = this.database.db.select({ n: count() }).from(principals)
        .where(eq(principals.kind, 'human')).get()?.n ?? 0;
      if (!invite && humans > 0 && process.env.LOOP_ALLOW_REGISTER !== '1') {
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
        roomId: invite ? invite.roomId : 'default',
        principalId: id,
        role: invite ? invite.role : (humans === 0 ? 'owner' : 'member'),
      }).run();
      if (invite) {
        const accepted = this.database.db.update(invites).set({ acceptedAt: ts })
          .where(and(eq(invites.id, invite.id), isNull(invites.acceptedAt))).run();
        if (accepted.changes !== 1) throw new BadRequestException(INVITE_INVALID);
      }
      const token = this.createSession(id, ts);
      return { token, principal: { id, kind: 'human' as const, displayName, email } };
    })();
  }

  createInvite(principalId: string, room: string, emailInput: string, roleInput: string): {
    id: string; email: string; role: 'owner' | 'member'; token: string;
  } {
    this.requireOwner(principalId, room);
    const email = normalizeEmail(emailInput);
    if (!email || !email.includes('@') || email.length > 254) {
      throw new BadRequestException('email must be a valid address of at most 254 characters');
    }
    const role = inviteRole(roleInput);
    return this.database.sqlite.transaction(() => {
      const now = new Date().toISOString();
      this.database.db.delete(invites).where(and(
        eq(invites.roomId, room),
        eq(invites.email, email),
        isNull(invites.acceptedAt),
        lte(invites.expiresAt, now),
      )).run();
      const token = newToken();
      const id = randomUUID();
      try {
        this.database.db.insert(invites).values({
          id,
          roomId: room,
          email,
          role,
          tokenHash: hashToken(token),
          invitedBy: principalId,
          createdAt: now,
          expiresAt: sessionExpiry().toISOString(),
        }).run();
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (/unique/i.test(message)) {
          throw new BadRequestException('An invite for this email is already pending');
        }
        throw error;
      }
      return { id, email, role, token };
    })();
  }

  listInvites(principalId: string, room: string): {
    id: string; email: string; role: 'owner' | 'member'; createdAt: string; expiresAt: string;
  }[] {
    this.requireOwner(principalId, room);
    const now = new Date().toISOString();
    return this.database.db.select({
      id: invites.id,
      email: invites.email,
      role: invites.role,
      createdAt: invites.createdAt,
      expiresAt: invites.expiresAt,
    }).from(invites).where(and(
      eq(invites.roomId, room),
      isNull(invites.acceptedAt),
      gt(invites.expiresAt, now),
    )).all().map((row) => ({
      id: row.id,
      email: row.email,
      role: row.role as 'owner' | 'member',
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    }));
  }

  revokeInvite(principalId: string, room: string, id: string): { ok: true } {
    this.requireOwner(principalId, room);
    const row = this.database.db.delete(invites)
      .where(and(eq(invites.id, id), eq(invites.roomId, room)))
      .returning({ id: invites.id }).get();
    if (!row) throw new NotFoundException('Invite not found');
    return { ok: true };
  }

  listMembers(principalId: string, room: string): {
    members: { principalId: string; displayName: string; email: string | null; role: 'owner' | 'member' }[];
    role: 'owner' | 'member';
  } {
    const { role } = this.membership(principalId, room);
    const members = this.database.db.select({
      principalId: roomMembers.principalId,
      displayName: principals.displayName,
      email: credentials.email,
      role: roomMembers.role,
    }).from(roomMembers)
      .innerJoin(principals, eq(principals.id, roomMembers.principalId))
      .leftJoin(credentials, eq(credentials.principalId, principals.id))
      .where(and(eq(roomMembers.roomId, room), eq(principals.kind, 'human')))
      .all()
      .map((row) => ({
        principalId: row.principalId,
        displayName: row.displayName,
        email: row.email ?? null,
        role: row.role as 'owner' | 'member',
      }));
    return { members, role };
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

  private validInvite(token: string, email: string): {
    id: string; roomId: string; role: 'owner' | 'member';
  } {
    const now = new Date().toISOString();
    const row = this.database.db.select({
      id: invites.id,
      roomId: invites.roomId,
      role: invites.role,
      email: invites.email,
      acceptedAt: invites.acceptedAt,
      expiresAt: invites.expiresAt,
    }).from(invites).where(eq(invites.tokenHash, hashToken(token))).get();
    if (!row || row.acceptedAt || row.expiresAt <= now || row.email !== email) {
      throw new BadRequestException(INVITE_INVALID);
    }
    return { id: row.id, roomId: row.roomId, role: row.role as 'owner' | 'member' };
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

function inviteRole(value: string): 'owner' | 'member' {
  if (value === 'owner' || value === 'member') return value;
  throw new BadRequestException('role must be owner or member');
}
