import { z } from 'zod';
import { auditStamps, code, email, isoDateTime, listQuery, name, optionalText, phone, uuid } from './common';

const status = z.enum(['active', 'inactive']);

export const organisation = z.object({
  id: uuid,
  code,
  name,
  legal_name: z.string().nullable(),
  kra_pin: z.string().nullable(),
  nssf_employer_no: z.string().nullable(),
  sha_employer_no: z.string().nullable(),
  address: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  website: z.string().nullable(),
  ...auditStamps,
});
export type Organisation = z.infer<typeof organisation>;

export const updateOrganisation = z.object({
  name: name.optional(),
  legal_name: optionalText(200),
  kra_pin: z.string().trim().regex(/^[AP]\d{9}[A-Z]$/, 'KRA PIN is A or P, 9 digits, then a letter').nullish(),
  nssf_employer_no: optionalText(40),
  sha_employer_no: optionalText(40),
  address: optionalText(500),
  phone: phone.nullish(),
  email: email.nullish(),
  website: z.url().max(200).nullish(),
});
export type UpdateOrganisation = z.infer<typeof updateOrganisation>;

// ---------------------------------------------------------------- branches
export const branch = z.object({
  id: uuid,
  organisation_id: uuid,
  code,
  name,
  address: z.string().nullable(),
  city: z.string().nullable(),
  county: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  timezone: z.string().nullable(),
  status,
  deleted_at: isoDateTime.nullable(),
  ...auditStamps,
});
export type Branch = z.infer<typeof branch>;

export const createBranch = z.object({
  code,
  name,
  address: optionalText(500),
  city: optionalText(100),
  county: optionalText(100),
  phone: phone.nullish(),
  email: email.nullish(),
  /** Overrides the organisation timezone for this site, IANA name. */
  timezone: z.string().max(60).nullish(),
});
export const updateBranch = createBranch.partial().extend({ status: status.optional() });
export type CreateBranch = z.infer<typeof createBranch>;
export type UpdateBranch = z.infer<typeof updateBranch>;

export const branchQuery = listQuery.extend({ status: status.optional() });

// ---------------------------------------------------------------- cost centres
export const costCentre = z.object({
  id: uuid,
  organisation_id: uuid,
  code,
  name,
  description: z.string().nullable(),
  status,
  deleted_at: isoDateTime.nullable(),
  ...auditStamps,
});
export type CostCentre = z.infer<typeof costCentre>;
export const createCostCentre = z.object({ code, name, description: optionalText(500) });
export const updateCostCentre = createCostCentre.partial().extend({ status: status.optional() });
export type CreateCostCentre = z.infer<typeof createCostCentre>;
export type UpdateCostCentre = z.infer<typeof updateCostCentre>;
export const costCentreQuery = listQuery.extend({ status: status.optional() });

// ---------------------------------------------------------------- departments
export const department = z.object({
  id: uuid,
  organisation_id: uuid,
  branch_id: uuid,
  parent_id: uuid.nullable(),
  cost_centre_id: uuid.nullable(),
  code,
  name,
  description: z.string().nullable(),
  /** Materialised path of ancestor ids, root first, excluding this department. */
  path: z.array(uuid),
  depth: z.number().int(),
  status,
  deleted_at: isoDateTime.nullable(),
  ...auditStamps,
});
export type Department = z.infer<typeof department>;

export const createDepartment = z.object({
  code,
  name,
  branch_id: uuid,
  parent_id: uuid.nullish(),
  cost_centre_id: uuid.nullish(),
  description: optionalText(1000),
});
export const updateDepartment = createDepartment.partial().extend({ status: status.optional() });
export type CreateDepartment = z.infer<typeof createDepartment>;
export type UpdateDepartment = z.infer<typeof updateDepartment>;
export const departmentQuery = listQuery.extend({
  status: status.optional(),
  branch_id: uuid.optional(),
  parent_id: uuid.optional(),
});

export interface DepartmentNode extends Department {
  children: DepartmentNode[];
}

// ---------------------------------------------------------------- job grades
export const jobGrade = z.object({
  id: uuid,
  organisation_id: uuid,
  code,
  name,
  rank: z.number().int(),
  description: z.string().nullable(),
  status,
  deleted_at: isoDateTime.nullable(),
  ...auditStamps,
});
export type JobGrade = z.infer<typeof jobGrade>;
export const createJobGrade = z.object({
  code,
  name,
  /** Lower rank = more senior. Used for approval thresholds by grade. */
  rank: z.number().int().min(0).max(1000),
  description: optionalText(500),
});
export const updateJobGrade = createJobGrade.partial().extend({ status: status.optional() });
export type CreateJobGrade = z.infer<typeof createJobGrade>;
export type UpdateJobGrade = z.infer<typeof updateJobGrade>;
export const jobGradeQuery = listQuery.extend({ status: status.optional() });

// ---------------------------------------------------------------- positions
export const position = z.object({
  id: uuid,
  organisation_id: uuid,
  department_id: uuid,
  job_grade_id: uuid.nullable(),
  reports_to_position_id: uuid.nullable(),
  code,
  title: name,
  description: z.string().nullable(),
  headcount: z.number().int(),
  is_clinical: z.boolean(),
  /** Licensing body a holder must be registered with (e.g. NCK), if any. */
  licence_required: z.string().nullable(),
  status,
  deleted_at: isoDateTime.nullable(),
  ...auditStamps,
});
export type Position = z.infer<typeof position>;
export const createPosition = z.object({
  code,
  title: name,
  department_id: uuid,
  job_grade_id: uuid.nullish(),
  reports_to_position_id: uuid.nullish(),
  description: optionalText(2000),
  headcount: z.number().int().min(0).max(10000).default(1),
  is_clinical: z.boolean().default(false),
  licence_required: optionalText(100),
});
// Explicit optionals: a partial() of a defaulted field would re-apply the default on PATCH.
export const updatePosition = createPosition.partial().extend({
  headcount: z.number().int().min(0).max(10000).optional(),
  is_clinical: z.boolean().optional(),
  status: status.optional(),
});
export type CreatePosition = z.infer<typeof createPosition>;
export type UpdatePosition = z.infer<typeof updatePosition>;
export const positionQuery = listQuery.extend({
  status: status.optional(),
  department_id: uuid.optional(),
  job_grade_id: uuid.optional(),
});
