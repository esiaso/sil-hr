import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, OneToMany, PrimaryColumn } from 'typeorm';
import type { DataScope } from '@sil/hr-shared';
import { AppBaseEntity, SoftDeleteEntity } from '../../common/base.entity';
import { Branch, Department } from '../organisation/organisation.entities';

/**
 * A login. Not an employee: employees are people the hospital employs, users are
 * accounts. They link one-to-one, optionally (employee_id, slice 2).
 */
// Unique lower(username) / lower(email) indexes are defined in the migration.
@Entity('user_account')
export class User extends SoftDeleteEntity {
  @Column({ type: 'varchar', length: 60 })
  username: string;

  @Column({ type: 'varchar', length: 200 })
  displayName: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  email: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  phone: string | null;

  /** Null for accounts that only sign in through the identity provider. */
  @Column({ type: 'varchar', length: 255, nullable: true, select: false })
  passwordHash: string | null;

  @Column({ type: 'varchar', length: 10, default: 'active' })
  status: 'active' | 'disabled' | 'locked';

  @Column({ type: 'boolean', default: false })
  mustChangePassword: boolean;

  @Column({ type: 'int', default: 0 })
  failedLoginCount: number;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  lockedUntil: Date | null;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  lastLoginAt: Date | null;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  passwordChangedAt: Date | null;

  @Column({ type: 'boolean', default: false })
  mfaEnabled: boolean;

  /** TOTP secret, AES-256-GCM. Set while enrolling, kept once confirmed. */
  @Column({ type: 'varchar', length: 300, nullable: true, select: false })
  mfaSecretEnc: string | null;

  /** OIDC subject from the identity provider (slice 2). */
  @Column({ type: 'varchar', length: 200, nullable: true })
  externalSubject: string | null;

  /** The employee this account belongs to, if any (FK added with the employee table). */
  @Column({ type: 'uuid', nullable: true })
  employeeId: string | null;

  @OneToMany(() => RoleAssignment, (a) => a.user)
  assignments?: RoleAssignment[];
}

@Entity('permission')
export class Permission {
  @PrimaryColumn({ type: 'varchar', length: 80 })
  code: string;

  @Column({ type: 'varchar', length: 300 })
  description: string;
}

@Entity('role')
export class Role extends AppBaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 60 })
  code: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  description: string | null;

  /** Built-in roles cannot be deleted or renamed (permissions stay editable). */
  @Column({ type: 'boolean', default: false })
  isSystem: boolean;

  @OneToMany(() => RolePermission, (rp) => rp.role)
  rolePermissions?: RolePermission[];
}

@Entity('role_permission')
export class RolePermission {
  @PrimaryColumn({ type: 'uuid' })
  roleId: string;

  @PrimaryColumn({ type: 'varchar', length: 80 })
  permissionCode: string;

  @ManyToOne(() => Role, (r) => r.rolePermissions, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'role_id' })
  role?: Role;

  @ManyToOne(() => Permission, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'permission_code' })
  permission?: Permission;
}

/** A user holds a role within a data scope. A check constraint ties scope to its target. */
@Entity('role_assignment')
export class RoleAssignment extends AppBaseEntity {
  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, (u) => u.assignments, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  @Column({ type: 'uuid' })
  roleId: string;

  @ManyToOne(() => Role, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'role_id' })
  role?: Role;

  @Column({ type: 'varchar', length: 20 })
  scope: DataScope;

  @Column({ type: 'uuid', nullable: true })
  branchId: string | null;

  @ManyToOne(() => Branch, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'branch_id' })
  branch?: Branch | null;

  @Column({ type: 'uuid', nullable: true })
  departmentId: string | null;

  @ManyToOne(() => Department, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'department_id' })
  department?: Department | null;
}

/** Rotating refresh tokens; one family per login. Reusing a rotated token revokes the family. */
@Entity('refresh_token')
export class RefreshToken {
  @PrimaryColumn({ type: 'uuid', default: () => 'uuid_generate_v7()' })
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  @Index({ unique: true })
  @Column({ type: 'char', length: 64 })
  tokenHash: string;

  @Index()
  @Column({ type: 'uuid' })
  familyId: string;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt: Date;

  @Column({ type: 'timestamptz', precision: 3 })
  expiresAt: Date;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  usedAt: Date | null;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  revokedAt: Date | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  ip: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  userAgent: string | null;
}

@Entity('login_history')
@Index(['userId', 'occurredAt'])
export class LoginHistory {
  @PrimaryColumn({ type: 'uuid', default: () => 'uuid_generate_v7()' })
  id: string;

  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ type: 'varchar', length: 200 })
  username: string;

  @Column({ type: 'varchar', length: 20 })
  outcome: string;

  @Column({ type: 'varchar', length: 20 })
  method: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  ip: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  userAgent: string | null;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  occurredAt: Date;
}

@Entity('mfa_recovery_code')
export class MfaRecoveryCode {
  @PrimaryColumn({ type: 'uuid', default: () => 'uuid_generate_v7()' })
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  @Column({ type: 'char', length: 64 })
  codeHash: string;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  usedAt: Date | null;
}

@Entity('ip_allow_rule')
export class IpAllowRule extends AppBaseEntity {
  @Column({ type: 'cidr' })
  cidr: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  description: string | null;

  @Column({ type: 'varchar', length: 10, default: 'all' })
  appliesTo: 'all' | 'admin';

  @Column({ type: 'boolean', default: true })
  isActive: boolean;
}

export const IDENTITY_ENTITIES = [User, Permission, Role, RolePermission, RoleAssignment, RefreshToken, LoginHistory, MfaRecoveryCode, IpAllowRule];
