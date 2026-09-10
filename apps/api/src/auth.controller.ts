import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { actor, AuthService, type AuthedRequest } from './auth';
import { field, optionalField } from './field';

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post('register')
  register(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const result = this.auth.register({
      email: field(body, 'email', 254),
      password: field(body, 'password', 200),
      displayName: field(body, 'displayName', 100),
      inviteToken: optionalField(body, 'inviteToken', 200),
    });
    res.setHeader('Set-Cookie', this.auth.setSessionCookie(result.token));
    return result.principal;
  }

  @Post('login') @HttpCode(200)
  login(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const result = this.auth.login({
      email: field(body, 'email', 254),
      password: field(body, 'password', 200),
    });
    res.setHeader('Set-Cookie', this.auth.setSessionCookie(result.token));
    return result.principal;
  }

  @Post('logout') @HttpCode(200)
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const hash = (req as AuthedRequest).sessionTokenHash;
    if (hash) this.auth.logout(hash);
    res.setHeader('Set-Cookie', this.auth.clearCookie());
    return { ok: true };
  }

  @Get('me')
  me(@Req() req: Request) {
    return actor(req);
  }
}
