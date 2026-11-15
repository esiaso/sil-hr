import { z } from 'zod';
import { auditStamps, email, isoDate, isoDateTime, listQuery, name, optionalText, phone, uuid } from './common';

export const EMPLOYMENT_TYPES = ['permanent', 'contract', 'casual', 'locum', 'intern'] as const;
export const EMPLOYEE_STATUSES = ['onboarding', 'probation', 'active', 'on_notice', 'suspended', 'exited'] as const;
export const GENDERS = ['female', 'male', 'other', 'undisclosed'] as const;
export const MARITAL_STATUSES = ['single', 'married', 'divorced', 'widowed', 'separated', 'undisclosed'] as const;
export const LICENCE_STATUSES = ['valid', 'expiring', 'expired', 'suspended', 'not_verified'] as const;

export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];
export type LicenceStatus = (typeof LICENCE_STATUSES)[number];

/**
 * Allowed status changes. Exited is final (a returning person is re-hired as a new
 * employment, which keeps history clean for payroll and statutory returns).
 */
export const STATUS_TRANSITIONS: Record<EmployeeStatus, EmployeeStatus[]> = {
  onboarding: ['probation', 'active', 'exited'],
  probation: ['active', 'on_notice', 'suspended', 'exited'],
  active: ['on_notice', 'suspended', 'exited'],
  on_notice: ['active', 'exited'],
  suspended: ['active', 'on_notice', 'exited'],
  exited: [],
};

const kraPin = z.string().trim().toUpperCase().regex(/^[AP]\d{9}[A-Z]$/, 'KRA PIN is A or P, 9 digits, then a letter');
const nationalId = z.string().trim().regex(/^\d{6,9}$/, 'National ID is 6 to 9 digits');

/** Sensitive values come back masked (`****1234`) unless the caller holds employee.sensitive:read. */
export const maskedOrClear = z.string().nullable();

export const employee = z.object({
  id: uuid,
  organisation_id: uuid,
  staff_number: z.string(),
  first_name: z.string(),
  middle_name: z.string().nullable(),
  last_name: z.string(),
  display_name: z.string(),
  gender: z.enum(GENDERS).nullable(),
  date_of_birth: isoDate.nullable(),
  marital_status: z.enum(MARITAL_STATUSES).nullable(),
  nationality: z.string().nullable(),
  national_id: maskedOrClear,
  passport_number: maskedOrClear,
  kra_pin: maskedOrClear,
  nssf_number: z.string().nullable(),
  sha_number: z.string().nullable(),
  /** Whether the sensitive fields above are shown in clear in this response. */
  sensitive_visible: z.boolean(),
  personal_email: z.string().nullable(),
  personal_phone: z.string().nullable(),
  work_email: z.string().nullable(),
  work_phone: z.string().nullable(),
  postal_address: z.string().nullable(),
  residential_address: z.string().nullable(),
  employment_type: z.enum(EMPLOYMENT_TYPES),
  status: z.enum(EMPLOYEE_STATUSES),
  hire_date: isoDate,
  probation_end_date: isoDate.nullable(),
  exit_date: isoDate.nullable(),
  exit_reason: z.string().nullable(),
  branch_id: uuid.nullable(),
  department_id: uuid.nullable(),
  position_id: uuid.nullable(),
  cost_centre_id: uuid.nullable(),
  manager_id: uuid.nullable(),
  user_id: uuid.nullable(),
  licence_status: z.enum(LICENCE_STATUSES).nullable(),
  deleted_at: isoDateTime.nullable(),
  ...auditStamps,
});
export type Employee = z.infer<typeof employee>;

const personFields = {
  first_name: name,
  middle_name: optionalText(100),
  last_name: name,
  gender: z.enum(GENDERS).nullish(),
  date_of_birth: isoDate.nullish(),
  marital_status: z.enum(MARITAL_STATUSES).nullish(),
  nationality: optionalText(60),
  national_id: nationalId.nullish(),
  passport_number: z.string().trim().min(5).max(20).nullish(),
  kra_pin: kraPin.nullish(),
  nssf_number: optionalText(30),
  sha_number: optionalText(30),
  personal_email: email.nullish(),
  personal_phone: phone.nullish(),
  work_email: email.nullish(),
  work_phone: phone.nullish(),
  postal_address: optionalText(300),
  residential_address: optionalText(300),
};

/** Hiring creates the employee and its first position assignment in one step. */
export const hireEmployee = z.object({
  ...personFields,
  /** Leave blank to take the next number from the staff_number scheme. */
  staff_number: z.string().trim().min(1).max(30).nullish(),
  employment_type: z.enum(EMPLOYMENT_TYPES),
  status: z.enum(['onboarding', 'probation', 'active']).default('probation'),
  hire_date: isoDate,
  probation_end_date: isoDate.nullish(),
  position_id: uuid,
  manager_id: uuid.nullish(),
});
export type HireEmployee = z.infer<typeof hireEmployee>;

export const updateEmployee = z.object(personFields).partial().extend({
  employment_type: z.enum(EMPLOYMENT_TYPES).optional(),
  probation_end_date: isoDate.nullish(),
});
export type UpdateEmployee = z.infer<typeof updateEmployee>;

export const changeStatus = z
  .object({
    status: z.enum(EMPLOYEE_STATUSES),
    effective_date: isoDate,
    reason: z.string().trim().min(3).max(500),
  });
export type ChangeStatus = z.infer<typeof changeStatus>;

/** Moves the employee to a new position (and so department/branch) from a date. */
export const transferEmployee = z.object({
  position_id: uuid,
  manager_id: uuid.nullish(),
  effective_from: isoDate,
  reason: z.string().trim().min(3).max(500),
});
export type TransferEmployee = z.infer<typeof transferEmployee>;

export const setManager = z.object({ manager_id: uuid.nullable() });

export const employeeQuery = listQuery.extend({
  status: z.enum(EMPLOYEE_STATUSES).optional(),
  employment_type: z.enum(EMPLOYMENT_TYPES).optional(),
  branch_id: uuid.optional(),
  department_id: uuid.optional(),
  /** Includes every department under it. */
  include_sub_departments: z.enum(['true', 'false']).optional(),
  position_id: uuid.optional(),
  manager_id: uuid.optional(),
  licence_status: z.enum(LICENCE_STATUSES).optional(),
});

// ---------------------------------------------------------------- position history
export const positionAssignment = z.object({
  id: uuid,
  employee_id: uuid,
  position_id: uuid,
  department_id: uuid,
  branch_id: uuid,
  cost_centre_id: uuid.nullable(),
  manager_id: uuid.nullable(),
  effective_from: isoDate,
  effective_to: isoDate.nullable(),
  reason: z.string().nullable(),
  created_at: isoDateTime,
});
export type PositionAssignment = z.infer<typeof positionAssignment>;

export const statusHistoryEntry = z.object({
  id: uuid,
  from_status: z.string().nullable(),
  to_status: z.string(),
  effective_date: isoDate,
  reason: z.string().nullable(),
  created_at: isoDateTime,
  created_by: uuid.nullable(),
});

// ---------------------------------------------------------------- contacts, dependants, qualifications
export const RELATIONSHIPS = ['spouse', 'child', 'parent', 'sibling', 'guardian', 'relative', 'friend', 'other'] as const;

export const contactPerson = z.object({
  id: uuid,
  kind: z.enum(['next_of_kin', 'emergency']),
  name: z.string(),
  relationship: z.enum(RELATIONSHIPS),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  address: z.string().nullable(),
  is_primary: z.boolean(),
});
export const upsertContactPerson = z.object({
  kind: z.enum(['next_of_kin', 'emergency']),
  name,
  relationship: z.enum(RELATIONSHIPS),
  phone: phone.nullish(),
  email: email.nullish(),
  address: optionalText(300),
  is_primary: z.boolean().default(false),
});

export const dependant = z.object({
  id: uuid,
  name: z.string(),
  relationship: z.enum(RELATIONSHIPS),
  date_of_birth: isoDate.nullable(),
  gender: z.enum(GENDERS).nullable(),
  /** Covered on the employee's medical scheme. */
  is_beneficiary: z.boolean(),
});
export const upsertDependant = z.object({
  name,
  relationship: z.enum(RELATIONSHIPS),
  date_of_birth: isoDate.nullish(),
  gender: z.enum(GENDERS).nullish(),
  is_beneficiary: z.boolean().default(false),
});

export const qualification = z.object({
  id: uuid,
  level: z.enum(['certificate', 'diploma', 'higher_diploma', 'degree', 'masters', 'doctorate', 'professional', 'other']),
  title: z.string(),
  institution: z.string().nullable(),
  year_awarded: z.number().int().nullable(),
  document_id: uuid.nullable(),
});
export const upsertQualification = qualification.omit({ id: true }).extend({
  institution: optionalText(200),
  year_awarded: z.number().int().min(1950).max(2100).nullish(),
  document_id: uuid.nullish(),
});

// ---------------------------------------------------------------- payment details (sensitive)
export const bankAccount = z.object({
  id: uuid,
  kind: z.enum(['bank', 'mobile_money']),
  bank_name: z.string().nullable(),
  bank_code: z.string().nullable(),
  branch_name: z.string().nullable(),
  branch_code: z.string().nullable(),
  account_name: z.string(),
  /** Bank account or M-Pesa number; masked without employee.sensitive:read. */
  account_number: z.string(),
  is_primary: z.boolean(),
  sensitive_visible: z.boolean(),
});
export const upsertBankAccount = z
  .object({
    kind: z.enum(['bank', 'mobile_money']),
    bank_name: optionalText(100),
    bank_code: optionalText(10),
    branch_name: optionalText(100),
    branch_code: optionalText(10),
    account_name: name,
    account_number: z.string().trim().min(5).max(30),
    is_primary: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'bank' && !v.bank_name) ctx.addIssue({ code: 'custom', path: ['bank_name'], message: 'Bank name is required' });
    if (v.kind === 'mobile_money' && !/^(\+?254|0)7\d{8}$|^(\+?254|0)1\d{8}$/.test(v.account_number.replace(/\s/g, ''))) {
      ctx.addIssue({ code: 'custom', path: ['account_number'], message: 'Enter a Kenyan mobile number' });
    }
  });

// ---------------------------------------------------------------- professional licences
export const licence = z.object({
  id: uuid,
  employee_id: uuid,
  licensing_body: z.string(),
  licence_number: z.string(),
  category: z.string().nullable(),
  issue_date: isoDate.nullable(),
  expiry_date: isoDate,
  /** Derived from the dates, verification and suspension; never typed in. */
  status: z.enum(LICENCE_STATUSES),
  verified_at: isoDateTime.nullable(),
  verified_by: uuid.nullable(),
  suspended: z.boolean(),
  document_id: uuid.nullable(),
  notes: z.string().nullable(),
  ...auditStamps,
});
export type Licence = z.infer<typeof licence>;
export const createLicence = z
  .object({
    licensing_body: z.string().trim().min(2).max(100),
    licence_number: z.string().trim().min(1).max(60),
    category: optionalText(100),
    issue_date: isoDate.nullish(),
    expiry_date: isoDate,
    document_id: uuid.nullish(),
    notes: optionalText(1000),
  })
  .refine((v) => !v.issue_date || v.issue_date <= v.expiry_date, { path: ['expiry_date'], message: 'Expiry must be on or after issue' });
export const updateLicence = z.object({
  licensing_body: z.string().trim().min(2).max(100).optional(),
  licence_number: z.string().trim().min(1).max(60).optional(),
  category: optionalText(100),
  issue_date: isoDate.nullish(),
  expiry_date: isoDate.optional(),
  document_id: uuid.nullish(),
  notes: optionalText(1000),
  suspended: z.boolean().optional(),
});
export const licenceQuery = listQuery.extend({
  status: z.enum(LICENCE_STATUSES).optional(),
  licensing_body: z.string().optional(),
  expiring_within_days: z.coerce.number().int().min(0).max(730).optional(),
  employee_id: uuid.optional(),
});

// ---------------------------------------------------------------- document checklist
export const documentType = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  required_for: z.array(z.enum(EMPLOYMENT_TYPES)),
  has_expiry: z.boolean(),
  is_sensitive: z.boolean(),
  status: z.enum(['active', 'inactive']),
});
export const upsertDocumentType = z.object({
  code: z.string().trim().min(2).max(40).regex(/^[a-z][a-z0-9_]*$/),
  name,
  description: optionalText(500),
  required_for: z.array(z.enum(EMPLOYMENT_TYPES)).default([]),
  has_expiry: z.boolean().default(false),
  is_sensitive: z.boolean().default(false),
  status: z.enum(['active', 'inactive']).optional(),
});

export const employeeDocument = z.object({
  id: uuid,
  document_type_id: uuid,
  document_type: z.string(),
  document_id: uuid,
  expiry_date: isoDate.nullable(),
  verification: z.enum(['pending', 'verified', 'rejected']),
  verified_by: uuid.nullable(),
  verified_at: isoDateTime.nullable(),
  notes: z.string().nullable(),
  created_at: isoDateTime,
});
export const attachEmployeeDocument = z.object({
  document_type_id: uuid,
  document_id: uuid,
  expiry_date: isoDate.nullish(),
  notes: optionalText(500),
});
export const verifyEmployeeDocument = z.object({
  verification: z.enum(['verified', 'rejected']),
  notes: optionalText(500),
});
/** Required document types and whether each is on file and verified. */
export const documentChecklistItem = z.object({
  document_type_id: uuid,
  code: z.string(),
  name: z.string(),
  required: z.boolean(),
  state: z.enum(['missing', 'pending', 'verified', 'rejected', 'expired']),
  employee_document_id: uuid.nullable(),
});

// ---------------------------------------------------------------- directory (for other systems)
export const directoryEntry = z.object({
  id: uuid,
  staff_number: z.string(),
  display_name: z.string(),
  first_name: z.string(),
  last_name: z.string(),
  status: z.enum(EMPLOYEE_STATUSES),
  employment_type: z.enum(EMPLOYMENT_TYPES),
  branch_id: uuid.nullable(),
  department_id: uuid.nullable(),
  department_code: z.string().nullable(),
  department_name: z.string().nullable(),
  position_id: uuid.nullable(),
  position_title: z.string().nullable(),
  cost_centre_id: uuid.nullable(),
  cost_centre_code: z.string().nullable(),
  manager_id: uuid.nullable(),
  work_email: z.string().nullable(),
  work_phone: z.string().nullable(),
  is_clinical: z.boolean(),
  licence_status: z.enum(LICENCE_STATUSES).nullable(),
  licence_expiry_date: isoDate.nullable(),
  updated_at: isoDateTime,
});
export type DirectoryEntry = z.infer<typeof directoryEntry>;
export const directoryQuery = listQuery.extend({
  status: z.enum(EMPLOYEE_STATUSES).optional(),
  department_id: uuid.optional(),
  include_sub_departments: z.enum(['true', 'false']).optional(),
  branch_id: uuid.optional(),
  cost_centre_id: uuid.optional(),
  is_clinical: z.enum(['true', 'false']).optional(),
  staff_number: z.string().optional(),
  work_email: z.string().optional(),
});

/** Who approves for a person or a department, by role. */
export const approversResponse = z.object({
  subject: z.object({ type: z.enum(['employee', 'department']), id: uuid }),
  line_manager: directoryEntry.pick({ id: true, staff_number: true, display_name: true, work_email: true }).nullable(),
  department_head: directoryEntry.pick({ id: true, staff_number: true, display_name: true, work_email: true }).nullable(),
  chain: z.array(directoryEntry.pick({ id: true, staff_number: true, display_name: true, work_email: true, position_title: true })),
});

// ---------------------------------------------------------------- self-service
export const CONTACT_FIELDS = ['personal_email', 'personal_phone', 'postal_address', 'residential_address', 'marital_status'] as const;
export const contactChangeRequest = z.object({
  id: uuid,
  employee_id: uuid,
  changes: z.record(z.string(), z.unknown()),
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled']),
  submitted_at: isoDateTime,
  decided_at: isoDateTime.nullable(),
  decided_by: uuid.nullable(),
  decision_note: z.string().nullable(),
});
export const submitContactChange = z
  .object({
    personal_email: email.nullish(),
    personal_phone: phone.nullish(),
    postal_address: optionalText(300),
    residential_address: optionalText(300),
    marital_status: z.enum(MARITAL_STATUSES).nullish(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Change at least one field');
export const decideContactChange = z.object({ decision: z.enum(['approved', 'rejected']), note: optionalText(500) });

// ---------------------------------------------------------------- bulk jobs
export const bulkJob = z.object({
  id: uuid,
  kind: z.string(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  dry_run: z.boolean(),
  total_rows: z.number().int().nullable(),
  processed_rows: z.number().int(),
  created_count: z.number().int(),
  updated_count: z.number().int(),
  error_count: z.number().int(),
  errors: z.array(z.object({ row: z.number().int(), column: z.string().nullable(), message: z.string() })),
  result_document_id: uuid.nullable(),
  created_at: isoDateTime,
  finished_at: isoDateTime.nullable(),
});
export type BulkJob = z.infer<typeof bulkJob>;
