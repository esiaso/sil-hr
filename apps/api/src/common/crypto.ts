import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, KeyObject, randomBytes, timingSafeEqual } from 'node:crypto';
import { loadEnv } from '../config/env';

/**
 * Column-level encryption for personal data (Kenya Data Protection Act):
 * AES-256-GCM, stored as `v1:<iv>:<tag>:<ciphertext>` (base64url). The version prefix
 * lets the key be rotated: decrypt with the key named by the prefix, re-encrypt with the
 * current one.
 */
const VERSION = 'v1';

function dek(): Buffer {
  return Buffer.from(loadEnv().dataEncryptionKey, 'hex');
}

export function encrypt(plain: string | null | undefined): string | null {
  if (plain === null || plain === undefined || plain === '') return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dek(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
}

export function decrypt(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const [version, iv, tag, ct] = stored.split(':');
  if (version !== VERSION || !iv || !tag || ct === undefined) throw new Error('Unrecognised ciphertext format');
  const decipher = createDecipheriv('aes-256-gcm', dek(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

/**
 * Deterministic HMAC of a normalised value, so an encrypted column can still be
 * unique-indexed and looked up by exact value without storing it in clear.
 */
export function blindIndex(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalised = value.replace(/\s+/g, '').toUpperCase();
  return createHmac('sha256', Buffer.from(loadEnv().blindIndexKey, 'hex')).update(normalised).digest('hex');
}

/** `****1234`: what list views and unscoped callers see. */
export function mask(value: string | null | undefined, visible = 4): string | null {
  if (!value) return null;
  if (value.length <= visible) return '*'.repeat(value.length);
  return '*'.repeat(Math.min(8, value.length - visible)) + value.slice(-visible);
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Ed25519 key pair from a 32-byte hex seed (PKCS#8 wrapping of the raw seed). */
export function ed25519FromSeed(hexSeed: string): { privateKey: KeyObject; publicKey: KeyObject; kid: string } {
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(hexSeed, 'hex')]);
  const privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey);
  const kid = sha256(publicKey.export({ format: 'der', type: 'spki' })).slice(0, 16);
  return { privateKey, publicKey, kid };
}
