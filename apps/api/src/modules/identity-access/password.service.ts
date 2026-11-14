import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import type { EntityManager } from 'typeorm';
import { unprocessable } from '../../common/problem';
import { SettingsService } from '../settings/settings.module';

/** OWASP-recommended argon2id parameters (19 MiB, 2 iterations). */
const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

/** A hash to verify against when the user does not exist, so timing does not reveal it. */
let dummyHash: Promise<string> | null = null;

@Injectable()
export class PasswordService {
  constructor(private readonly settings: SettingsService) {}

  hash(password: string): Promise<string> {
    return argon2.hash(password, ARGON2_OPTIONS);
  }

  async verify(hash: string | null | undefined, password: string): Promise<boolean> {
    if (!hash) {
      dummyHash ??= argon2.hash('not-a-real-password', ARGON2_OPTIONS);
      await argon2.verify(await dummyHash, password).catch(() => false);
      return false;
    }
    return argon2.verify(hash, password).catch(() => false);
  }

  /** Throws 422 listing every rule the password breaks. */
  async assertPolicy(password: string, context: { username?: string } = {}, manager?: EntityManager): Promise<void> {
    const p = await this.settings.passwordPolicy(manager);
    const problems: string[] = [];
    if (password.length < p.min_length) problems.push(`at least ${p.min_length} characters`);
    if (p.require_upper && !/[A-Z]/.test(password)) problems.push('an upper-case letter');
    if (p.require_lower && !/[a-z]/.test(password)) problems.push('a lower-case letter');
    if (p.require_digit && !/\d/.test(password)) problems.push('a digit');
    if (p.require_symbol && !/[^A-Za-z0-9]/.test(password)) problems.push('a symbol');
    if (context.username && password.toLowerCase().includes(context.username.toLowerCase())) problems.push('not containing the username');
    if (problems.length) {
      throw unprocessable('weak_password', `The password needs ${problems.join(', ')}`, [{ path: 'password', message: problems.join(', ') }]);
    }
  }
}
