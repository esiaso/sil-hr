import { generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, SignJWT } from 'jose';
import { loadEnv } from '../src/config/env';
import { api, closeApp, db, testApp } from './helpers';

/**
 * A minimal OpenID provider (discovery, JWKS, token endpoint) standing in for Keycloak,
 * so the relying-party flow is tested without the real IdP.
 */
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
let server: Server;
let issuer = '';
const codes = new Map<string, { sub: string; email: string; nonce: string }>();

beforeAll(async () => {
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256', use: 'sig' };
  server = createServer(async (req, res) => {
    const url = new URL(req.url!, issuer);
    if (url.pathname.endsWith('/.well-known/openid-configuration')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` }));
    } else if (url.pathname.endsWith('/jwks')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [jwk] }));
    } else if (url.pathname.endsWith('/token')) {
      let body = '';
      for await (const c of req) body += c;
      const p = new URLSearchParams(body);
      const grant = codes.get(p.get('code') ?? '');
      if (!grant || !p.get('code_verifier')) return void res.writeHead(400).end('{"error":"invalid_grant"}');
      const idToken = await new SignJWT({ email: grant.email, email_verified: true, nonce: grant.nonce })
        .setProtectedHeader({ alg: 'RS256', kid: 'test' })
        .setIssuer(issuer)
        .setAudience('sil-hr')
        .setSubject(grant.sub)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: 'x', id_token: idToken, token_type: 'Bearer' }));
    } else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/realms/sil`;
  Object.assign(loadEnv().oidc, { issuer, clientId: 'sil-hr', clientSecret: 'secret', redirectUris: ['http://localhost:3320/auth/oidc/callback'] });
});

afterAll(async () => {
  await closeApp();
  await new Promise((r) => server.close(r));
});

async function signIn(sub: string, email: string) {
  const app = await testApp();
  const start = await api(app).post('/api/v1/auth/oidc/start').send({ redirect_uri: 'http://localhost:3320/auth/oidc/callback' });
  expect(start.status).toBe(200);
  const url = new URL(start.body.authorization_url);
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  const code = `code-${Math.random()}`;
  codes.set(code, { sub, email, nonce: url.searchParams.get('nonce')! });
  return api(app).post('/api/v1/auth/oidc/callback').send({ code, state: start.body.state });
}

describe('OpenID Connect single sign-on', () => {
  it('advertises itself and refuses unregistered redirect URIs', async () => {
    const app = await testApp();
    expect((await api(app).get('/api/v1/auth/oidc/config')).body.enabled).toBe(true);
    expect((await api(app).post('/api/v1/auth/oidc/start').send({ redirect_uri: 'https://evil.example/cb' })).body.code).toBe('invalid_redirect_uri');
  });

  it('links an existing account by verified email the first time, then by subject; issues HR tokens', async () => {
    const app = await testApp();
    const first = await signIn('kc-sub-001', 'auditor@example.org');
    expect(first.status).toBe(200);
    expect(first.body.access_token).toBeTruthy();
    const [u] = await db(app).query(`SELECT external_subject FROM user_account WHERE username = 'auditor'`);
    expect(u.external_subject).toBe('kc-sub-001');
    // Later sign-ins match the subject even if the email changed at the IdP.
    expect((await signIn('kc-sub-001', 'renamed@example.org')).status).toBe(200);
    const me = await api(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${first.body.access_token}`);
    expect(me.body.username).toBe('auditor');
  });

  it('never creates accounts, and refuses replayed or unknown state', async () => {
    const app = await testApp();
    const unknown = await signIn('kc-sub-999', 'stranger@example.org');
    expect(unknown.status).toBe(403);
    expect(unknown.body.code).toBe('no_account');
    const replay = await api(app).post('/api/v1/auth/oidc/callback').send({ code: 'whatever', state: 'not-a-real-state-value' });
    expect(replay.body.code).toBe('oidc_state');
  });
});
