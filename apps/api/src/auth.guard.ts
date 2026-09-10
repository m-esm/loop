import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService, type AuthedRequest } from './auth';

const PUBLIC = new Set([
  '/api/auth/register', '/api/auth/login', '/api/health',
  '/auth/register', '/auth/login', '/health',
]);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const path = (req.originalUrl ?? req.url).split('?')[0];
    if (PUBLIC.has(path)) return true;
    const session = this.auth.authenticate(header(req.headers.cookie));
    if (!session) throw new UnauthorizedException();
    const authed = req as AuthedRequest;
    authed.principal = session.principal;
    authed.sessionTokenHash = session.tokenHash;
    return true;
  }
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join('; ') : value;
}
