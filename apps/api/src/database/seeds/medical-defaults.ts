import type { EntityManager } from 'typeorm';
import { Role } from '../../modules/identity-access/identity.entities';
import { MedicalCategory, MedicalLedger, MedicalLimitRule, MedicalMember, MedicalScheme } from '../../modules/medical/medical.entities';
import { EmployeeDependant } from '../../modules/employees/employee.entities';
import { WorkflowDefinition, WorkflowStep } from '../../modules/workflow/workflow.entities';

/** Always: the approval chain for medical applications (HR officer, then HR manager; editable). */
export async function seedMedicalDefaults(m: EntityManager): Promise<void> {
  if (await m.getRepository(WorkflowDefinition).existsBy({ code: 'MEDICAL' })) return;
  const role = async (code: string) => (await m.getRepository(Role).findOneByOrFail({ code })).id;
  const d = await m.getRepository(WorkflowDefinition).save(m.getRepository(WorkflowDefinition).create({
    code: 'MEDICAL', name: 'Medical scheme applications', requestType: 'medical_application', priority: 100, conditions: {},
    description: 'Joining, dependants, top-ups, pre-authorisations and over-limit claims: an HR officer checks, then the HR manager approves.',
  }));
  await m.getRepository(WorkflowStep).insert([
    { definitionId: d.id, stepNo: 1, name: 'HR officer check', approverRule: 'role', roleId: await role('hr_officer'), escalateAfterHours: 48, escalateTo: 'role', escalateRoleId: await role('hr_manager') },
    { definitionId: d.id, stepNo: 2, name: 'HR manager approval', approverRule: 'role', roleId: await role('hr_manager') },
  ]);
}

/**
 * Sample hospital only: one scheme with the usual categories and limits by grade, the
 * sample employee with a spouse and child, and a few colleagues. Limits here are
 * illustrations, not the hospital's policy.
 */
export async function seedSampleMedical(m: EntityManager): Promise<void> {
  if (await m.getRepository(MedicalScheme).exist()) return;
  const s = await m.getRepository(MedicalScheme).save(m.getRepository(MedicalScheme).create({
    code: 'SMS', name: 'SIL Staff Medical Scheme', description: 'Hospital-funded cover for staff and their families (sample values).', yearStartMonth: 1, unusedLimitPolicy: 'reset',
    carryOverMaxPct: '0', maxDependants: 5, overLimitAction: 'approval', contributionsEnabled: false, status: 'active',
  }));
  const cats: [string, string, 'shared' | 'per_person', string, string | null, number, boolean, string, string | null][] = [
    // code, name, sharing, co-pay %, per-visit cap, waiting days, principal & spouse only, limit, senior limit (G1–G3)
    ['inpatient', 'Inpatient', 'shared', '0', null, 0, false, '1000000.00', '2000000.00'],
    ['outpatient', 'Outpatient', 'shared', '10', '20000.00', 0, false, '100000.00', '200000.00'],
    ['maternity', 'Maternity', 'shared', '0', null, 270, true, '150000.00', '200000.00'],
    ['chronic', 'Chronic conditions', 'shared', '0', null, 90, false, '200000.00', '300000.00'],
    ['dental', 'Dental', 'per_person', '20', null, 0, false, '30000.00', '50000.00'],
    ['optical', 'Optical', 'per_person', '0', null, 0, false, '25000.00', '40000.00'],
  ];
  const grades: { id: string; code: string }[] = await m.query(`SELECT id, code FROM job_grade WHERE code IN ('G1', 'G2', 'G3')`);
  for (const [i, [code, name, sharing, coPay, cap, wait, pso, limit, senior]] of cats.entries()) {
    const c = await m.getRepository(MedicalCategory).save(m.getRepository(MedicalCategory).create({ schemeId: s.id, code, name, sharing, coPayPct: coPay, perVisitCap: cap, waitingDays: wait, principalAndSpouseOnly: pso, sortOrder: i * 10 }));
    await m.getRepository(MedicalLimitRule).insert({ schemeId: s.id, categoryId: c.id, jobGradeId: null, employmentType: null, annualLimit: limit, dependantLimit: sharing === 'per_person' ? limit : null, effectiveFrom: '2026-01-01', effectiveTo: null });
    for (const g of grades) if (senior) await m.getRepository(MedicalLimitRule).insert({ schemeId: s.id, categoryId: c.id, jobGradeId: g.id, employmentType: null, annualLimit: senior, dependantLimit: sharing === 'per_person' ? senior : null, effectiveFrom: '2026-01-01', effectiveTo: null });
  }

  // Members: the employee behind the sample 'employee' login, with a spouse and child, and five colleagues.
  const staff: { id: string; staff_number: string; name: string; hire: string }[] = await m.query(
    `SELECT e.id, e.staff_number, e.first_name || ' ' || e.last_name AS name, to_char(e.hire_date, 'YYYY-MM-DD') AS hire
       FROM employee e LEFT JOIN user_account u ON u.employee_id = e.id WHERE e.status <> 'exited'
      ORDER BY (u.username = 'employee') DESC NULLS LAST, e.staff_number LIMIT 6`,
  );
  const start = '2026-01-01';
  for (const [i, p] of staff.entries()) {
    const principal = await m.getRepository(MedicalMember).save(m.getRepository(MedicalMember).create({ schemeId: s.id, employeeId: p.id, memberNumber: `SMS-${p.staff_number}-00`, name: p.name, relationship: 'principal', coverStart: p.hire > start ? p.hire : start }));
    if (i === 0) {
      const surname = p.name.split(' ').pop();
      const family: [string, 'spouse' | 'child', string, string][] = [[`Daniel ${surname}`, 'spouse', '1988-04-12', 'male'], [`Amani ${surname}`, 'child', '2018-09-03', 'female']];
      for (const [n, [name, rel, dob, gender]] of family.entries()) {
        const d = await m.getRepository(EmployeeDependant).save(m.getRepository(EmployeeDependant).create({ employeeId: p.id, name, relationship: rel, dateOfBirth: dob, gender, isBeneficiary: true }));
        await m.getRepository(MedicalMember).insert({ schemeId: s.id, employeeId: p.id, dependantId: d.id, principalMemberId: principal.id, memberNumber: `SMS-${p.staff_number}-0${n + 1}`, name, relationship: rel, dateOfBirth: dob, coverStart: principal.coverStart });
      }
      // Some outpatient use already this year.
      const op = await m.getRepository(MedicalCategory).findOneByOrFail({ schemeId: s.id, code: 'outpatient' });
      for (const [day, invoice, facility] of [['2026-03-14', '6500.00', 'SIL Hospital OPD'], ['2026-07-02', '12000.00', 'SIL Satellite Clinic']] as const) {
        const scheme = (Number(invoice) * 0.9).toFixed(2);
        await m.getRepository(MedicalLedger).insert({ schemeId: s.id, categoryId: op.id, poolMemberId: principal.id, memberId: principal.id, schemeYear: 2026, entryType: 'claim', amount: scheme, invoiceAmount: invoice, memberShare: (Number(invoice) - Number(scheme)).toFixed(2), occurredOn: day, facility, invoiceRef: `INV-${day.replace(/-/g, '')}`, source: 'system' });
      }
    }
  }
}
