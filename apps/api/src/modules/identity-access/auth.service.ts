import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { authenticator } from 'otplib';
import * as QRCode from 'qrcode';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { AuditAction, LoginOutcome, type LoginResponse, type Me, type TokenResponse } from '@sil/hr-shared';
import { loadEnv } from '../../config/env';
import { decrypt, encrypt, randomToken, sha256 } from '../../common/crypto';
import { ProblemException, unauthorised, unprocessable } from '../../common/problem';
import { RequestContext } from '../../common/request-context';
import { writeAudit } from '../audit/audit.subscriber';
import { SettingsService } from '../settings/settings.module';
import { IpAllowRule, LoginHistory, MfaRecoveryCode, RefreshToken, RoleAssignment, User } from './identity.entities';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

authenticator.options = { window: 1 };

const MFA_TOKEN_TTL = 300;
/** Concurrent refreshes with one token inside this window are a race, not a replay. */
export const REFRESH_REUSE_GRACE_MS = 30_000;
const ADMIN_ROLE = 'system_admin';

interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly settings: SettingsService,
  ) {}

  private async history(userId: string | null, username: string, outcome: string, method: string, client: ClientInfo): Promise<void> {
    await this.dataSource.getRepository(LoginHistory).insert({ userId, username: username.slice(0, 200), outcome, method, ip: client.ip, userAgent: client.userAgent });
    if (userId) {
      await writeAudit(this.dataSource.manager, {
        action: outcome === LoginOutcome.SUCCESS ? AuditAction.LOGIN : AuditAction.LOGIN_FAILED,
        entityType: 'User',
        entityId: userId,
        after: { method, outcome },
        actor: { type: 'user', id: userId, name: username },
      });
    }
  }

  /** Enforces the IP allow-list when enabled. `admin` rules only bind system administrators. */
  private async ipAllowed(user: User, ip: string | null): Promise<boolean> {
    if (!(await this.settings.get('security.ip_allow_list_enabled'))) return true;
    const rules = await this.dataSource.getRepository(IpAllowRule).findBy({ isActive: true });
    if (!rules.length) return true;
    const isAdmin = await this.dataSource.getRepository(RoleAssignment).exist({ where: { userId: user.id, role: { code: ADMIN_ROLE } }, relations: { role: true } });
    const applicable = rules.filter((r) => r.appliesTo === 'all' || isAdmin);
    if (!applicable.length) return true;
    if (!ip) return false;
    const [row] = await this.dataSource.query(`SELECT bool_or($1::inet <<= cidr) AS ok FROM ip_allow_rule WHERE id = ANY($2::uuid[])`, [ip.replace(/^::ffff:/, ''), applicable.map((r) => r.id)]);
    return !!row?.ok;
  }

  async login(username: string, password: string, client: ClientInfo): Promise<LoginResponse> {
    const repo = this.dataSource.getRepository(User);
    const user = await repo
      .createQueryBuilder('u')
      .addSelect('u.passwordHash')
      .where('(lower(u.username) = lower(:n) OR lower(u.email) = lower(:n))', { n: username.trim() })
      .getOne();

    const fail = async (outcome: string, detail: string, code = 'invalid_credentials', status = 401): Promise<never> => {
      await this.history(user?.id ?? null, user?.username ?? username, outcome, 'password', client);
      throw new ProblemException(status, code, detail);
    };

    const ok = await this.passwords.verify(user?.passwordHash, password);
    if (!user) return fail(LoginOutcome.BAD_CREDENTIALS, 'Wrong username or password');
    if (user.status === 'disabled') return fail(LoginOutcome.DISABLED, 'This account is disabled', 'account_disabled', 403);
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      return fail(LoginOutcome.LOCKED, `Too many failed attempts; try again after ${user.lockedUntil.toISOString()}`, 'account_locked', 423);
    }
    if (!(await this.ipAllowed(user, client.ip))) return fail(LoginOutcome.IP_BLOCKED, 'Sign-in is not allowed from this network', 'ip_not_allowed', 403);
    if (!ok) {
      const threshold = await this.settings.get('security.lockout_threshold');
      const minutes = await this.settings.get('security.lockout_minutes');
      const failed = user.failedLoginCount + 1;
      // Login bookkeeping uses raw SQL so it does not bump the row version (ETag) admins edit against.
      await this.dataSource.query(`UPDATE user_account SET failed_login_count = $2, locked_until = $3 WHERE id = $1`, failed >= threshold ? [user.id, 0, new Date(Date.now() + minutes * 60_000)] : [user.id, failed, null]);
      return fail(LoginOutcome.BAD_CREDENTIALS, 'Wrong username or password');
    }
    await this.dataSource.query(`UPDATE user_account SET failed_login_count = 0, locked_until = NULL WHERE id = $1`, [user.id]);

    if (user.mfaEnabled) {
      await this.history(user.id, user.username, LoginOutcome.MFA_REQUIRED, 'password', client);
      const mfaToken = await this.tokens.sign({ sub: user.id, typ: 'mfa' }, MFA_TOKEN_TTL);
      return { mfa_required: true, mfa_token: mfaToken, expires_in: MFA_TOKEN_TTL };
    }
    return this.complete(user, 'password', client);
  }

  async verifyMfa(mfaToken: string, code: string, client: ClientInfo): Promise<LoginResponse> {
    const claims = await this.tokens.verify(mfaToken, 'mfa');
    const user = await this.dataSource.getRepository(User).createQueryBuilder('u').addSelect('u.mfaSecretEnc').where('u.id = :id', { id: claims.sub }).getOne();
    if (!user || user.status !== 'active' || !user.mfaEnabled) throw unauthorised('Start the sign-in again', 'mfa_invalid');
    const normalised = code.replace(/\s|-/g, '');
    let valid = /^\d{6}$/.test(normalised) && authenticator.check(normalised, decrypt(user.mfaSecretEnc) ?? '');
    if (!valid) {
      const used = await this.dataSource.getRepository(MfaRecoveryCode).update({ userId: user.id, codeHash: sha256(normalised.toLowerCase()), usedAt: IsNull() }, { usedAt: new Date() });
      valid = (used.affected ?? 0) > 0;
    }
    if (!valid) {
      await this.history(user.id, user.username, LoginOutcome.MFA_FAILED, 'mfa', client);
      throw unauthorised('That code is not valid', 'mfa_invalid');
    }
    return this.complete(user, 'mfa', client);
  }

  private async complete(user: User, method: string, client: ClientInfo): Promise<LoginResponse> {
    await this.dataSource.query(`UPDATE user_account SET last_login_at = now() WHERE id = $1`, [user.id]);
    await this.history(user.id, user.username, LoginOutcome.SUCCESS, method, client);
    const tokens = await this.issue(user.id, crypto.randomUUID(), client);
    return { ...tokens, mfa_required: false, must_change_password: user.mustChangePassword };
  }

  private async issue(userId: string, familyId: string, client: ClientInfo, manager: EntityManager = this.dataSource.manager): Promise<TokenResponse & { refresh_token: string }> {
    const env = loadEnv();
    const refresh = randomToken(32);
    await manager.getRepository(RefreshToken).insert({
      userId,
      familyId,
      tokenHash: sha256(refresh),
      expiresAt: new Date(Date.now() + env.refreshTokenTtlDays * 86_400_000),
      ip: client.ip,
      userAgent: client.userAgent,
    });
    const access = await this.tokens.sign({ sub: userId, typ: 'user', sid: familyId }, env.accessTokenTtlSeconds);
    return { access_token: access, token_type: 'Bearer', expires_in: env.accessTokenTtlSeconds, refresh_token: refresh };
  }

  /**
   * Rotates a refresh token. Presenting one that was already used means it was copied:
   * the whole family (every token from that login) is revoked.
   */
  async refresh(refreshToken: string, client: ClientInfo): Promise<TokenResponse> {
    const result = await this.dataSource.transaction(async (m) => {
      const repo = m.getRepository(RefreshToken);
      const row = await repo.findOne({ where: { tokenHash: sha256(refreshToken) }, lock: { mode: 'pessimistic_write' } });
      if (!row) throw unauthorised('Sign in again', 'invalid_refresh_token');
      // A browser fires several requests at once when its access token expires, and each
      // tries to refresh with the same token. Within a short grace window that is a race,
      // not theft: issue another token in the same family instead of revoking it.
      if (row.usedAt && !row.revokedAt && Date.now() - row.usedAt.getTime() < REFRESH_REUSE_GRACE_MS) {
        const user = await m.getRepository(User).findOneBy({ id: row.userId });
        if (!user || user.status !== 'active') throw unauthorised('This account cannot sign in', 'account_disabled');
        return this.issue(row.userId, row.familyId, client, m);
      }
      if (row.usedAt || row.revokedAt) {
        // Commit the revocation, then refuse (throwing here would roll it back).
        await repo.update({ familyId: row.familyId, revokedAt: IsNull() }, { revokedAt: new Date() });
        await writeAudit(m, { action: 'token_reuse', entityType: 'User', entityId: row.userId, after: { familyId: row.familyId } });
        return 'reused' as const;
      }
      if (row.expiresAt < new Date()) throw unauthorised('Session expired; sign in again', 'refresh_token_expired');
      const user = await m.getRepository(User).findOneBy({ id: row.userId });
      if (!user || user.status !== 'active') throw unauthorised('This account cannot sign in', 'account_disabled');
      await repo.update({ id: row.id }, { usedAt: new Date() });
      return this.issue(row.userId, row.familyId, client, m);
    });
    if (result === 'reused') throw unauthorised('This session was ended; sign in again', 'refresh_token_reused');
    return result;
  }

  async logout(userId: string, familyId: string | undefined, refreshToken?: string): Promise<void> {
    const repo = this.dataSource.getRepository(RefreshToken);
    if (refreshToken) {
      const row = await repo.findOneBy({ tokenHash: sha256(refreshToken), userId });
      if (row) familyId = row.familyId;
    }
    if (familyId) await repo.update({ familyId, userId, revokedAt: IsNull() }, { revokedAt: new Date() });
    await writeAudit(this.dataSource.manager, { action: AuditAction.LOGOUT, entityType: 'User', entityId: userId });
  }

  /** Revokes every session of a user (disable, password reset, role removal). */
  async revokeAll(userId: string, manager: EntityManager = this.dataSource.manager): Promise<void> {
    await manager.getRepository(RefreshToken).update({ userId, revokedAt: IsNull() }, { revokedAt: new Date() });
  }

  async isSessionActive(familyId: string | undefined): Promise<boolean> {
    if (!familyId) return true;
    return this.dataSource.getRepository(RefreshToken).exist({ where: { familyId, revokedAt: IsNull() } });
  }

  async changePassword(userId: string, current: string, next: string): Promise<void> {
    const repo = this.dataSource.getRepository(User);
    const user = await repo.createQueryBuilder('u').addSelect('u.passwordHash').where('u.id = :id', { id: userId }).getOneOrFail();
    if (!(await this.passwords.verify(user.passwordHash, current))) throw unprocessable('wrong_password', 'The current password is wrong', [{ path: 'current_password', message: 'Wrong password' }]);
    if (current === next) throw unprocessable('same_password', 'Choose a password different from the current one', [{ path: 'new_password', message: 'Same as current' }]);
    await this.passwords.assertPolicy(next, { username: user.username });
    user.passwordHash = await this.passwords.hash(next);
    user.mustChangePassword = false;
    user.passwordChangedAt = new Date();
    await repo.save(user);
  }

  // ------------------------------------------------------------------ MFA enrolment
  async enrolMfa(userId: string): Promise<{ secret: string; otpauth_url: string; qr_data_url: string }> {
    const repo = this.dataSource.getRepository(User);
    const user = await repo.findOneByOrFail({ id: userId });
    if (user.mfaEnabled) throw unprocessable('mfa_already_enabled', 'Two-factor sign-in is already on; turn it off first to re-enrol');
    const secret = authenticator.generateSecret();
    await repo.update({ id: userId }, { mfaSecretEnc: encrypt(secret) });
    const otpauth = authenticator.keyuri(user.username, await this.settings.get('security.mfa_issuer'), secret);
    return { secret, otpauth_url: otpauth, qr_data_url: await QRCode.toDataURL(otpauth) };
  }

  async confirmMfa(userId: string, code: string): Promise<{ recovery_codes: string[] }> {
    return this.dataSource.transaction(async (m) => {
      const repo = m.getRepository(User);
      const user = await repo.createQueryBuilder('u').addSelect('u.mfaSecretEnc').where('u.id = :id', { id: userId }).getOneOrFail();
      if (!user.mfaSecretEnc) throw unprocessable('mfa_not_enrolling', 'Start enrolment first');
      if (!authenticator.check(code, decrypt(user.mfaSecretEnc) ?? '')) throw unprocessable('mfa_invalid', 'That code is not valid', [{ path: 'code', message: 'Invalid code' }]);
      user.mfaEnabled = true;
      await repo.save(user);
      const codes = Array.from({ length: 10 }, () => randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8).padEnd(8, '0'));
      const rc = m.getRepository(MfaRecoveryCode);
      await rc.delete({ userId });
      await rc.insert(codes.map((c) => ({ userId, codeHash: sha256(c) })));
      return { recovery_codes: codes };
    });
  }

  async disableMfa(userId: string, password: string): Promise<void> {
    const repo = this.dataSource.getRepository(User);
    const user = await repo.createQueryBuilder('u').addSelect('u.passwordHash').where('u.id = :id', { id: userId }).getOneOrFail();
    if (!(await this.passwords.verify(user.passwordHash, password))) throw unprocessable('wrong_password', 'Wrong password', [{ path: 'password', message: 'Wrong password' }]);
    await this.dataSource.transaction(async (m) => {
      await m.getRepository(User).save(Object.assign(user, { mfaEnabled: false, mfaSecretEnc: null }));
      await m.getRepository(MfaRecoveryCode).delete({ userId });
    });
  }

  async me(userId: string, permissions: string[]): Promise<Me> {
    const user = await this.dataSource.getRepository(User).findOneByOrFail({ id: userId });
    const assignments = await this.dataSource.getRepository(RoleAssignment).find({ where: { userId }, relations: { role: true } });
    return {
      id: user.id,
      username: user.username,
      display_name: user.displayName,
      email: user.email,
      employee_id: user.employeeId,
      mfa_enabled: user.mfaEnabled,
      must_change_password: user.mustChangePassword,
      roles: assignments.map((a) => ({ code: a.role!.code, name: a.role!.name, scope: a.scope, branch_id: a.branchId, department_id: a.departmentId })),
      permissions,
    };
  }
}

export function clientInfo(): ClientInfo {
  const ctx = RequestContext.get();
  return { ip: ctx?.ip ?? null, userAgent: ctx?.userAgent ?? null };
}
