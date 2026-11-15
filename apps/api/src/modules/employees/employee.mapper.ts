import type { Employee as EmployeeDto, EventData } from '@sil/hr-shared';
import { iso } from '../../common/base.entity';
import { decrypt, mask } from '../../common/crypto';
import type { Employee } from './employee.entities';

export function toEmployeeDto(e: Employee, opts: { sensitive: boolean; userId?: string | null }): EmployeeDto {
  const reveal = (enc: string | null | undefined) => {
    const clear = decrypt(enc ?? null);
    return opts.sensitive ? clear : mask(clear);
  };
  return {
    id: e.id,
    organisation_id: e.organisationId,
    staff_number: e.staffNumber,
    first_name: e.firstName,
    middle_name: e.middleName,
    last_name: e.lastName,
    display_name: e.displayName,
    gender: e.gender as EmployeeDto['gender'],
    date_of_birth: e.dateOfBirth,
    marital_status: e.maritalStatus as EmployeeDto['marital_status'],
    nationality: e.nationality,
    national_id: reveal(e.nationalIdEnc),
    passport_number: reveal(e.passportEnc),
    kra_pin: reveal(e.kraPinEnc),
    nssf_number: e.nssfNumber,
    sha_number: e.shaNumber,
    sensitive_visible: opts.sensitive,
    personal_email: e.personalEmail,
    personal_phone: e.personalPhone,
    work_email: e.workEmail,
    work_phone: e.workPhone,
    postal_address: e.postalAddress,
    residential_address: e.residentialAddress,
    employment_type: e.employmentType,
    status: e.status,
    hire_date: e.hireDate,
    probation_end_date: e.probationEndDate,
    exit_date: e.exitDate,
    exit_reason: e.exitReason,
    branch_id: e.branchId,
    department_id: e.departmentId,
    position_id: e.positionId,
    cost_centre_id: e.costCentreId,
    manager_id: e.managerId,
    user_id: opts.userId ?? null,
    licence_status: e.licenceStatus,
    deleted_at: iso(e.deletedAt),
    created_at: e.createdAt.toISOString(),
    updated_at: e.updatedAt.toISOString(),
    version: e.version,
  };
}

/** The non-sensitive projection every people event carries. */
export type EmployeeEventBase = Omit<EventData<'hr.employee.updated.v1'>, 'changed_fields'>;

export function employeeEventData(e: Employee, userId: string | null): EmployeeEventBase {
  return {
    id: e.id,
    staff_number: e.staffNumber,
    display_name: e.displayName,
    status: e.status,
    employment_type: e.employmentType,
    branch_id: e.branchId,
    department_id: e.departmentId,
    position_id: e.positionId,
    cost_centre_id: e.costCentreId,
    manager_id: e.managerId,
    work_email: e.workEmail,
    user_id: userId,
  };
}

/** Columns that hold personal data: loaded explicitly (they are select: false). */
export const SENSITIVE_COLUMNS = ['e.nationalIdEnc', 'e.passportEnc', 'e.kraPinEnc'];
