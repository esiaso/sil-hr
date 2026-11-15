// Runs before every test file. Tests ignore .env and use their own database and Redis DB.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://silhr:silhr_dev_password@localhost:55433/silhr_test';
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6380/1';
process.env.S3_ENDPOINT = process.env.TEST_S3_ENDPOINT ?? 'http://localhost:9010';
process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT;
process.env.S3_BUCKET = 'silhr-test';
process.env.DB_MIGRATIONS_RUN = 'false';
process.env.SEED_ON_START = 'false';
process.env.SMTP_URL = '';
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent';
process.env.AUTH_RATE_LIMIT_PER_MINUTE = '100000';
process.env.USER_RATE_LIMIT_PER_MINUTE = '100000';
process.env.API_DOCS = 'true';
process.env.PUBLIC_BASE_URL = 'http://localhost:3310';
delete process.env.SAMPLE_WEBHOOK_URL;
// Background work is driven explicitly by the tests (as the worker does), never on timers.
process.env.JOBS_MODE = 'queue';
// Exit clearance asks a mock sil_procurement (started by lifecycle.spec.ts).
process.env.PROCUREMENT_API_URL = 'http://127.0.0.1:39125';
process.env.PROCUREMENT_API_KEY = 'test-hr-key';
