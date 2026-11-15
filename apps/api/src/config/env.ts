/**
 * Process configuration from environment variables. Business configuration
 * (currency, timezone, statutory rates, numbering…) lives in the database instead.
 * With NODE_ENV=production the API refuses to start on development placeholders.
 */
export interface Env {
  nodeEnv: string;
  isProduction: boolean;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  dbMigrationsRun: boolean;
  dbLogging: boolean;
  seedOnStart: boolean;
  seedSample: boolean;
  seedDefaultPassword: string | null;
  /** 64 hex chars: Ed25519 seed that signs access tokens. */
  jwtSigningKey: string;
  /** Previous signing key kept for verification during a rotation. */
  jwtPreviousSigningKey: string | null;
  jwtIssuer: string;
  accessTokenTtlSeconds: number;
  clientTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  /** 64 hex chars: AES-256-GCM key for sensitive columns (`v1`). */
  dataEncryptionKey: string;
  /** 64 hex chars: HMAC key for blind indexes on encrypted columns. */
  blindIndexKey: string;
  trustProxy: boolean;
  corsOrigins: string[];
  apiDocs: boolean;
  publicBaseUrl: string;
  authRateLimitPerMinute: number;
  userRateLimitPerMinute: number;
  storage: {
    endpoint: string;
    publicEndpoint: string;
    region: string;
    bucket: string;
    accessKey: string;
    secretKey: string;
    forcePathStyle: boolean;
  };
  maxUploadMb: number;
  smtpUrl: string | null;
  mailFrom: string;
  eventStream: string;
  eventSource: string;
  jobsMode: 'queue' | 'inline' | 'off';
  logLevel: string;
  metricsToken: string | null;
  /** OpenID Connect single sign-on; disabled unless issuer and client id are set. */
  oidc: { issuer: string | null; clientId: string | null; clientSecret: string | null; label: string; redirectUris: string[] };
}

const DEV_JWT = 'a1'.repeat(32);
const DEV_DEK = 'b2'.repeat(32);
const DEV_BIDX = 'c3'.repeat(32);

function bool(v: string | undefined, d: boolean): boolean {
  if (v === undefined || v === '') return d;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}
function int(v: string | undefined, d: number): number {
  const n = v === undefined || v === '' ? d : Number(v);
  if (!Number.isFinite(n)) throw new Error(`Not a number: ${v}`);
  return n;
}
function hex64(name: string, v: string): string {
  if (!/^[0-9a-fA-F]{64}$/.test(v)) throw new Error(`${name} must be 64 hex characters`);
  return v.toLowerCase();
}

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env, useCache = true): Env {
  if (cached && useCache && source === process.env) return cached;
  const e = source;
  const nodeEnv = e.NODE_ENV ?? 'development';
  const isProduction = nodeEnv === 'production';
  const env: Env = {
    nodeEnv,
    isProduction,
    port: int(e.PORT, 3000),
    databaseUrl: e.DATABASE_URL ?? 'postgres://silhr:silhr_dev_password@localhost:55433/silhr',
    redisUrl: e.REDIS_URL ?? 'redis://localhost:6380/0',
    dbMigrationsRun: bool(e.DB_MIGRATIONS_RUN, true),
    dbLogging: bool(e.DB_LOGGING, false),
    seedOnStart: bool(e.SEED_ON_START, false),
    seedSample: bool(e.SEED_SAMPLE, true),
    seedDefaultPassword: e.SEED_DEFAULT_PASSWORD || null,
    jwtSigningKey: hex64('JWT_SIGNING_KEY', e.JWT_SIGNING_KEY ?? DEV_JWT),
    jwtPreviousSigningKey: e.JWT_PREVIOUS_SIGNING_KEY ? hex64('JWT_PREVIOUS_SIGNING_KEY', e.JWT_PREVIOUS_SIGNING_KEY) : null,
    jwtIssuer: e.JWT_ISSUER ?? 'sil-hr',
    accessTokenTtlSeconds: int(e.ACCESS_TOKEN_TTL_SECONDS, 900),
    clientTokenTtlSeconds: int(e.CLIENT_TOKEN_TTL_SECONDS, 900),
    refreshTokenTtlDays: int(e.REFRESH_TOKEN_TTL_DAYS, 14),
    dataEncryptionKey: hex64('DATA_ENCRYPTION_KEY', e.DATA_ENCRYPTION_KEY ?? DEV_DEK),
    blindIndexKey: hex64('BLIND_INDEX_KEY', e.BLIND_INDEX_KEY ?? DEV_BIDX),
    trustProxy: bool(e.TRUST_PROXY, false),
    corsOrigins: (e.CORS_ORIGINS ?? 'http://localhost:3320').split(',').map((s) => s.trim()).filter(Boolean),
    apiDocs: bool(e.API_DOCS, true),
    publicBaseUrl: (e.PUBLIC_BASE_URL ?? 'http://localhost:3310').replace(/\/$/, ''),
    authRateLimitPerMinute: int(e.AUTH_RATE_LIMIT_PER_MINUTE, 30),
    userRateLimitPerMinute: int(e.USER_RATE_LIMIT_PER_MINUTE, 1200),
    storage: {
      endpoint: e.S3_ENDPOINT ?? 'http://localhost:9010',
      publicEndpoint: e.S3_PUBLIC_ENDPOINT ?? e.S3_ENDPOINT ?? 'http://localhost:9010',
      region: e.S3_REGION ?? 'us-east-1',
      bucket: e.S3_BUCKET ?? 'silhr-documents',
      accessKey: e.S3_ACCESS_KEY ?? 'silhr',
      secretKey: e.S3_SECRET_KEY ?? 'silhr_dev_minio_password',
      forcePathStyle: bool(e.S3_FORCE_PATH_STYLE, true),
    },
    maxUploadMb: int(e.MAX_UPLOAD_MB, 20),
    smtpUrl: e.SMTP_URL || null,
    mailFrom: e.MAIL_FROM ?? 'SIL HR <hr@localhost>',
    eventStream: e.EVENT_STREAM ?? 'silhr:events',
    eventSource: e.EVENT_SOURCE ?? 'urn:sil:hr',
    jobsMode: (e.JOBS_MODE as Env['jobsMode']) ?? 'inline',
    logLevel: e.LOG_LEVEL ?? (nodeEnv === 'test' ? 'silent' : 'info'),
    metricsToken: e.METRICS_TOKEN || null,
    oidc: {
      issuer: e.OIDC_ISSUER || null,
      clientId: e.OIDC_CLIENT_ID || null,
      clientSecret: e.OIDC_CLIENT_SECRET || null,
      label: e.OIDC_LABEL ?? 'Sign in with your organisation account',
      redirectUris: (e.OIDC_REDIRECT_URIS ?? 'http://localhost:3320/auth/oidc/callback').split(',').map((s) => s.trim()).filter(Boolean),
    },
  };
  if (isProduction) {
    const unsafe: string[] = [];
    if (env.jwtSigningKey === DEV_JWT) unsafe.push('JWT_SIGNING_KEY');
    if (env.dataEncryptionKey === DEV_DEK) unsafe.push('DATA_ENCRYPTION_KEY');
    if (env.blindIndexKey === DEV_BIDX) unsafe.push('BLIND_INDEX_KEY');
    if (env.seedOnStart && env.seedSample) unsafe.push('SEED_SAMPLE (sample data in production)');
    if (unsafe.length) throw new Error(`Refusing to start in production with development values: ${unsafe.join(', ')}`);
  }
  if (source === process.env) cached = env;
  return env;
}
