import { Column, CreateDateColumn, DeleteDateColumn, PrimaryColumn, UpdateDateColumn, VersionColumn } from 'typeorm';
import type { ValueTransformer } from 'typeorm';
import Decimal from 'decimal.js';

/**
 * Common columns. The id defaults to `uuid_generate_v7()` in the database, so inserts
 * that omit it (TypeORM, raw SQL, seeds) all get time-ordered UUIDs.
 * Timestamps have millisecond precision so they round-trip through JS Dates and cursors.
 */
export abstract class AppBaseEntity {
  @PrimaryColumn({ type: 'uuid', default: () => 'uuid_generate_v7()' })
  id: string;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', precision: 3 })
  updatedAt: Date;

  /** Actor id (user or API client) filled by the audit subscriber. */
  @Column({ type: 'uuid', nullable: true })
  createdBy: string | null;

  @Column({ type: 'uuid', nullable: true })
  updatedBy: string | null;

  /** Optimistic concurrency: exposed as the ETag, checked against If-Match. */
  @VersionColumn({ default: 1 })
  version: number;
}

/** Adds soft delete. People and structure are never hard-deleted by a UI action. */
export abstract class SoftDeleteEntity extends AppBaseEntity {
  @DeleteDateColumn({ type: 'timestamptz', precision: 3, nullable: true })
  deletedAt: Date | null;
}

/** numeric(14,2) ⇄ decimal string. Arithmetic goes through decimal.js, never JS numbers. */
export const moneyTransformer: ValueTransformer = {
  to: (value: string | Decimal | null | undefined) => (value === null || value === undefined ? value : new Decimal(value).toFixed(2)),
  from: (value: string | null) => (value === null || value === undefined ? null : new Decimal(value).toFixed(2)),
};
export const MONEY = { type: 'numeric', precision: 14, scale: 2, transformer: moneyTransformer } as const;

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
