import type { INestApplicationContext } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { PERMISSIONS, PERMISSION_CODES, SYSTEM_ROLES, type DataScope } from '@sil/hr-shared';
import { encrypt } from '../../common/crypto';
import { rootLogger } from '../../common/logger';
import { RequestContext } from '../../common/request-context';
import { Permission, Role, RoleAssignment, RolePermission, User } from '../../modules/identity-access/identity.entities';
import { PasswordService } from '../../modules/identity-access/password.service';
import { NotificationTemplate } from '../../modules/notifications/notifications.module';
import { NumberingScheme } from '../../modules/numbering/numbering.module';
import { Branch, CostCentre, Department, JobGrade, Organisation, Position } from '../../modules/organisation/organisation.entities';
import { OutboxService } from '../../modules/events/events.module';
import { DocumentType } from '../../modules/employees/employee.entities';
import { seedSampleEmployees } from './sample-employees';
import { seedLeaveDefaults } from './leave-defaults';
import { seedPayrollDefaults, seedSamplePayroll } from './payroll-defaults';
import { seedMedicalDefaults, seedSampleMedical } from './medical-defaults';
import { seedLifecycleDefaults, seedSampleContracts } from './lifecycle-defaults';
import { seedRecruitmentDefaults, seedSampleRecruitment } from './recruitment-defaults';
import { ingestSamplePunches, seedSampleAttendance, seedShifts, type SamplePunches } from './sample-attendance';
import { WebhookSubscription } from '../../modules/webhooks/webhook.entities';

export interface SeedOptions {
  sample: boolean;
  defaultPassword: string | null;
}

/** Fixed development secret shared with the webhook-sink container (sample data only). */
export const SAMPLE_WEBHOOK_SECRET = 'whsec_c2lsLWhyLWRldmVsb3BtZW50LXdlYmhvb2stc2VjcmV0';

/**
 * Idempotent. Reference data (organisation row, permissions, built-in roles, numbering,
 * templates) always; the sample hospital only when asked. Safe to run on every boot.
 */
export async function seedDatabase(app: INestApplicationContext, opts: SeedOptions): Promise<void> {
  const dataSource = app.get(DataSource);
  let punches: SamplePunches = [];
  await RequestContext.run({ actorType: 'system', actorName: 'seed' }, async () => {
    await dataSource.transaction(async (m) => {
      // Several API replicas (or test workers) may boot at once: seed one at a time.
      await m.query(`SELECT pg_advisory_xact_lock(727274)`);
      await seedReference(m);
      if (opts.sample) {
        if (!opts.defaultPassword) throw new Error('SEED_DEFAULT_PASSWORD is required to seed sample users');
        punches = await seedSample(m, app, opts.defaultPassword);
      }
    });
  });
  if (punches.length) await RequestContext.run({ actorType: 'system', actorName: 'seed' }, () => ingestSamplePunches(app, punches));
  rootLogger.info({ sample: opts.sample }, 'Seed complete');
}

async function seedReference(m: EntityManager): Promise<void> {
  if (!(await m.getRepository(Organisation).exists())) {
    await m.getRepository(Organisation).save(m.getRepository(Organisation).create({ code: 'ORG', name: 'Organisation' }));
  }

  // Permissions: insert new codes; grant newly seen codes to the built-in roles that define them, once.
  const existing = new Set((await m.getRepository(Permission).find()).map((p) => p.code));
  const fresh = PERMISSION_CODES.filter((c) => !existing.has(c));
  if (fresh.length) await m.getRepository(Permission).insert(fresh.map((code) => ({ code, description: PERMISSIONS[code] })));
  for (const code of PERMISSION_CODES.filter((c) => existing.has(c))) {
    await m.getRepository(Permission).update({ code }, { description: PERMISSIONS[code] });
  }

  for (const def of SYSTEM_ROLES) {
    let role = await m.getRepository(Role).findOneBy({ code: def.code });
    const isNewRole = !role;
    if (!role) role = await m.getRepository(Role).save(m.getRepository(Role).create({ code: def.code, name: def.name, description: def.description, isSystem: true }));
    const codes = def.permissions === '*' ? PERMISSION_CODES : def.permissions;
    // System Admin always holds everything; other roles get only codes first seen now.
    const grant = def.code === 'system_admin' ? codes : isNewRole ? codes : codes.filter((c) => fresh.includes(c));
    if (grant.length) {
      await m.createQueryBuilder().insert().into(RolePermission).values(grant.map((permissionCode) => ({ roleId: role!.id, permissionCode }))).orIgnore().execute();
    }
  }

  const schemes = [
    { documentType: 'staff_number', name: 'Staff number', prefix: 'SIL', format: '{PREFIX}{SEQ}', padding: 5, reset: 'never' as const },
    { documentType: 'contract', name: 'Employment contract', prefix: 'CON', format: '{PREFIX}/{YYYY}/{SEQ}', padding: 4, reset: 'yearly' as const },
    { documentType: 'payslip', name: 'Payslip', prefix: 'PS', format: '{PREFIX}/{YYYY}{MM}/{SEQ}', padding: 5, reset: 'yearly' as const },
    { documentType: 'job_requisition', name: 'Job requisition', prefix: 'REQ', format: '{PREFIX}/{YYYY}/{SEQ}', padding: 4, reset: 'yearly' as const },
    { documentType: 'leave_request', name: 'Leave request', prefix: 'LV', format: '{PREFIX}/{YYYY}/{SEQ}', padding: 5, reset: 'yearly' as const },
  ];
  for (const s of schemes) {
    if (!(await m.getRepository(NumberingScheme).existsBy({ documentType: s.documentType }))) await m.getRepository(NumberingScheme).save(m.getRepository(NumberingScheme).create(s));
  }

  const templates = [
    {
      code: 'webhook_paused',
      subject: 'Webhook subscription "{{subscription}}" was paused',
      body: 'Deliveries to {{url}} kept failing, so the subscription was paused.\n\n{{reason}}\n\nFix the receiver, then resume the subscription and replay the dead-lettered deliveries from the delivery log.',
      description: 'Sent to webhook administrators when a subscription is paused automatically',
    },
    {
      code: 'licence_expiring',
      subject: '{{body}} licence for {{employee}} expires in {{days}} days',
      body: '{{employee}} ({{staff_number}}): {{body}} licence {{number}} expires on {{expiry}}. Record the renewal before then.',
      description: 'Sent to licence managers when a professional licence enters the reminder window',
    },
    {
      code: 'licence_expired',
      subject: '{{body}} licence for {{employee}} has expired',
      body: '{{employee}} ({{staff_number}}): {{body}} licence {{number}} expired on {{expiry}}. Clinical systems have been told.',
      description: 'Sent to licence managers when a professional licence lapses',
    },
    {
      code: 'contact_change_submitted',
      subject: 'Contact details change from {{employee}}',
      body: '{{employee}} ({{staff_number}}) asked to change their contact details. Review it under People → Contact changes.',
      description: 'Sent to HR when an employee submits a self-service change',
    },
    {
      code: 'approval_task_assigned',
      subject: 'Waiting for your approval: {{summary}}',
      body: '{{summary}}\n\nStep: {{step}}. Open your approvals to approve, reject or return it.',
      description: 'Sent to approvers when a request reaches them',
    },
    {
      code: 'approval_decided',
      subject: 'Your request was {{outcome}}',
      body: '{{summary}} was {{outcome}}.\n\n{{comment}}',
      description: 'Sent to the requester when their request is decided',
    },
    {
      code: 'requisition_approved',
      subject: 'Requisition {{number}} approved',
      body: 'Requisition {{number}} was approved. You can advertise the post under Recruitment.',
      description: 'Sent to recruiters when a job requisition is approved',
    },
    {
      code: 'interview_scheduled',
      subject: 'Interview: {{candidate}} for {{job}}',
      body: 'You are on the panel to interview {{candidate}} for {{job}} at {{at}}. The CV and the feedback form are under My interviews.',
      description: 'Sent to each panel member when an interview is scheduled',
    },
    {
      code: 'checklist_tasks_assigned',
      subject: '{{kind}} tasks for {{name}}',
      body: 'There are {{kind}} tasks for {{name}} for your team. Open My tasks in SIL HR.',
      description: 'Sent to each team with tasks when an onboarding or offboarding checklist starts',
    },
    {
      code: 'contract_expiring',
      subject: '{{name}}: contract ends {{end_date}}',
      body: "{{name}}'s contract ends on {{end_date}} ({{days_left}} days). Renew it or plan the exit.",
      description: 'Sent to contract managers once per fixed-term contract nearing its end',
    },
    {
      code: 'relations_case_opened',
      subject: 'A {{kind}} has been recorded: {{subject}}',
      body: 'A {{kind}} has been recorded on your file: {{subject}}. Open it in SIL HR to read it and acknowledge it.',
      description: 'Sent to an employee when a warning, improvement plan or award is recorded',
    },
    {
      code: 'relations_complaint_raised',
      subject: 'New complaint {{number}}',
      body: 'A member of staff raised complaint {{number}}. Only the people named on it can see it.',
      description: 'Sent to HR managers when staff raise a grievance',
    },
    {
      code: 'medical_limit_threshold',
      subject: '{{name}}: {{category}} cover is at {{threshold}}%',
      body: '{{name}} has used {{threshold}}% of the {{category}} limit for this scheme year. KES {{remaining}} is left. Claims over the limit need approval.',
      description: 'Sent to the member and to medical scheme administrators when a limit reaches 80% or 100%',
    },
    {
      code: 'payslip_ready',
      subject: 'Your payslip for {{period}} is ready',
      body: 'Your payslip for {{period}} (paid on {{pay_date}}) is ready. Open My payslips in SIL HR to view or download it.',
      description: 'Sent to each member of staff when a payroll is approved',
    },
    {
      code: 'connector_failing',
      subject: 'Device connector "{{connector}}" is failing',
      body: 'The last sync failed: {{error}}\n\nPunches from those devices are not arriving. Check the connector under Integrations → Device connectors.',
      description: 'Sent to connector administrators when a device connector starts failing',
    },
  ];
  const documentTypes = [
    { code: 'national_id', name: 'National ID or passport copy', requiredFor: ['permanent', 'contract', 'casual', 'locum', 'intern'], isSensitive: true },
    { code: 'kra_pin_cert', name: 'KRA PIN certificate', requiredFor: ['permanent', 'contract', 'locum'] },
    { code: 'academic_cert', name: 'Academic certificates', requiredFor: ['permanent', 'contract', 'intern'] },
    { code: 'good_conduct', name: 'Certificate of good conduct', requiredFor: ['permanent', 'contract'], hasExpiry: true },
    { code: 'practising_licence', name: 'Practising licence (clinical staff)', requiredFor: [], hasExpiry: true },
    { code: 'medical_fitness', name: 'Medical fitness certificate', requiredFor: ['permanent', 'contract'], isSensitive: true },
    { code: 'signed_contract', name: 'Signed contract', requiredFor: ['permanent', 'contract', 'locum', 'intern'] },
  ];
  await seedLeaveDefaults(m);
  await seedShifts(m);
  await seedPayrollDefaults(m);
  await seedMedicalDefaults(m);
  await seedLifecycleDefaults(m);
  await seedRecruitmentDefaults(m);
  for (const d of documentTypes) {
    if (!(await m.getRepository(DocumentType).existsBy({ code: d.code }))) await m.getRepository(DocumentType).save(m.getRepository(DocumentType).create(d));
  }
  for (const t of templates) {
    if (!(await m.getRepository(NotificationTemplate).existsBy({ code: t.code }))) await m.getRepository(NotificationTemplate).save(m.getRepository(NotificationTemplate).create(t));
  }
}

// ------------------------------------------------------------------ sample hospital

const DEPARTMENTS: { code: string; name: string; parent?: string; branch?: string; cc: string }[] = [
  { code: 'CLIN', name: 'Clinical Services', cc: 'CC-CLIN' },
  { code: 'NURS', name: 'Nursing', parent: 'CLIN', cc: 'CC-NURS' },
  { code: 'MEDW', name: 'Medical Ward', parent: 'NURS', cc: 'CC-NURS' },
  { code: 'SURW', name: 'Surgical Ward', parent: 'NURS', cc: 'CC-NURS' },
  { code: 'MATW', name: 'Maternity', parent: 'NURS', cc: 'CC-NURS' },
  { code: 'ICU', name: 'Intensive Care Unit', parent: 'NURS', cc: 'CC-ICU' },
  { code: 'OPD', name: 'Outpatients', parent: 'CLIN', cc: 'CC-OPD' },
  { code: 'EMER', name: 'Emergency', parent: 'CLIN', cc: 'CC-EMER' },
  { code: 'THTR', name: 'Theatre', parent: 'CLIN', cc: 'CC-THTR' },
  { code: 'LAB', name: 'Laboratory', cc: 'CC-LAB' },
  { code: 'RAD', name: 'Radiology & Imaging', cc: 'CC-RAD' },
  { code: 'PHAR', name: 'Pharmacy', cc: 'CC-PHAR' },
  { code: 'ADMIN', name: 'Administration', cc: 'CC-ADMIN' },
  { code: 'HR', name: 'Human Resources', parent: 'ADMIN', cc: 'CC-ADMIN' },
  { code: 'FIN', name: 'Finance', parent: 'ADMIN', cc: 'CC-FIN' },
  { code: 'ICT', name: 'ICT', parent: 'ADMIN', cc: 'CC-ADMIN' },
  { code: 'PROC', name: 'Procurement & Stores', parent: 'ADMIN', cc: 'CC-PROC' },
  { code: 'FAC', name: 'Facilities & Housekeeping', cc: 'CC-FAC' },
  { code: 'SAT-OPD', name: 'Satellite Clinic Outpatients', branch: 'SAT', cc: 'CC-SAT' },
  { code: 'SAT-LAB', name: 'Satellite Clinic Laboratory', branch: 'SAT', cc: 'CC-SAT' },
];

const COST_CENTRES: [string, string][] = [
  ['CC-CLIN', 'Clinical services'], ['CC-NURS', 'Nursing'], ['CC-ICU', 'Intensive care'], ['CC-OPD', 'Outpatients'], ['CC-EMER', 'Emergency'],
  ['CC-THTR', 'Theatre'], ['CC-LAB', 'Laboratory'], ['CC-RAD', 'Radiology'], ['CC-PHAR', 'Pharmacy'], ['CC-ADMIN', 'Administration'],
  ['CC-FIN', 'Finance'], ['CC-PROC', 'Procurement'], ['CC-FAC', 'Facilities'], ['CC-SAT', 'Satellite clinic'],
];

const GRADES: [string, string, number][] = [
  ['G1', 'Executive', 1], ['G2', 'Senior management', 2], ['G3', 'Management', 3], ['G4', 'Senior professional', 4],
  ['G5', 'Professional', 5], ['G6', 'Technical', 6], ['G7', 'Support', 7], ['G8', 'General staff', 8],
];

const POSITIONS: { code: string; title: string; dept: string; grade: string; headcount: number; clinical?: boolean; licence?: string; reportsTo?: string }[] = [
  { code: 'CEO', title: 'Chief Executive Officer', dept: 'ADMIN', grade: 'G1', headcount: 1 },
  { code: 'DCS', title: 'Director of Clinical Services', dept: 'CLIN', grade: 'G2', headcount: 1, clinical: true, licence: 'KMPDC', reportsTo: 'CEO' },
  { code: 'CNO', title: 'Chief Nursing Officer', dept: 'NURS', grade: 'G2', headcount: 1, clinical: true, licence: 'NCK', reportsTo: 'DCS' },
  { code: 'WM-MED', title: 'Ward Manager, Medical', dept: 'MEDW', grade: 'G4', headcount: 1, clinical: true, licence: 'NCK', reportsTo: 'CNO' },
  { code: 'RN-MED', title: 'Registered Nurse, Medical Ward', dept: 'MEDW', grade: 'G5', headcount: 18, clinical: true, licence: 'NCK', reportsTo: 'WM-MED' },
  { code: 'RN-SUR', title: 'Registered Nurse, Surgical Ward', dept: 'SURW', grade: 'G5', headcount: 16, clinical: true, licence: 'NCK', reportsTo: 'CNO' },
  { code: 'MW', title: 'Midwife', dept: 'MATW', grade: 'G5', headcount: 12, clinical: true, licence: 'NCK', reportsTo: 'CNO' },
  { code: 'RN-ICU', title: 'Critical Care Nurse', dept: 'ICU', grade: 'G5', headcount: 10, clinical: true, licence: 'NCK', reportsTo: 'CNO' },
  { code: 'MO', title: 'Medical Officer', dept: 'OPD', grade: 'G4', headcount: 8, clinical: true, licence: 'KMPDC', reportsTo: 'DCS' },
  { code: 'LABTECH', title: 'Medical Laboratory Technologist', dept: 'LAB', grade: 'G5', headcount: 9, clinical: true, licence: 'KMLTTB', reportsTo: 'DCS' },
  { code: 'RADIOG', title: 'Radiographer', dept: 'RAD', grade: 'G5', headcount: 4, clinical: true, licence: 'SRB', reportsTo: 'DCS' },
  { code: 'PHARM', title: 'Pharmacist', dept: 'PHAR', grade: 'G4', headcount: 4, clinical: true, licence: 'PPB', reportsTo: 'DCS' },
  { code: 'HRM', title: 'Human Resources Manager', dept: 'HR', grade: 'G3', headcount: 1, reportsTo: 'CEO' },
  { code: 'HRO', title: 'Human Resources Officer', dept: 'HR', grade: 'G5', headcount: 2, reportsTo: 'HRM' },
  { code: 'PAYO', title: 'Payroll Officer', dept: 'FIN', grade: 'G5', headcount: 1, reportsTo: 'CEO' },
  { code: 'ICTO', title: 'ICT Officer', dept: 'ICT', grade: 'G5', headcount: 3, reportsTo: 'CEO' },
  { code: 'CLEAN', title: 'Cleaner', dept: 'FAC', grade: 'G8', headcount: 25, reportsTo: 'CEO' },
];

const USERS: { username: string; name: string; role: string; scope: DataScope; branch?: string; dept?: string }[] = [
  { username: 'admin', name: 'System Administrator', role: 'system_admin', scope: 'organisation' },
  { username: 'hr.manager', name: 'Grace Wanjiru (HR Manager)', role: 'hr_manager', scope: 'organisation' },
  { username: 'hr.officer', name: 'Brian Otieno (HR Officer, Main Hospital)', role: 'hr_officer', scope: 'branch', branch: 'MAIN' },
  { username: 'payroll', name: 'Mercy Achieng (Payroll Officer)', role: 'payroll_officer', scope: 'organisation' },
  { username: 'finance', name: 'Peter Kamau (Finance Approver)', role: 'finance_approver', scope: 'organisation' },
  { username: 'head.nursing', name: 'Esther Njeri (Head of Nursing)', role: 'department_head', scope: 'department', dept: 'NURS' },
  { username: 'line.manager', name: 'Daniel Mwangi (Ward Manager)', role: 'line_manager', scope: 'direct_reports' },
  { username: 'recruiter', name: 'Faith Chebet (Recruiter)', role: 'recruiter', scope: 'organisation' },
  { username: 'employee', name: 'John Kiprono (Employee)', role: 'employee', scope: 'own' },
  { username: 'auditor', name: 'Internal Auditor', role: 'auditor', scope: 'organisation' },
  { username: 'billing', name: 'Mary Wanjiku (Medical scheme billing)', role: 'medical_billing', scope: 'organisation' },
  { username: 'it.support', name: 'Kevin Otieno (IT support)', role: 'it_support', scope: 'organisation' },
  { username: 'facilities', name: 'Ruth Akinyi (Facilities)', role: 'facilities', scope: 'organisation' },
];

async function seedSample(m: EntityManager, app: INestApplicationContext, password: string): Promise<SamplePunches> {
  const outbox = app.get(OutboxService);
  const org = await m.getRepository(Organisation).findOneOrFail({ where: {}, order: { createdAt: 'ASC' } });
  if (org.code === 'ORG') {
    Object.assign(org, { code: 'SIL', name: 'SIL Hospital (sample)', legalName: 'SIL Hospital Limited (sample data)', address: 'P.O. Box 00000-00100, Nairobi', phone: '+254 700 000 000', email: 'hr@example.org' });
    await m.getRepository(Organisation).save(org);
  }
  const branches = new Map<string, Branch>();
  for (const [code, name, city] of [['MAIN', 'Main Hospital', 'Nairobi'], ['SAT', 'Satellite Clinic', 'Nairobi']] as const) {
    let b = await m.getRepository(Branch).findOneBy({ code });
    if (!b) {
      b = await m.getRepository(Branch).save(m.getRepository(Branch).create({ organisationId: org.id, code, name, city, county: 'Nairobi' }));
      await outbox.record(m, 'hr.organisation.branch.created.v1', b.id, { id: b.id, code: b.code, name: b.name, status: b.status });
    }
    branches.set(code, b);
  }
  const ccs = new Map<string, CostCentre>();
  for (const [code, name] of COST_CENTRES) {
    let c = await m.getRepository(CostCentre).findOneBy({ code });
    if (!c) {
      c = await m.getRepository(CostCentre).save(m.getRepository(CostCentre).create({ organisationId: org.id, code, name }));
      await outbox.record(m, 'hr.organisation.cost_centre.created.v1', c.id, { id: c.id, code: c.code, name: c.name, status: c.status });
    }
    ccs.set(code, c);
  }
  const depts = new Map<string, Department>();
  for (const d of DEPARTMENTS) {
    let row = await m.getRepository(Department).findOneBy({ code: d.code });
    if (!row) {
      const parent = d.parent ? depts.get(d.parent)! : null;
      row = await m.getRepository(Department).save(
        m.getRepository(Department).create({
          organisationId: org.id,
          branchId: parent?.branchId ?? branches.get(d.branch ?? 'MAIN')!.id,
          parentId: parent?.id ?? null,
          path: parent ? [...parent.path, parent.id] : [],
          costCentreId: ccs.get(d.cc)!.id,
          code: d.code,
          name: d.name,
        }),
      );
      await outbox.record(m, 'hr.organisation.department.created.v1', row.id, { id: row.id, code: row.code, name: row.name, branch_id: row.branchId, parent_id: row.parentId, cost_centre_id: row.costCentreId, status: row.status, path: row.path });
    }
    depts.set(d.code, row);
  }
  const grades = new Map<string, JobGrade>();
  for (const [code, name, rank] of GRADES) {
    let g = await m.getRepository(JobGrade).findOneBy({ code });
    if (!g) g = await m.getRepository(JobGrade).save(m.getRepository(JobGrade).create({ organisationId: org.id, code, name, rank }));
    grades.set(code, g);
  }
  const positions = new Map<string, Position>();
  for (const p of POSITIONS) {
    let row = await m.getRepository(Position).findOneBy({ code: p.code });
    if (!row) {
      row = await m.getRepository(Position).save(
        m.getRepository(Position).create({
          organisationId: org.id, departmentId: depts.get(p.dept)!.id, jobGradeId: grades.get(p.grade)!.id, reportsToPositionId: p.reportsTo ? positions.get(p.reportsTo)!.id : null,
          code: p.code, title: p.title, headcount: p.headcount, isClinical: !!p.clinical, licenceRequired: p.licence ?? null,
        }),
      );
      await outbox.record(m, 'hr.organisation.position.created.v1', row.id, { id: row.id, code: row.code, title: row.title, department_id: row.departmentId, job_grade_id: row.jobGradeId, reports_to_position_id: row.reportsToPositionId, headcount: row.headcount, status: row.status });
    }
    positions.set(p.code, row);
  }

  const hash = await app.get(PasswordService).hash(password);
  for (const u of USERS) {
    let user = await m.getRepository(User).findOneBy({ username: u.username });
    if (user) continue;
    user = await m.getRepository(User).save(m.getRepository(User).create({ username: u.username, displayName: u.name, email: `${u.username}@example.org`, passwordHash: hash, mustChangePassword: false }));
    const role = await m.getRepository(Role).findOneByOrFail({ code: u.role });
    await m.getRepository(RoleAssignment).save(
      m.getRepository(RoleAssignment).create({ userId: user.id, roleId: role.id, scope: u.scope, branchId: u.branch ? branches.get(u.branch)!.id : null, departmentId: u.dept ? depts.get(u.dept)!.id : null }),
    );
  }

  await seedSampleEmployees(m, app);
  await seedSamplePayroll(m);
  await seedSampleMedical(m);
  await seedSampleContracts(m);
  await seedSampleRecruitment(m);
  const punches = await seedSampleAttendance(m);

  // A sample webhook pointed at the development sink that verifies signatures (compose: webhook-sink).
  const sinkUrl = process.env.SAMPLE_WEBHOOK_URL;
  if (sinkUrl && !(await m.getRepository(WebhookSubscription).existsBy({ name: 'Development webhook sink' }))) {
    await m.getRepository(WebhookSubscription).save(
      m.getRepository(WebhookSubscription).create({ name: 'Development webhook sink', url: sinkUrl, eventTypes: ['*'], secretEnc: encrypt(SAMPLE_WEBHOOK_SECRET)!, secretPrefix: SAMPLE_WEBHOOK_SECRET.slice(0, 12) }),
    );
  }
  return punches;
}
