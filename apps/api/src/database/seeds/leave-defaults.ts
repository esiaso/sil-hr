import type { EntityManager } from 'typeorm';
import { LeaveType, PublicHoliday } from '../../modules/leave/leave.entities';
import { Role } from '../../modules/identity-access/identity.entities';
import { WorkflowDefinition, WorkflowStep } from '../../modules/workflow/workflow.entities';

/**
 * Starting configuration for leave, from the Employment Act 2007 minimums. Every value is
 * editable in the app (Leave setup); HR should confirm the hospital's own policy, which
 * may be more generous. Seeded once: later edits are never overwritten.
 */
const TYPES: Partial<LeaveType>[] = [
  { code: 'annual', name: 'Annual leave', description: 'Employment Act s.28: at least 21 working days per year of service.', counting: 'working_days', accrual: 'monthly', defaultEntitlementDays: 21, carryForwardMaxDays: 10, carryForwardExpiryMonths: 3, encashable: true, minNoticeDays: 7, colour: '#1f7a6d' },
  { code: 'sick', name: 'Sick leave (full pay)', description: 'Employment Act s.30: 7 days on full pay after 2 months of service, with a medical certificate.', counting: 'working_days', accrual: 'none', defaultEntitlementDays: 7, minServiceMonths: 2, requiresDocumentOverDays: 1, colour: '#c2410c' },
  { code: 'sick_half', name: 'Sick leave (half pay)', description: 'Employment Act s.30: a further 7 days on half pay.', payRate: 0.5, counting: 'working_days', accrual: 'none', defaultEntitlementDays: 7, minServiceMonths: 2, requiresDocumentOverDays: 0, colour: '#ea580c' },
  { code: 'maternity', name: 'Maternity leave', description: 'Employment Act s.29: three months on full pay.', counting: 'calendar_days', accrual: 'none', defaultEntitlementDays: 90, gender: 'female', allowHalfDay: false, minNoticeDays: 7, colour: '#be185d' },
  { code: 'paternity', name: 'Paternity leave', description: 'Employment Act s.29(8): two weeks on full pay.', counting: 'calendar_days', accrual: 'none', defaultEntitlementDays: 14, gender: 'male', allowHalfDay: false, colour: '#4338ca' },
  { code: 'compassionate', name: 'Compassionate leave', description: 'Hospital policy (not statutory): confirm the number of days.', counting: 'working_days', accrual: 'none', defaultEntitlementDays: 5, colour: '#6b7280' },
  { code: 'study', name: 'Study leave', description: 'Hospital policy: by approval, usually unpaid. Confirm.', isPaid: false, payRate: 0, counting: 'working_days', accrual: 'none', defaultEntitlementDays: 10, colour: '#0369a1' },
  { code: 'unpaid', name: 'Unpaid leave', description: 'Days without pay; payroll prorates salary for them.', isPaid: false, payRate: 0, counting: 'working_days', accrual: 'none', defaultEntitlementDays: 0, allowNegativeBalance: true, colour: '#374151' },
];

/**
 * Kenyan public holidays (Public Holidays Act, Cap. 110). A holiday falling on a Sunday
 * is observed on the Monday. Eid al-Fitr moves every year and is gazetted shortly before:
 * add it when the Gazette notice is out. Verify every year against the Kenya Gazette.
 */
const HOLIDAYS: [string, string][] = [
  ['2026-01-01', "New Year's Day"], ['2026-04-03', 'Good Friday'], ['2026-04-06', 'Easter Monday'], ['2026-05-01', 'Labour Day'], ['2026-06-01', 'Madaraka Day'],
  ['2026-10-10', 'Mazingira Day'], ['2026-10-20', 'Mashujaa Day'], ['2026-12-12', 'Jamhuri Day'], ['2026-12-25', 'Christmas Day'], ['2026-12-26', 'Boxing Day'],
  ['2027-01-01', "New Year's Day"], ['2027-03-26', 'Good Friday'], ['2027-03-29', 'Easter Monday'], ['2027-05-01', 'Labour Day'], ['2027-06-01', 'Madaraka Day'],
  ['2027-10-11', 'Mazingira Day (observed; 10 Oct is a Sunday)'], ['2027-10-20', 'Mashujaa Day'], ['2027-12-13', 'Jamhuri Day (observed; 12 Dec is a Sunday)'],
  ['2027-12-25', 'Christmas Day'], ['2027-12-27', 'Boxing Day (observed; 26 Dec is a Sunday)'],
];

export async function seedLeaveDefaults(m: EntityManager): Promise<void> {
  for (const t of TYPES) {
    if (!(await m.getRepository(LeaveType).existsBy({ code: t.code }))) await m.getRepository(LeaveType).save(m.getRepository(LeaveType).create(t));
  }
  if (!(await m.getRepository(PublicHoliday).exist())) {
    for (const [date, name] of HOLIDAYS) await m.getRepository(PublicHoliday).insert({ date, name, branchId: null });
  }

  const role = async (code: string) => (await m.getRepository(Role).findOneByOrFail({ code })).id;
  const defs: { code: string; name: string; requestType: string; description: string; conditions: WorkflowDefinition['conditions']; priority: number; steps: Partial<WorkflowStep>[] }[] = [
    {
      code: 'LEAVE-STD', name: 'Leave: standard', requestType: 'leave_request', priority: 100, conditions: {},
      description: 'Line manager approves; more than 5 days also goes to the department head. Escalates to the next manager after 48 hours.',
      steps: [
        { name: 'Line manager', approverRule: 'line_manager', escalateAfterHours: 48, escalateTo: 'next_manager' },
        { name: 'Department head', approverRule: 'department_head', minValue: 6, escalateAfterHours: 48, escalateTo: 'next_manager' },
      ],
    },
    {
      code: 'LEAVE-HR', name: 'Leave: long, family and unpaid', requestType: 'leave_request', priority: 200,
      conditions: { kinds: ['maternity', 'paternity', 'study', 'unpaid'] },
      description: 'Line manager, then any HR officer (they arrange cover and payroll changes).',
      steps: [
        { name: 'Line manager', approverRule: 'line_manager', escalateAfterHours: 48, escalateTo: 'next_manager' },
        { name: 'HR', approverRule: 'role', roleId: await role('hr_officer'), escalateAfterHours: 72, escalateTo: 'role', escalateRoleId: await role('hr_manager') },
      ],
    },
    {
      code: 'ATT-REG', name: 'Attendance correction', requestType: 'attendance_regularisation', priority: 100, conditions: {},
      description: 'The line manager confirms a missed clock-in or clock-out; escalates to HR after 72 hours.',
      steps: [{ name: 'Line manager', approverRule: 'line_manager', escalateAfterHours: 72, escalateTo: 'role', escalateRoleId: await role('hr_officer') }],
    },
    {
      code: 'CONTACT-CHANGE', name: 'Self-service contact change', requestType: 'contact_change', priority: 100, conditions: {},
      description: 'Any HR officer checks the change.',
      steps: [{ name: 'HR check', approverRule: 'role', roleId: await role('hr_officer') }],
    },
  ];
  for (const d of defs) {
    if (await m.getRepository(WorkflowDefinition).existsBy({ code: d.code })) continue;
    const saved = await m.getRepository(WorkflowDefinition).save(m.getRepository(WorkflowDefinition).create({ code: d.code, name: d.name, requestType: d.requestType, description: d.description, conditions: d.conditions, priority: d.priority }));
    await m.getRepository(WorkflowStep).insert(d.steps.map((s, i) => ({ ...s, definitionId: saved.id, stepNo: i + 1 })));
  }
}
