import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { AppBaseEntity, numericTransformer } from '../../common/base.entity';

@Entity('shift')
export class Shift extends AppBaseEntity {
  @Column({ type: 'varchar', length: 20 }) code: string;
  @Column({ type: 'varchar', length: 200 }) name: string;
  @Column({ type: 'time' }) startTime: string;
  @Column({ type: 'time' }) endTime: string;
  @Column({ type: 'int', default: 0 }) breakMinutes: number;
  @Column({ type: 'int', nullable: true }) lateGraceMinutes: number | null;
  @Column({ type: 'int', nullable: true }) earlyLeaveGraceMinutes: number | null;
  @Column({ type: 'varchar', length: 7, nullable: true }) colour: string | null;
  @Column({ type: 'varchar', length: 10, default: 'active' }) status: 'active' | 'inactive';
}

@Entity('department_shift_setting')
export class DepartmentShiftSetting extends AppBaseEntity {
  @Column({ type: 'uuid' }) departmentId: string;
  @Column({ type: 'varchar', length: 10 }) mode: 'standing' | 'rostered';
  @Column({ type: 'uuid', nullable: true }) standingShiftId: string | null;
  @Column({ type: 'uuid', array: true, default: () => "'{}'" }) shiftIds: string[];
}

@Entity('roster_entry')
export class RosterEntry extends AppBaseEntity {
  @Column({ type: 'uuid' }) employeeId: string;
  @Column({ type: 'date' }) workDate: string;
  @Column({ type: 'uuid', nullable: true }) shiftId: string | null;
  @Column({ type: 'varchar', length: 5, default: 'shift' }) kind: 'shift' | 'off';
  @Column({ type: 'varchar', length: 200, nullable: true }) note: string | null;
}

/** Immutable (trigger): only an unmatched punch may later be matched to an employee. */
@Entity('clock_event')
export class ClockEvent {
  @PrimaryColumn({ type: 'uuid', default: () => 'uuid_generate_v7()' }) id: string;
  @Column({ type: 'uuid', nullable: true }) employeeId: string | null;
  @Column({ type: 'timestamptz', precision: 3 }) occurredAt: Date;
  @Column({ type: 'varchar', length: 8, default: 'unknown' }) direction: 'in' | 'out' | 'unknown';
  @Column({ type: 'varchar', length: 15 }) source: 'web' | 'mobile' | 'device' | 'import' | 'api' | 'regularisation';
  @Column({ type: 'uuid', nullable: true }) connectorId: string | null;
  @Column({ type: 'varchar', length: 60, nullable: true }) deviceId: string | null;
  @Column({ type: 'varchar', length: 60, nullable: true }) deviceUserId: string | null;
  @Column({ type: 'varchar', length: 200 }) dedupKey: string;
  @Column({ type: 'jsonb', nullable: true }) raw: unknown;
  @CreateDateColumn({ type: 'timestamptz', precision: 3 }) receivedAt: Date;
  @Column({ type: 'uuid', nullable: true }) recordedBy: string | null;
}

@Entity('attendance_day')
export class AttendanceDay {
  @PrimaryColumn({ type: 'uuid', default: () => 'uuid_generate_v7()' }) id: string;
  @Column({ type: 'uuid' }) employeeId: string;
  @Column({ type: 'date' }) workDate: string;
  @Column({ type: 'uuid', nullable: true }) shiftId: string | null;
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) scheduledStart: Date | null;
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) scheduledEnd: Date | null;
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) firstIn: Date | null;
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) lastOut: Date | null;
  @Column({ type: 'int', default: 0 }) workedMinutes: number;
  @Column({ type: 'int', default: 0 }) lateMinutes: number;
  @Column({ type: 'int', default: 0 }) earlyLeaveMinutes: number;
  @Column({ type: 'int', default: 0 }) overtimeMinutes: number;
  @Column({ type: 'varchar', length: 15, default: 'normal' }) dayType: 'normal' | 'rest_day' | 'public_holiday';
  @Column({ type: 'varchar', length: 15 }) status: string;
  @Column({ type: 'uuid', nullable: true }) leaveRequestId: string | null;
  @Column({ type: 'boolean', default: false }) regularised: boolean;
  @Column({ type: 'timestamptz', precision: 3 }) computedAt: Date;
}

@Entity('overtime_rule')
export class OvertimeRule extends AppBaseEntity {
  @Column({ type: 'varchar', length: 15 }) dayType: 'normal' | 'rest_day' | 'public_holiday';
  @Column({ type: 'numeric', precision: 4, scale: 2, nullable: true, transformer: numericTransformer }) multiplier: number | null;
  @Column({ type: 'int', default: 30 }) minMinutes: number;
  @Column({ type: 'boolean', default: false }) requiresApproval: boolean;
  @Column({ type: 'date' }) effectiveFrom: string;
  @Column({ type: 'date', nullable: true }) effectiveTo: string | null;
}

@Entity('attendance_regularisation')
export class Regularisation extends AppBaseEntity {
  @Column({ type: 'uuid' }) employeeId: string;
  @Column({ type: 'date' }) workDate: string;
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) clockIn: Date | null;
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) clockOut: Date | null;
  @Column({ type: 'varchar', length: 500 }) reason: string;
  @Column({ type: 'varchar', length: 10, default: 'pending' }) status: 'pending' | 'approved' | 'rejected' | 'returned' | 'cancelled';
  @Column({ type: 'varchar', length: 1000, nullable: true }) decisionComment: string | null;
}

@Entity('connector')
export class Connector extends AppBaseEntity {
  @Column({ type: 'varchar', length: 40 }) code: string;
  @Column({ type: 'varchar', length: 200 }) name: string;
  @Column({ type: 'varchar', length: 30 }) type: 'zkteco_biotime' | 'zkteco_push' | 'hikvision_isapi' | 'hikvision_push';
  @Column({ type: 'jsonb', default: () => "'{}'" }) config: Record<string, unknown>;
  /** JSON of credentials, AES-256-GCM. */
  @Column({ type: 'varchar', length: 2000, nullable: true, select: false }) credentialsEnc: string | null;
  @Column({ type: 'varchar', length: 15, default: 'staff_number' }) matchBy: 'staff_number' | 'mapping';
  @Column({ type: 'int', nullable: true }) scheduleMinutes: number | null;
  @Column({ type: 'boolean', default: true }) isActive: boolean;
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) cursorAt: Date | null;
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) lastRunAt: Date | null;
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) lastSuccessAt: Date | null;
  @Column({ type: 'varchar', length: 10, default: 'unknown' }) health: 'unknown' | 'ok' | 'degraded' | 'failing';
  @Column({ type: 'varchar', length: 500, nullable: true }) healthMessage: string | null;
}

@Entity('connector_run')
export class ConnectorRun {
  @PrimaryColumn({ type: 'uuid', default: () => 'uuid_generate_v7()' }) id: string;
  @Column({ type: 'uuid' }) connectorId: string;
  @Column({ type: 'varchar', length: 10 }) trigger: 'schedule' | 'manual' | 'push' | 'test';
  @Column({ type: 'varchar', length: 10, default: 'running' }) status: 'running' | 'succeeded' | 'partial' | 'failed';
  @CreateDateColumn({ type: 'timestamptz', precision: 3 }) startedAt: Date;
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) finishedAt: Date | null;
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) windowFrom: Date | null;
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) windowTo: Date | null;
  @Column({ type: 'int', default: 0 }) received: number;
  @Column({ type: 'int', default: 0 }) accepted: number;
  @Column({ type: 'int', default: 0 }) duplicates: number;
  @Column({ type: 'int', default: 0 }) unmatched: number;
  @Column({ type: 'varchar', length: 2000, nullable: true }) error: string | null;
}

@Entity('device_user_mapping')
export class DeviceUserMapping extends AppBaseEntity {
  @Column({ type: 'uuid' }) connectorId: string;
  @Column({ type: 'varchar', length: 60 }) deviceUserId: string;
  @Column({ type: 'uuid' }) employeeId: string;
}

export const ATTENDANCE_ENTITIES = [Shift, DepartmentShiftSetting, RosterEntry, ClockEvent, AttendanceDay, OvertimeRule, Regularisation, Connector, ConnectorRun, DeviceUserMapping];
