import type { EntityManager } from 'typeorm';
import { Role } from '../../modules/identity-access/identity.entities';
import { WorkflowDefinition, WorkflowStep } from '../../modules/workflow/workflow.entities';
import { Announcement, MeetingRoom } from '../../modules/workplace/workplace.entities';

/** Always: approval chains for travel and expense claims. */
export async function seedWorkplaceDefaults(m: EntityManager): Promise<void> {
  const role = async (code: string) => (await m.getRepository(Role).findOneByOrFail({ code })).id;
  const defs: { code: string; name: string; requestType: string; description: string; kinds: string[] | null; priority: number; steps: Partial<WorkflowStep>[] }[] = [
    { code: 'TRAVEL', name: 'Travel requests', requestType: 'travel_request', kinds: null, priority: 100, description: 'The line manager approves the trip.', steps: [{ name: 'Line manager', approverRule: 'line_manager', escalateAfterHours: 48, escalateTo: 'next_manager' }] },
    {
      code: 'TRAVEL-ADVANCE', name: 'Travel requests with an advance', requestType: 'travel_request', kinds: ['advance'], priority: 200,
      description: 'An advance paid through payroll also needs finance.',
      steps: [{ name: 'Line manager', approverRule: 'line_manager', escalateAfterHours: 48, escalateTo: 'next_manager' }, { name: 'Finance', approverRule: 'role', roleId: await role('finance_approver') }],
    },
    {
      code: 'EXPENSE', name: 'Expense claims', requestType: 'expense_claim', kinds: null, priority: 100,
      description: 'The line manager confirms the spending; finance checks the receipts. Approved claims are paid with the next payroll.',
      steps: [{ name: 'Line manager', approverRule: 'line_manager', escalateAfterHours: 72, escalateTo: 'next_manager' }, { name: 'Finance', approverRule: 'role', roleId: await role('finance_approver') }],
    },
  ];
  for (const d of defs) {
    if (await m.getRepository(WorkflowDefinition).existsBy({ code: d.code })) continue;
    const saved = await m.getRepository(WorkflowDefinition).save(m.getRepository(WorkflowDefinition).create({ code: d.code, name: d.name, requestType: d.requestType, description: d.description, conditions: d.kinds ? { kinds: d.kinds } : {}, priority: d.priority }));
    await m.getRepository(WorkflowStep).insert(d.steps.map((s, i) => ({ ...s, definitionId: saved.id, stepNo: i + 1 })));
  }
}

/** Sample hospital: meeting rooms and a welcome announcement. */
export async function seedSampleWorkplace(m: EntityManager): Promise<void> {
  if (!(await m.getRepository(MeetingRoom).exist())) {
    await m.getRepository(MeetingRoom).insert([
      { name: 'Board room', location: 'Administration block, 1st floor', capacity: 16, facilities: 'Screen, video conferencing' },
      { name: 'Nursing seminar room', location: 'Main hospital, 2nd floor', capacity: 30, facilities: 'Projector' },
      { name: 'Skills lab', location: 'Main hospital, 2nd floor', capacity: 20, facilities: 'Manikins, AED trainer' },
    ]);
  }
  if (!(await m.getRepository(Announcement).exist())) {
    await m.getRepository(Announcement).insert({
      title: 'Welcome to SIL HR',
      body: 'You can now see your payslips, apply for leave, book training and claim expenses here, on your phone or a computer.\n\nIf something looks wrong in your record, use My profile to ask HR to correct it.',
      publishAt: new Date(), pinned: true, status: 'published', notifiedAt: new Date(),
    });
  }
}
