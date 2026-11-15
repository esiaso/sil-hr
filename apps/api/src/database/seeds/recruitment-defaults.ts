import type { EntityManager } from 'typeorm';
import { Role } from '../../modules/identity-access/identity.entities';
import { ApplicationEvent, Candidate, JobApplication, JobPosting, JobRequisition } from '../../modules/recruitment/recruitment.entities';
import { WorkflowDefinition, WorkflowStep } from '../../modules/workflow/workflow.entities';

/** Always: approval chains for requisitions and offers (editable under Approval workflows). */
export async function seedRecruitmentDefaults(m: EntityManager): Promise<void> {
  const role = async (code: string) => (await m.getRepository(Role).findOneByOrFail({ code })).id;
  const defs: { code: string; name: string; requestType: string; description: string; kinds: string[] | null; priority: number; steps: Partial<WorkflowStep>[] }[] = [
    {
      code: 'REQUISITION', name: 'Job requisitions', requestType: 'job_requisition', kinds: null, priority: 100,
      description: 'The department head supports the need, the HR manager checks the post and budget, finance approves the cost.',
      steps: [
        { name: 'Department head', approverRule: 'department_head', escalateAfterHours: 72, escalateTo: 'next_manager' },
        { name: 'HR manager', approverRule: 'role', roleId: await role('hr_manager') },
        { name: 'Finance', approverRule: 'role', roleId: await role('finance_approver') },
      ],
    },
    { code: 'OFFER', name: 'Job offers', requestType: 'job_offer', kinds: null, priority: 100, description: 'The HR manager approves offers within the approved salary range.', steps: [{ name: 'HR manager', approverRule: 'role', roleId: await role('hr_manager') }] },
    {
      code: 'OFFER-ABOVE', name: 'Job offers above the range', requestType: 'job_offer', kinds: ['above_range'], priority: 200,
      description: 'An offer above the requisition’s salary range also needs finance.',
      steps: [{ name: 'HR manager', approverRule: 'role', roleId: await role('hr_manager') }, { name: 'Finance', approverRule: 'role', roleId: await role('finance_approver') }],
    },
  ];
  for (const d of defs) {
    if (await m.getRepository(WorkflowDefinition).existsBy({ code: d.code })) continue;
    const saved = await m.getRepository(WorkflowDefinition).save(m.getRepository(WorkflowDefinition).create({ code: d.code, name: d.name, requestType: d.requestType, description: d.description, conditions: d.kinds ? { kinds: d.kinds } : {}, priority: d.priority }));
    await m.getRepository(WorkflowStep).insert(d.steps.map((s, i) => ({ ...s, definitionId: saved.id, stepNo: i + 1 })));
  }
}

/** Sample hospital: an approved requisition for two Registered Nurses, advertised, with three applicants. */
export async function seedSampleRecruitment(m: EntityManager): Promise<void> {
  if (await m.getRepository(JobRequisition).exist()) return;
  const [pos] = await m.query(`SELECT id FROM position WHERE code = 'RN-SUR'`);
  if (!pos) return;
  const r = await m.getRepository(JobRequisition).save(m.getRepository(JobRequisition).create({
    number: 'REQ/SAMPLE/0001', positionId: pos.id, headcount: 2, employmentType: 'permanent', reason: 'new', salaryMin: '70000.00', salaryMax: '95000.00', justification: 'Theatre lists grew by a third this year; the surgical ward needs two more nurses per shift.', status: 'approved',
  }));
  const closing = new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10);
  const p = await m.getRepository(JobPosting).save(m.getRepository(JobPosting).create({
    requisitionId: r.id, slug: 'registered-nurse-surgical-ward-0001', title: 'Registered Nurse, Surgical Ward', summary: 'Join our surgical team caring for patients before and after theatre.',
    description: 'You will plan and deliver nursing care for surgical patients, prepare patients for theatre, manage post-operative recovery, and work day and night shifts on a rota.\n\nWe offer continuing professional development, a hospital-funded staff medical scheme and a supportive team.',
    requirements: 'Diploma or degree in nursing (KRCHN or BScN)\nCurrent Nursing Council of Kenya practising licence\nAt least two years in a surgical ward or theatre\nBLS certification',
    location: 'Main hospital', employmentType: 'permanent', showSalary: true, closingDate: closing, questions: [{ key: 'nck_licence', label: 'Do you hold a current NCK practising licence?', type: 'yes_no', required: true }, { key: 'years_surgical', label: 'Years of surgical nursing experience', type: 'number', required: true }],
    status: 'published', publishedAt: new Date(),
  }));
  const people: [string, string, string, 'applied' | 'shortlisted' | 'interview'][] = [['Akinyi', 'Odhiambo', 'akinyi.odhiambo@example.com', 'interview'], ['Brian', 'Kiptoo', 'brian.kiptoo@example.com', 'shortlisted'], ['Wairimu', 'Kamau', 'wairimu.kamau@example.com', 'applied']];
  const retain = new Date(Date.now() + 730 * 86_400_000).toISOString().slice(0, 10);
  for (const [i, [first, last, email, stage]] of people.entries()) {
    const c = await m.getRepository(Candidate).save(m.getRepository(Candidate).create({ email, firstName: first, lastName: last, phone: `+2547${String(12000000 + i * 3331).slice(-8)}`, location: 'Nairobi', consentAt: new Date(), retainUntil: retain }));
    const a = await m.getRepository(JobApplication).save(m.getRepository(JobApplication).create({ number: `APP/SAMPLE/000${i + 1}`, postingId: p.id, candidateId: c.id, source: 'careers', stage, answers: { nck_licence: 'yes', years_surgical: String(3 + i) } }));
    await m.getRepository(ApplicationEvent).insert({ applicationId: a.id, actorName: 'Careers site', toStage: 'applied' });
  }
}
