import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import type { EmployeeStatus, EmploymentType, LicenceStatus } from '@sil/hr-shared';
import { AppBaseEntity, SoftDeleteEntity } from '../../common/base.entity';
import { Branch, CostCentre, Department, Position } from '../organisation/organisation.entities';

/**
 * A person the hospital employs. Not a login (see user_account.employee_id).
 * National ID, passport and KRA PIN are AES-256-GCM encrypted (`…Enc`), with an HMAC
 * blind index (`…Bidx`) so they stay unique and searchable by exact value.
 * branch/department/position/cost centre/manager are the *current* assignment,
 * denormalised from employee_position_assignment for fast scoping and listing.
 */
@Entity('employee')
export class Employee extends SoftDeleteEntity {
  @Column({ type: 'uuid' }) organisationId: string;
  @Column({ type: 'varchar', length: 30 }) staffNumber: string;
  @Column({ type: 'varchar', length: 100 }) firstName: string;
  @Column({ type: 'varchar', length: 100, nullable: true }) middleName: string | null;
  @Column({ type: 'varchar', length: 100 }) lastName: string;
  @Column({ type: 'varchar', length: 12, nullable: true }) gender: string | null;
  @Column({ type: 'date', nullable: true }) dateOfBirth: string | null;
  @Column({ type: 'varchar', length: 12, nullable: true }) maritalStatus: string | null;
  @Column({ type: 'varchar', length: 60, nullable: true }) nationality: string | null;
  @Column({ type: 'varchar', length: 300, nullable: true, select: false }) nationalIdEnc: string | null;
  @Column({ type: 'char', length: 64, nullable: true, select: false }) nationalIdBidx: string | null;
  @Column({ type: 'varchar', length: 300, nullable: true, select: false }) passportEnc: string | null;
  @Column({ type: 'char', length: 64, nullable: true, select: false }) passportBidx: string | null;
  @Column({ type: 'varchar', length: 300, nullable: true, select: false }) kraPinEnc: string | null;
  @Column({ type: 'char', length: 64, nullable: true, select: false }) kraPinBidx: string | null;
  @Column({ type: 'varchar', length: 30, nullable: true }) nssfNumber: string | null;
  @Column({ type: 'varchar', length: 30, nullable: true }) shaNumber: string | null;
  @Column({ type: 'varchar', length: 200, nullable: true }) personalEmail: string | null;
  @Column({ type: 'varchar', length: 30, nullable: true }) personalPhone: string | null;
  @Column({ type: 'varchar', length: 200, nullable: true }) workEmail: string | null;
  @Column({ type: 'varchar', length: 30, nullable: true }) workPhone: string | null;
  @Column({ type: 'varchar', length: 300, nullable: true }) postalAddress: string | null;
  @Column({ type: 'varchar', length: 300, nullable: true }) residentialAddress: string | null;
  @Column({ type: 'varchar', length: 12 }) employmentType: EmploymentType;
  @Column({ type: 'varchar', length: 12 }) status: EmployeeStatus;
  @Column({ type: 'date' }) hireDate: string;
  @Column({ type: 'date', nullable: true }) probationEndDate: string | null;
  @Column({ type: 'date', nullable: true }) exitDate: string | null;
  @Column({ type: 'varchar', length: 500, nullable: true }) exitReason: string | null;
  @Column({ type: 'uuid', nullable: true }) branchId: string | null;
  @Column({ type: 'uuid', nullable: true }) departmentId: string | null;
  @Column({ type: 'uuid', nullable: true }) positionId: string | null;
  @Column({ type: 'uuid', nullable: true }) costCentreId: string | null;
  @Column({ type: 'uuid', nullable: true }) managerId: string | null;
  @Column({ type: 'varchar', length: 12, nullable: true }) licenceStatus: LicenceStatus | null;

  @ManyToOne(() => Department, { nullable: true }) @JoinColumn({ name: 'department_id' }) department?: Department | null;
  @ManyToOne(() => Position, { nullable: true }) @JoinColumn({ name: 'position_id' }) position?: Position | null;
  @ManyToOne(() => CostCentre, { nullable: true }) @JoinColumn({ name: 'cost_centre_id' }) costCentre?: CostCentre | null;
  @ManyToOne(() => Branch, { nullable: true }) @JoinColumn({ name: 'branch_id' }) branch?: Branch | null;
  @ManyToOne(() => Employee, { nullable: true }) @JoinColumn({ name: 'manager_id' }) manager?: Employee | null;

  get displayName(): string {
    return [this.firstName, this.middleName, this.lastName].filter(Boolean).join(' ');
  }
}

@Entity('employee_position_assignment')
export class PositionAssignment extends AppBaseEntity {
  @Column({ type: 'uuid' }) employeeId: string;
  @Column({ type: 'uuid' }) positionId: string;
  @Column({ type: 'uuid' }) departmentId: string;
  @Column({ type: 'uuid' }) branchId: string;
  @Column({ type: 'uuid', nullable: true }) costCentreId: string | null;
  @Column({ type: 'uuid', nullable: true }) managerId: string | null;
  @Column({ type: 'date' }) effectiveFrom: string;
  @Column({ type: 'date', nullable: true }) effectiveTo: string | null;
  @Column({ type: 'varchar', length: 500, nullable: true }) reason: string | null;
}

@Entity('employee_status_history')
export class StatusHistory {
  @PrimaryColumn({ type: 'uuid', default: () => 'uuid_generate_v7()' }) id: string;
  @Column({ type: 'uuid' }) employeeId: string;
  @Column({ type: 'varchar', length: 12, nullable: true }) fromStatus: string | null;
  @Column({ type: 'varchar', length: 12 }) toStatus: string;
  @Column({ type: 'date' }) effectiveDate: string;
  @Column({ type: 'varchar', length: 500, nullable: true }) reason: string | null;
  @CreateDateColumn({ type: 'timestamptz', precision: 3 }) createdAt: Date;
  @Column({ type: 'uuid', nullable: true }) createdBy: string | null;
}

@Entity('employee_contact')
export class EmployeeContact extends AppBaseEntity {
  @Column({ type: 'uuid' }) employeeId: string;
  @Column({ type: 'varchar', length: 12 }) kind: 'next_of_kin' | 'emergency';
  @Column({ type: 'varchar', length: 200 }) name: string;
  @Column({ type: 'varchar', length: 20 }) relationship: string;
  @Column({ type: 'varchar', length: 30, nullable: true }) phone: string | null;
  @Column({ type: 'varchar', length: 200, nullable: true }) email: string | null;
  @Column({ type: 'varchar', length: 300, nullable: true }) address: string | null;
  @Column({ type: 'boolean', default: false }) isPrimary: boolean;
}

@Entity('employee_dependant')
export class EmployeeDependant extends AppBaseEntity {
  @Column({ type: 'uuid' }) employeeId: string;
  @Column({ type: 'varchar', length: 200 }) name: string;
  @Column({ type: 'varchar', length: 20 }) relationship: string;
  @Column({ type: 'date', nullable: true }) dateOfBirth: string | null;
  @Column({ type: 'varchar', length: 12, nullable: true }) gender: string | null;
  @Column({ type: 'boolean', default: false }) isBeneficiary: boolean;
}

@Entity('employee_qualification')
export class EmployeeQualification extends AppBaseEntity {
  @Column({ type: 'uuid' }) employeeId: string;
  @Column({ type: 'varchar', length: 20 }) level: string;
  @Column({ type: 'varchar', length: 200 }) title: string;
  @Column({ type: 'varchar', length: 200, nullable: true }) institution: string | null;
  @Column({ type: 'int', nullable: true }) yearAwarded: number | null;
  @Column({ type: 'uuid', nullable: true }) documentId: string | null;
}

@Entity('employee_bank_account')
export class EmployeeBankAccount extends AppBaseEntity {
  @Column({ type: 'uuid' }) employeeId: string;
  @Column({ type: 'varchar', length: 12 }) kind: 'bank' | 'mobile_money';
  @Column({ type: 'varchar', length: 100, nullable: true }) bankName: string | null;
  @Column({ type: 'varchar', length: 10, nullable: true }) bankCode: string | null;
  @Column({ type: 'varchar', length: 100, nullable: true }) branchName: string | null;
  @Column({ type: 'varchar', length: 10, nullable: true }) branchCode: string | null;
  @Column({ type: 'varchar', length: 200 }) accountName: string;
  @Column({ type: 'varchar', length: 300, select: false }) accountNumberEnc: string;
  @Column({ type: 'varchar', length: 4 }) accountLast4: string;
  @Column({ type: 'boolean', default: false }) isPrimary: boolean;
}

@Entity('professional_licence')
export class ProfessionalLicence extends SoftDeleteEntity {
  @Column({ type: 'uuid' }) employeeId: string;
  @ManyToOne(() => Employee) @JoinColumn({ name: 'employee_id' }) employee?: Employee;
  @Column({ type: 'varchar', length: 100 }) licensingBody: string;
  @Column({ type: 'varchar', length: 60 }) licenceNumber: string;
  @Column({ type: 'varchar', length: 100, nullable: true }) category: string | null;
  @Column({ type: 'date', nullable: true }) issueDate: string | null;
  @Column({ type: 'date' }) expiryDate: string;
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) verifiedAt: Date | null;
  @Column({ type: 'uuid', nullable: true }) verifiedBy: string | null;
  @Column({ type: 'boolean', default: false }) suspended: boolean;
  @Column({ type: 'uuid', nullable: true }) documentId: string | null;
  @Column({ type: 'varchar', length: 1000, nullable: true }) notes: string | null;
  /** The expiry date a reminder / lapse event was last sent for (so each is sent once). */
  @Column({ type: 'date', nullable: true }) expiringNotifiedFor: string | null;
  @Column({ type: 'date', nullable: true }) expiredNotifiedFor: string | null;
}

@Entity('document_type')
export class DocumentType extends AppBaseEntity {
  @Column({ type: 'varchar', length: 40 }) code: string;
  @Column({ type: 'varchar', length: 200 }) name: string;
  @Column({ type: 'varchar', length: 500, nullable: true }) description: string | null;
  @Column({ type: 'text', array: true, default: () => "'{}'" }) requiredFor: string[];
  @Column({ type: 'boolean', default: false }) hasExpiry: boolean;
  @Column({ type: 'boolean', default: false }) isSensitive: boolean;
  @Column({ type: 'varchar', length: 10, default: 'active' }) status: 'active' | 'inactive';
}

@Entity('employee_document')
export class EmployeeDocument extends AppBaseEntity {
  @Column({ type: 'uuid' }) employeeId: string;
  @Column({ type: 'uuid' }) documentTypeId: string;
  @ManyToOne(() => DocumentType) @JoinColumn({ name: 'document_type_id' }) documentType?: DocumentType;
  @Column({ type: 'uuid' }) documentId: string;
  @Column({ type: 'date', nullable: true }) expiryDate: string | null;
  @Column({ type: 'varchar', length: 10, default: 'pending' }) verification: 'pending' | 'verified' | 'rejected';
  @Column({ type: 'uuid', nullable: true }) verifiedBy: string | null;
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) verifiedAt: Date | null;
  @Column({ type: 'varchar', length: 500, nullable: true }) notes: string | null;
}

@Entity('contact_change_request')
export class ContactChangeRequest extends AppBaseEntity {
  @Column({ type: 'uuid' }) employeeId: string;
  @Column({ type: 'jsonb' }) changes: Record<string, unknown>;
  @Column({ type: 'varchar', length: 10, default: 'pending' }) status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) decidedAt: Date | null;
  @Column({ type: 'uuid', nullable: true }) decidedBy: string | null;
  @Column({ type: 'varchar', length: 500, nullable: true }) decisionNote: string | null;
}

@Entity('bulk_job')
export class BulkJob extends AppBaseEntity {
  @Column({ type: 'varchar', length: 40 }) kind: string;
  @Column({ type: 'varchar', length: 10, default: 'queued' }) status: 'queued' | 'running' | 'succeeded' | 'failed';
  @Column({ type: 'boolean', default: false }) dryRun: boolean;
  @Column({ type: 'uuid', nullable: true }) inputDocumentId: string | null;
  @Column({ type: 'uuid', nullable: true }) resultDocumentId: string | null;
  @Column({ type: 'jsonb', default: () => "'{}'" }) params: Record<string, unknown>;
  @Column({ type: 'int', nullable: true }) totalRows: number | null;
  @Column({ type: 'int', default: 0 }) processedRows: number;
  @Column({ type: 'int', default: 0 }) createdCount: number;
  @Column({ type: 'int', default: 0 }) updatedCount: number;
  @Column({ type: 'int', default: 0 }) errorCount: number;
  @Column({ type: 'jsonb', default: () => "'[]'" }) errors: { row: number; column: string | null; message: string }[];
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) startedAt: Date | null;
  @Column({ type: 'timestamptz', precision: 3, nullable: true }) finishedAt: Date | null;
  @Column({ type: 'uuid', nullable: true }) requestedBy: string | null;
}

export const EMPLOYEE_ENTITIES = [
  Employee, PositionAssignment, StatusHistory, EmployeeContact, EmployeeDependant, EmployeeQualification, EmployeeBankAccount,
  ProfessionalLicence, DocumentType, EmployeeDocument, ContactChangeRequest, BulkJob,
];
