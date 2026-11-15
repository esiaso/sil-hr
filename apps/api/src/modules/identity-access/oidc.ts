import { Controller, Get, HttpCode, Injectable, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'node:crypto';
import type Redis from 'ioredis';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { LoginOutcome, loginResponse } from '@sil/hr-shared';
import { loadEnv } from '../../config/env';
import { Public } from '../../common/decorators';
import { ProblemException, unauthorised } from '../../common/problem';
import { InjectRedis } from '../../common/redis';
import { ZBody, ZResponse } from '../../common/zod';
import { writeAudit } from '../audit/audit.subscriber';
import { AuthService, clientInfo } from './auth.service';
import { LoginHistory, User } from './identity.entities';

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

const STATE_TTL = 600;

/**
 * OpenID Connect relying party (authorization code flow with PKCE). Staff sign in at the
 * organisation's identity provider; HR maps the returned identity to an existing user
 * account (by subject, or the first time by verified email) and issues its own tokens.
 * Accounts are never created here: HR provisions the identity provider (SCIM), not the
 * other way round. Local passwords keep working as a fallback.
 */
@Injectable()
export class OidcService {
  private discovery: Discovery | null = null;
  private jwks: JWTVerifyGetKey | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRedis() private readonly redis: Redis,
    private readonly auth: AuthService,
  ) {}

  get enabled(): boolean {
    const o = loadEnv().oidc;
    return !!(o.issuer && o.clientId);
  }

  private async meta(): Promise<Discovery> {
    if (this.discovery) return this.discovery;
    const o = loadEnv().oidc;
    const res = await fetch(`${o.issuer!.replace(/\/$/, '')}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (!res?.ok) throw new ProblemException(503, 'idp_unavailable', 'The identity provider cannot be reached; sign in with your password');
    this.discovery = (await res.json()) as Discovery;
    this.jwks = createRemoteJWKSet(new URL(this.discovery.jwks_uri));
    return this.discovery;
  }

  /** Starts a sign-in: returns the IdP URL; state, nonce and the PKCE verifier wait in Redis. */
  async start(redirectUri: string): Promise<{ authorization_url: string; state: string }> {
    if (!this.enabled) throw new ProblemException(404, 'oidc_disabled', 'Single sign-on is not configured');
    const d = await this.meta();
    const o = loadEnv().oidc;
    const state = randomBytes(24).toString('base64url');
    const nonce = randomBytes(24).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    await this.redis.set(`silhr:oidc:${state}`, JSON.stringify({ nonce, verifier, redirectUri }), 'EX', STATE_TTL);
    const url = new URL(d.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: o.clientId!,
      redirect_uri: redirectUri,
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    return { authorization_url: url.toString(), state };
  }

  async callback(code: string, state: string) {
    const saved = await this.redis.getdel(`silhr:oidc:${state}`);
    if (!saved) throw unauthorised('This sign-in link has expired; start again', 'oidc_state');
    const { nonce, verifier, redirectUri } = JSON.parse(saved) as { nonce: string; verifier: string; redirectUri: string };
    const d = await this.meta();
    const o = loadEnv().oidc;
    const res = await fetch(d.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(o.clientSecret ? { authorization: `Basic ${Buffer.from(`${encodeURIComponent(o.clientId!)}:${encodeURIComponent(o.clientSecret)}`).toString('base64')}` } : {}) },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier, ...(o.clientSecret ? {} : { client_id: o.clientId! }) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw unauthorised('The identity provider refused the sign-in', 'oidc_token');
    const tokens = (await res.json()) as { id_token?: string };
    if (!tokens.id_token) throw unauthorised('No identity token returned', 'oidc_token');
    let claims: { sub: string; email?: string; email_verified?: boolean; nonce?: string; preferred_username?: string };
    try {
      claims = (await jwtVerify(tokens.id_token, this.jwks!, { issuer: d.issuer, audience: o.clientId! })).payload as typeof claims;
    } catch {
      throw unauthorised('The identity token is not valid', 'oidc_id_token');
    }
    if (claims.nonce !== nonce) throw unauthorised('The identity token does not match this sign-in', 'oidc_nonce');

    const repo = this.dataSource.getRepository(User);
    let user = await repo.findOneBy({ externalSubject: claims.sub });
    if (!user && claims.email && claims.email_verified !== false) {
      user = await repo.createQueryBuilder('u').where('lower(u.email) = lower(:e)', { e: claims.email }).andWhere('u.external_subject IS NULL').getOne();
      if (user) {
        user.externalSubject = claims.sub;
        await repo.save(user);
        await writeAudit(this.dataSource.manager, { action: 'sso_linked', entityType: 'User', entityId: user.id, after: { issuer: d.issuer } });
      }
    }
    const who = claims.email ?? claims.preferred_username ?? claims.sub;
    if (!user) {
      await this.dataSource.getRepository(LoginHistory).insert({ userId: null, username: who.slice(0, 200), outcome: LoginOutcome.BAD_CREDENTIALS, method: 'oidc', ...clientInfo() });
      throw new ProblemException(403, 'no_account', 'You signed in at the identity provider, but there is no SIL HR account for you. Ask HR.');
    }
    if (user.status !== 'active') throw new ProblemException(403, 'account_disabled', 'This account is disabled');
    return this.auth.completeExternal(user, 'oidc', clientInfo());
  }
}

@ApiTags('Auth')
@Controller('auth/oidc')
export class OidcController {
  constructor(private readonly oidc: OidcService) {}

  @Get('config')
  @Public()
  @ZResponse(z.object({ enabled: z.boolean(), label: z.string() }))
  config() {
    return { enabled: this.oidc.enabled, label: loadEnv().oidc.label };
  }

  @Post('start')
  @Public()
  @HttpCode(200)
  @ZResponse(z.object({ authorization_url: z.string(), state: z.string() }))
  start(@ZBody(z.object({ redirect_uri: z.url() })) dto: { redirect_uri: string }) {
    const allowed = loadEnv().oidc.redirectUris;
    if (!allowed.includes(dto.redirect_uri)) throw new ProblemException(400, 'invalid_redirect_uri', 'That redirect URI is not registered');
    return this.oidc.start(dto.redirect_uri);
  }

  @Post('callback')
  @Public()
  @HttpCode(200)
  @ZResponse(loginResponse)
  callback(@ZBody(z.object({ code: z.string().min(1).max(4000), state: z.string().min(10).max(200) })) dto: { code: string; state: string }) {
    return this.oidc.callback(dto.code, dto.state);
  }
}

