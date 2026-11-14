import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Request } from 'express';
import type Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { loadEnv } from '../../config/env';
import { AccessProfile } from '../../common/access';
import { ALLOW_PENDING_PASSWORD_KEY, IS_PUBLIC_KEY, PERMISSIONS_KEY, USERS_ONLY_KEY } from '../../common/decorators';
import { forbidden, ProblemException, unauthorised } from '../../common/problem';
import { consumeRateLimit, InjectRedis } from '../../common/redis';
import { RequestContext } from '../../common/request-context';
import { AccessService } from './access.service';
import { ApiClient } from './api-client.entities';
import { AuthService } from './auth.service';
import { User } from './identity.entities';
import { TokenService } from './token.service';

export type AuthedRequest = Request & { access?: AccessProfile; tokenSid?: string };

/**
 * Global guard: bearer token → AccessProfile → permission check → per-caller rate limit.
 * Users and machine clients go through the same path; permissions are re-read on every
 * request so a revoked role or disabled account stops working immediately.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly accessService: AccessService,
    private readonly auth: AuthService,
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets);
    const header = req.get('authorization');
    if (isPublic && !header) return true;

    const token = /^Bearer\s+(.+)$/i.exec(header ?? '')?.[1];
    if (!token) {
      if (isPublic) return true;
      throw unauthorised('Send a bearer token in the Authorization header');
    }
    if (isPublic) {
      // Public routes may still use a caller's identity; a bad token just means anonymous.
      try {
        return await this.authenticate(context, req, token, targets, true);
      } catch {
        return true;
      }
    }
    return this.authenticate(context, req, token, targets, false);
  }

  private async authenticate(context: ExecutionContext, req: AuthedRequest, token: string, // eslint-disable-next-line @typescript-eslint/no-explicit-any
    targets: any[], isPublic: boolean): Promise<boolean> {
    void context;
    const claims = await this.tokens.verify(token, ['user', 'client']);
    let access: AccessProfile;
    if (claims.typ === 'user') {
      const user = await this.dataSource.getRepository(User).findOneBy({ id: claims.sub });
      if (!user || user.status !== 'active') throw unauthorised('This account cannot sign in', 'account_disabled');
      if (!(await this.auth.isSessionActive(claims.sid))) throw unauthorised('This session was ended; sign in again', 'session_revoked');
      if (user.mustChangePassword && !this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_PASSWORD_KEY, targets) && !isPublic) {
        throw forbidden('Change your password before continuing', 'password_change_required');
      }
      access = await this.accessService.forUser(user);
      req.tokenSid = claims.sid;
      await consumeRateLimit(this.redis, `user:${user.id}`, loadEnv().userRateLimitPerMinute);
    } else {
      const client = await this.dataSource.getRepository(ApiClient).findOneBy({ id: claims.sub });
      if (!client || !client.isActive) throw unauthorised('This API client is disabled', 'client_disabled');
      if (this.reflector.getAllAndOverride<boolean>(USERS_ONLY_KEY, targets)) throw forbidden('Not available to API clients', 'users_only');
      // Scopes in the token are capped by what the client currently holds.
      const tokenScopes = (claims.scope ?? '').split(' ').filter(Boolean);
      access = this.accessService.forClient({ id: client.id, name: client.name, scopes: tokenScopes.filter((s) => client.scopes.includes(s)) });
      await consumeRateLimit(this.redis, `client:${client.id}`, client.rateLimitPerMinute);
      if (!client.lastUsedAt || Date.now() - client.lastUsedAt.getTime() > 60_000) {
        await this.dataSource.query(`UPDATE api_client SET last_used_at = now() WHERE id = $1`, [client.id]);
      }
    }

    req.access = access;
    RequestContext.setActor({ type: access.actorType, id: access.actorId, name: access.actorName, access });

    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, targets) ?? [];
    const missing = required.filter((p) => !access.has(p));
    if (missing.length) {
      throw new ProblemException(403, 'missing_permission', `Requires ${missing.join(', ')}`, undefined, { missing_permissions: missing });
    }
    return true;
  }
}
