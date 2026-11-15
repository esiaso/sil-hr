import type { EntityManager } from 'typeorm';
import { Role } from '../../modules/identity-access/identity.entities';
import { PerformanceIndicator, ReviewCycle } from '../../modules/performance/performance.entities';
import { CpdRequirement, TrainingEnrolment, TrainingProgramme, TrainingSession } from '../../modules/training/training.entities';
import { WorkflowDefinition, WorkflowStep } from '../../modules/workflow/workflow.entities';

/**
 * Yearly CPD points per licensing body. KMPDC and KMLTTB publish 50 points a calendar year;
 * the NCK figure comes from a secondary source. The hospital should confirm all three, and
 * add PPB and the radiography board, under Training → CPD requirements.
 */
const CPD_REQUIREMENTS: [string, string, string][] = [
  ['KMPDC', '50.0', 'Kenya Medical Practitioners and Dentists Council: 50 points a calendar year (confirm)'],
  ['KMLTTB', '50.0', 'Kenya Medical Laboratory Technicians and Technologists Board: 50 points a calendar year (confirm)'],
  ['NCK', '20.0', 'Nursing Council of Kenya: 20 points a year (secondary source, confirm with NCK)'],
];

const PROGRAMMES: Partial<TrainingProgramme>[] = [
  { code: 'BLS', title: 'Basic Life Support (BLS)', category: 'clinical', delivery: 'classroom', provider: 'In-house resuscitation team', durationHours: '8', cpdPoints: '5', cpdBodies: [], mandatoryFor: 'clinical', refreshMonths: 24, passMark: 80, description: 'Adult and paediatric CPR, AED use and choking. Practical and written assessment.' },
  { code: 'IPC', title: 'Infection prevention and control', category: 'mandatory', delivery: 'classroom', provider: 'IPC committee', durationHours: '3', cpdPoints: '2', cpdBodies: [], mandatoryFor: 'all', refreshMonths: 12, description: 'Hand hygiene, PPE, waste segregation, sharps and outbreak response.' },
  { code: 'FIRE', title: 'Fire safety and evacuation', category: 'mandatory', delivery: 'classroom', provider: 'Facilities', durationHours: '2', cpdPoints: '0', cpdBodies: [], mandatoryFor: 'all', refreshMonths: 12, description: 'Fire extinguishers, evacuation routes and drills.' },
  { code: 'INDUCT', title: 'Hospital induction', category: 'induction', delivery: 'classroom', provider: 'Human Resources', durationHours: '6', cpdPoints: '0', cpdBodies: [], mandatoryFor: 'all', description: 'Mission and values, policies, systems and a site tour for new staff.' },
  { code: 'ACLS', title: 'Advanced Cardiovascular Life Support (ACLS)', category: 'clinical', delivery: 'external', provider: 'Accredited external provider', durationHours: '16', cpdPoints: '10', cpdBodies: ['KMPDC', 'NCK'], passMark: 84, description: 'For doctors and critical care nurses.' },
  { code: 'CUSTCARE', title: 'Patient experience and customer care', category: 'soft_skills', delivery: 'classroom', provider: 'Human Resources', durationHours: '4', cpdPoints: '2', cpdBodies: [], description: 'Communication, complaints handling and confidentiality.' },
];

const INDICATORS: Partial<PerformanceIndicator>[] = [
  { code: 'HAND-HYG', name: 'Hand hygiene compliance', category: 'quality', measure: 'percent', defaultTarget: '≥ 90%', description: 'From monthly IPC audits.' },
  { code: 'DOC-COMP', name: 'Nursing documentation completeness', category: 'clinical', measure: 'percent', defaultTarget: '≥ 95%', description: 'Charts audited each month: observations, care plans, medication records.' },
  { code: 'MED-ERR', name: 'Medication errors attributed', category: 'quality', measure: 'number', defaultTarget: '0', description: 'Incidents reported and attributed after review.' },
  { code: 'PAT-SAT', name: 'Patient satisfaction score', category: 'patient_experience', measure: 'percent', defaultTarget: '≥ 85%', description: 'Ward or clinic survey results.' },
  { code: 'TAT-LAB', name: 'Laboratory turnaround within target', category: 'operational', measure: 'percent', defaultTarget: '≥ 90%', description: 'Results released within the agreed time per test.' },
  { code: 'PUNCT', name: 'Attendance and punctuality', category: 'behaviour', measure: 'rating', defaultTarget: '4', description: 'From time and attendance records and the manager’s view.' },
  { code: 'TEAMWORK', name: 'Teamwork and values', category: 'behaviour', measure: 'rating', defaultTarget: '4', description: 'Respect, compassion and collaboration.' },
  { code: 'CPD-MET', name: 'CPD points for the year', category: 'learning', measure: 'yes_no', defaultTarget: 'Licensing body requirement met', description: 'From the CPD record.' },
  { code: 'MAND-TRN', name: 'Mandatory training current', category: 'learning', measure: 'yes_no', defaultTarget: 'All current', description: 'BLS, IPC and fire safety in date.' },
];

/** Always: approval chains, the CPD requirements, a starting catalogue and indicator library. */
export async function seedTalentDefaults(m: EntityManager): Promise<void> {
  const role = async (code: string) => (await m.getRepository(Role).findOneByOrFail({ code })).id;
  const defs: { code: string; name: string; requestType: string; description: string; kinds: string[] | null; priority: number; steps: Partial<WorkflowStep>[] }[] = [
    {
      code: 'PERFORMANCE', name: 'Appraisals', requestType: 'performance_review', kinds: null, priority: 100,
      description: 'The reviewer’s own manager countersigns the appraisal; the HR manager calibrates and approves it.',
      steps: [
        { name: 'Reviewer’s manager', approverRule: 'line_manager', escalateAfterHours: 120, escalateTo: 'next_manager' },
        { name: 'HR manager', approverRule: 'role', roleId: await role('hr_manager') },
      ],
    },
    { code: 'TRAINING', name: 'Training requests', requestType: 'training_request', kinds: null, priority: 100, description: 'The line manager releases the member of staff for the session.', steps: [{ name: 'Line manager', approverRule: 'line_manager', escalateAfterHours: 72, escalateTo: 'next_manager' }] },
    {
      code: 'TRAINING-FUNDED', name: 'Funded training requests', requestType: 'training_request', kinds: ['funded'], priority: 200,
      description: 'A session the hospital pays for also needs the HR manager.',
      steps: [{ name: 'Line manager', approverRule: 'line_manager', escalateAfterHours: 72, escalateTo: 'next_manager' }, { name: 'HR manager', approverRule: 'role', roleId: await role('hr_manager') }],
    },
  ];
  for (const d of defs) {
    if (await m.getRepository(WorkflowDefinition).existsBy({ code: d.code })) continue;
    const saved = await m.getRepository(WorkflowDefinition).save(m.getRepository(WorkflowDefinition).create({ code: d.code, name: d.name, requestType: d.requestType, description: d.description, conditions: d.kinds ? { kinds: d.kinds } : {}, priority: d.priority }));
    await m.getRepository(WorkflowStep).insert(d.steps.map((s, i) => ({ ...s, definitionId: saved.id, stepNo: i + 1 })));
  }
  if (!(await m.getRepository(CpdRequirement).exist())) {
    await m.getRepository(CpdRequirement).insert(CPD_REQUIREMENTS.map(([licensingBody, pointsPerYear, description]) => ({ licensingBody, pointsPerYear, description })));
  }
  if (!(await m.getRepository(TrainingProgramme).exist())) await m.getRepository(TrainingProgramme).insert(PROGRAMMES);
  if (!(await m.getRepository(PerformanceIndicator).exist())) await m.getRepository(PerformanceIndicator).insert(INDICATORS);
}

/** Sample hospital: a draft annual cycle, two upcoming sessions and a past BLS session with results. */
export async function seedSampleTalent(m: EntityManager): Promise<void> {
  if (await m.getRepository(TrainingSession).exist()) return;
  const year = new Date().getFullYear();
  if (!(await m.getRepository(ReviewCycle).exist())) {
    await m.getRepository(ReviewCycle).insert({ name: `${year} annual appraisal`, kind: 'annual', periodStart: `${year}-01-01`, periodEnd: `${year}-12-31`, goalsDue: `${year}-02-28`, selfReviewDue: `${year}-12-10`, managerReviewDue: `${year}-12-20`, status: 'draft' });
  }
  const prog = new Map((await m.getRepository(TrainingProgramme).find()).map((p) => [p.code, p]));
  const at = (days: number, hour: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + days);
    d.setUTCHours(hour - 3, 0, 0, 0); // Nairobi is UTC+3
    return d;
  };
  const rows = [
    { number: `TRN/SAMPLE/0001`, code: 'BLS', starts: at(-30, 8), ends: at(-30, 17), venue: 'Skills lab, 2nd floor', trainer: 'Resuscitation team', capacity: 20, status: 'completed' as const },
    { number: `TRN/SAMPLE/0002`, code: 'IPC', starts: at(10, 9), ends: at(10, 12), venue: 'Board room', trainer: 'IPC nurse', capacity: 40, status: 'scheduled' as const },
    { number: `TRN/SAMPLE/0003`, code: 'ACLS', starts: at(24, 8), ends: at(25, 17), venue: 'External provider, Upper Hill', trainer: 'Accredited instructors', capacity: 6, cost: '18000.00', status: 'scheduled' as const },
  ];
  for (const r of rows) {
    const p = prog.get(r.code);
    if (!p) continue;
    const s = await m.getRepository(TrainingSession).save(m.getRepository(TrainingSession).create({ number: r.number, programmeId: p.id, startsAt: r.starts, endsAt: r.ends, venue: r.venue, trainer: r.trainer, capacity: r.capacity, costPerPerson: r.cost ?? null, openForRequests: true, status: r.status }));
    if (r.code !== 'BLS') continue;
    // Six medical-ward nurses attended; five passed and earned the points.
    const nurses: { id: string; licensing_body: string | null }[] = await m.query(
      `SELECT e.id, (SELECT licensing_body FROM professional_licence l WHERE l.employee_id = e.id LIMIT 1) AS licensing_body
         FROM employee e JOIN position p ON p.id = e.position_id WHERE p.code = 'RN-MED' ORDER BY e.staff_number LIMIT 6`,
    );
    const done = r.ends.toISOString().slice(0, 10);
    for (const [i, n] of nurses.entries()) {
      const score = i === 5 ? 70 : 82 + i * 3;
      const passed = score >= (p.passMark ?? 0);
      const x = await m.getRepository(TrainingEnrolment).save(m.getRepository(TrainingEnrolment).create({ sessionId: s.id, employeeId: n.id, status: 'attended', score, passed, cpdPoints: passed ? p.cpdPoints : null, completedOn: passed ? done : null }));
      if (passed) await m.query(`INSERT INTO cpd_entry (employee_id, source, enrolment_id, title, provider, activity_date, points, licensing_body, status, verified_at) VALUES ($1, 'training', $2, $3, $4, $5, $6, $7, 'verified', now())`, [n.id, x.id, p.title, p.provider, done, p.cpdPoints, n.licensing_body]);
    }
  }
}
