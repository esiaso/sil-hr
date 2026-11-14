import { formatDate, formatDateTime, formatMoney, createPosition, updatePosition, roleAssignmentInput } from '@sil/hr-shared';
import { scopeAllows } from '../../src/common/access';
import { blindIndex, decrypt, encrypt, mask } from '../../src/common/crypto';
import { loadEnv } from '../../src/config/env';
import { formatNumber } from '../../src/modules/numbering/numbering.module';
import { sign, verify, newWebhookSecret, backoffSeconds } from '../../src/modules/webhooks/signing';

describe('column encryption', () => {
  it('round-trips, uses a fresh IV each time, and detects tampering', () => {
    const a = encrypt('12345678')!;
    const b = encrypt('12345678')!;
    expect(a).not.toBe(b);
    expect(a.startsWith('v1:')).toBe(true);
    expect(decrypt(a)).toBe('12345678');
    const parts = a.split(':');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decrypt(parts.join(':'))).toThrow();
    expect(encrypt('')).toBeNull();
  });

  it('blind index is deterministic and normalised; masking hides all but the tail', () => {
    expect(blindIndex('a 123 456 789 z')).toBe(blindIndex('A123456789Z'));
    expect(blindIndex('A123456789Z')).not.toBe(blindIndex('A123456789Y'));
    expect(mask('A012345678Z')).toBe('*******678Z');
    expect(mask('12')).toBe('**');
  });
});

describe('webhook signatures (Standard Webhooks)', () => {
  it('matches the published test vector', () => {
    // Vector from the Standard Webhooks specification repository.
    const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
    const sig = sign(secret, 'msg_p5jXN8AQM9LWM0D4loKWxJek', 1614265330, '{"test": 2432232314}');
    expect(sig).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
  });

  it('rejects old timestamps and altered bodies', () => {
    const secret = newWebhookSecret();
    const now = Date.now();
    const ts = Math.floor(now / 1000);
    const s = sign(secret, 'id1', ts, '{}');
    expect(verify(secret, { id: 'id1', timestamp: String(ts), signature: s }, '{}', 300, now)).toBe(true);
    expect(verify(secret, { id: 'id1', timestamp: String(ts), signature: s }, '{"x":1}', 300, now)).toBe(false);
    expect(verify(secret, { id: 'id1', timestamp: String(ts - 600), signature: sign(secret, 'id1', ts - 600, '{}') }, '{}', 300, now)).toBe(false);
  });

  it('backs off progressively with bounded jitter', () => {
    expect(backoffSeconds(1, 0)).toBe(27);
    expect(backoffSeconds(1, 1)).toBe(33);
    expect(backoffSeconds(8, 0.5)).toBe(12 * 3600);
    expect(backoffSeconds(20, 0.5)).toBe(12 * 3600);
  });
});

describe('numbering formats', () => {
  it('fills tokens and pads the sequence', () => {
    expect(formatNumber('{PREFIX}/{YYYY}/{SEQ}', { prefix: 'CON', date: '2026-03-09', seq: 7, padding: 4 })).toBe('CON/2026/0007');
    expect(formatNumber('{PREFIX}{YY}{MM}-{SEQ}', { prefix: 'PS', date: '2026-11-01', seq: 123, padding: 3 })).toBe('PS2611-123');
    expect(formatNumber('{BRANCH}-{SEQ}', { prefix: '', date: '2026-01-01', seq: 1, padding: 2, branchCode: 'SAT' })).toBe('SAT-01');
  });
});

describe('data scope matching', () => {
  it('matches on any of branch, department or employee, and nothing when empty', () => {
    const f = { all: false as const, branchIds: ['b1'], departmentIds: ['d1', 'd2'], employeeIds: ['e1'] };
    expect(scopeAllows(f, { branchId: 'b1' })).toBe(true);
    expect(scopeAllows(f, { departmentId: 'd2', branchId: 'b9' })).toBe(true);
    expect(scopeAllows(f, { employeeId: 'e1' })).toBe(true);
    expect(scopeAllows(f, { branchId: 'b2', departmentId: 'd9', employeeId: 'e9' })).toBe(false);
    expect(scopeAllows({ all: false, branchIds: [], departmentIds: [], employeeIds: [] }, { branchId: 'b1' })).toBe(false);
    expect(scopeAllows({ all: true }, {})).toBe(true);
  });
});

describe('shared contract', () => {
  it('requires a target for branch and department scopes', () => {
    const r = '0199a6b0-0000-7000-8000-000000000001';
    expect(roleAssignmentInput.safeParse({ role_id: r, scope: 'branch' }).success).toBe(false);
    expect(roleAssignmentInput.safeParse({ role_id: r, scope: 'branch', branch_id: r }).success).toBe(true);
    expect(roleAssignmentInput.safeParse({ role_id: r, scope: 'organisation' }).success).toBe(true);
  });

  it('defaults apply on create but never on a partial update', () => {
    const d = '0199a6b0-0000-7000-8000-000000000001';
    expect(createPosition.parse({ code: 'RN', title: 'Nurse', department_id: d }).headcount).toBe(1);
    expect(updatePosition.parse({ title: 'Nurse' })).toEqual({ title: 'Nurse' });
  });

  it('formats dates, times and money without floats', () => {
    expect(formatDate('2026-03-09')).toBe('09/03/2026');
    expect(formatDate('2026-03-09', 'YYYY-MM-DD')).toBe('2026-03-09');
    expect(formatDateTime('2026-03-09T21:30:00Z', 'Africa/Nairobi')).toBe('10/03/2026 00:30');
    expect(formatMoney('1234567.5')).toBe('KES 1,234,567.50');
    expect(formatMoney('-0.1')).toBe('-KES 0.10');
    expect(formatMoney('90071992547409.99')).toBe('KES 90,071,992,547,409.99');
  });
});

describe('configuration', () => {
  it('refuses development keys in production', () => {
    expect(() => loadEnv({ NODE_ENV: 'production' } as NodeJS.ProcessEnv, false)).toThrow(/JWT_SIGNING_KEY/);
    const key = (c: string) => c.repeat(64);
    expect(() => loadEnv({ NODE_ENV: 'production', JWT_SIGNING_KEY: key('1'), DATA_ENCRYPTION_KEY: key('2'), BLIND_INDEX_KEY: key('3') } as NodeJS.ProcessEnv, false)).not.toThrow();
  });
});
