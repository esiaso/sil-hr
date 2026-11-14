import { Injectable } from '@nestjs/common';
import { exportJWK, jwtVerify, SignJWT, type JWK, type JWTPayload } from 'jose';
import type { KeyObject } from 'node:crypto';
import { loadEnv } from '../../config/env';
import { ed25519FromSeed } from '../../common/crypto';
import { unauthorised } from '../../common/problem';

export type TokenType = 'user' | 'client' | 'mfa';

export interface AccessClaims extends JWTPayload {
  sub: string;
  typ: TokenType;
  /** Space-separated OAuth scopes (clients only). */
  scope?: string;
  /** Refresh-token family (users): logout revokes it. */
  sid?: string;
}

interface SigningKey {
  privateKey: KeyObject;
  publicKey: KeyObject;
  kid: string;
}

/**
 * Signs and verifies EdDSA (Ed25519) JWTs. The current key signs; the previous key (if
 * configured) still verifies, so the key can be rotated without logging everyone out.
 * Public keys are published at /api/v1/.well-known/jwks.json for other systems.
 */
@Injectable()
export class TokenService {
  private readonly current: SigningKey;
  private readonly keys: SigningKey[];
  private readonly issuer: string;

  constructor() {
    const env = loadEnv();
    this.current = ed25519FromSeed(env.jwtSigningKey);
    this.keys = [this.current, ...(env.jwtPreviousSigningKey ? [ed25519FromSeed(env.jwtPreviousSigningKey)] : [])];
    this.issuer = env.jwtIssuer;
  }

  async sign(claims: AccessClaims, ttlSeconds: number): Promise<string> {
    return new SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'EdDSA', kid: this.current.kid, typ: 'JWT' })
      .setIssuer(this.issuer)
      .setAudience('sil-hr-api')
      .setIssuedAt()
      .setExpirationTime(`${ttlSeconds}s`)
      .setJti(crypto.randomUUID())
      .sign(this.current.privateKey);
  }

  async verify(token: string, expected: TokenType | TokenType[]): Promise<AccessClaims> {
    const types = Array.isArray(expected) ? expected : [expected];
    try {
      const { payload } = await jwtVerify(token, async (header) => {
        const key = this.keys.find((k) => k.kid === header.kid);
        if (!key) throw new Error('unknown kid');
        return key.publicKey;
      }, { issuer: this.issuer, audience: 'sil-hr-api', algorithms: ['EdDSA'] });
      const claims = payload as AccessClaims;
      if (!types.includes(claims.typ)) throw new Error('wrong token type');
      return claims;
    } catch {
      throw unauthorised('The access token is invalid or has expired', 'invalid_token');
    }
  }

  async jwks(): Promise<{ keys: JWK[] }> {
    return {
      keys: await Promise.all(this.keys.map(async (k) => ({ ...(await exportJWK(k.publicKey)), kid: k.kid, alg: 'EdDSA', use: 'sig' }))),
    };
  }
}
