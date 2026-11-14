import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Standard Webhooks signing (https://www.standardwebhooks.com):
 *   signed content = `${webhook-id}.${webhook-timestamp}.${body}`
 *   webhook-signature = `v1,` + base64(HMAC-SHA256(secret bytes, signed content))
 * The secret is `whsec_` + base64 of 32 random bytes. Consumers should reject
 * timestamps more than 5 minutes from their clock.
 */
export function newWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64')}`;
}

function keyBytes(secret: string): Buffer {
  return Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
}

export function sign(secret: string, id: string, timestamp: number, body: string): string {
  return `v1,${createHmac('sha256', keyBytes(secret)).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

/** Reference verifier (used by the tests and shown in the integration guide). */
export function verify(secret: string, headers: { id: string; timestamp: string; signature: string }, body: string, toleranceSeconds = 300, now = Date.now()): boolean {
  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > toleranceSeconds) return false;
  const expected = Buffer.from(sign(secret, headers.id, ts, body));
  return headers.signature.split(' ').some((candidate) => {
    const c = Buffer.from(candidate);
    return c.length === expected.length && timingSafeEqual(c, expected);
  });
}

/** Retry schedule after attempt n (1-based): ~22 hours in total over 8 attempts. */
const SCHEDULE_SECONDS = [30, 120, 600, 1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600];

export function backoffSeconds(attempt: number, jitter = Math.random()): number {
  const base = SCHEDULE_SECONDS[Math.min(attempt - 1, SCHEDULE_SECONDS.length - 1)];
  return Math.round(base * (0.9 + 0.2 * jitter));
}
