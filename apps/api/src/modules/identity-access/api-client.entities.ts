import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, OneToMany, PrimaryColumn } from 'typeorm';
import { AppBaseEntity } from '../../common/base.entity';

/** A machine client (another system) using OAuth 2.0 client credentials. */
@Entity('api_client')
export class ApiClient extends AppBaseEntity {
  /** Public identifier, `hrc_…`. */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 60 })
  clientId: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  description: string | null;

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  scopes: string[];

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @Column({ type: 'int', default: 600 })
  rateLimitPerMinute: number;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  lastUsedAt: Date | null;

  @OneToMany(() => ApiClientSecret, (s) => s.client)
  secrets?: ApiClientSecret[];
}

/**
 * Secrets are 256-bit random values, so a SHA-256 hash is enough (no slow hash needed).
 * Rotation adds a secret and gives the old one an expiry, so consumers can switch over.
 */
@Entity('api_client_secret')
export class ApiClientSecret {
  @PrimaryColumn({ type: 'uuid', default: () => 'uuid_generate_v7()' })
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  apiClientId: string;

  @ManyToOne(() => ApiClient, (c) => c.secrets, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'api_client_id' })
  client?: ApiClient;

  @Index({ unique: true })
  @Column({ type: 'char', length: 64 })
  secretHash: string;

  /** First characters, so admins can tell secrets apart. */
  @Column({ type: 'varchar', length: 12 })
  prefix: string;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt: Date;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  expiresAt: Date | null;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  revokedAt: Date | null;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  lastUsedAt: Date | null;
}
