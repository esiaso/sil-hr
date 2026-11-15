import type { EntityManager } from 'typeorm';
import { Role } from '../../modules/identity-access/identity.entities';
import { ChecklistTemplate, ChecklistTemplateTask, EmployeeContract, LetterTemplate, type Assignee } from '../../modules/lifecycle/lifecycle.entities';
import { PayComponent } from '../../modules/payroll/payroll.entities';
import { WorkflowDefinition, WorkflowStep } from '../../modules/workflow/workflow.entities';

const ONBOARDING: [string, Assignee, number, string?][] = [
  ['Signed contract and offer letter on file', 'hr', 0],
  ['Documents checked (ID, KRA PIN, NSSF, SHA, certificates, licence)', 'hr', 3],
  ['Salary, bank account and statutory numbers set in payroll', 'hr', 5],
  ['Create email and system accounts (HMIS, procurement as needed)', 'it', 0],
  ['Issue computer or device, if any', 'it', 1],
  ['Staff ID card and access badge', 'facilities', 1],
  ['Locker, keys and uniform', 'facilities', 1],
  ['Department orientation and introductions', 'line_manager', 2],
  ['Agree first-month objectives', 'line_manager', 7],
  ['Read and acknowledge hospital policies (infection control, confidentiality, code of conduct)', 'employee', 5],
  ['Hospital induction day', 'hr', 14],
];
const OFFBOARDING: [string, Assignee, number, boolean][] = [
  ['Handover notes and open work', 'employee', -5, false],
  ['Accept the handover', 'line_manager', -2, true],
  ['Exit interview', 'hr', -3, false],
  ['Return assets recorded in procurement (laptop, phone, equipment)', 'it', 0, true],
  ['Close system access (takes effect when the exit is completed)', 'it', 0, false],
  ['Collect ID card, badge, keys and uniform', 'facilities', 0, true],
  ['Retire petty cash advances and hand over floats', 'finance', 0, true],
  ['Certificate of service', 'hr', 1, false],
];

const LETTERS: { code: string; name: string; body: string }[] = [
  {
    code: 'JOINING', name: 'Joining letter',
    body: `{{organisation.name}}
{{organisation.address}}

Ref: {{letter.number}}
{{today}}

{{employee.full_name}}
Staff number {{employee.staff_number}}

# Welcome to {{organisation.name}}

Dear {{employee.first_name}},

We are pleased to confirm your appointment as {{employee.position}} in the {{employee.department}} department, starting on {{employee.hire_date}}, under contract {{contract.number}}.

Please report to Human Resources at 8:00 am on your first day with the originals of your national ID, KRA PIN certificate, NSSF and SHA cards, academic certificates and, for clinical staff, your current practising licence.

We look forward to working with you.

Yours sincerely,

{{signatory.name}}
{{signatory.title}}`,
  },
  {
    code: 'SERVICE-CERT', name: 'Certificate of service',
    body: `{{organisation.name}}
{{organisation.address}}

Ref: {{letter.number}}
{{today}}

# Certificate of service

This is to certify that {{employee.full_name}} (staff number {{employee.staff_number}}) was employed by {{organisation.name}} from {{employee.hire_date}} to {{employee.exit_date}}. At the time of leaving the position held was {{employee.position}} in the {{employee.department}} department.

This certificate is issued under section 51 of the Employment Act, 2007.

{{signatory.name}}
{{signatory.title}}`,
  },
  {
    code: 'NOC', name: 'No objection letter',
    body: `{{organisation.name}}

Ref: {{letter.number}}
{{today}}

To whom it may concern

# No objection: {{employee.full_name}}

{{employee.full_name}} (staff number {{employee.staff_number}}) has been employed by {{organisation.name}} as {{employee.position}} since {{employee.hire_date}}.

We have no objection to {{employee.first_name}} {{extra.purpose}}.

{{signatory.name}}
{{signatory.title}}`,
  },
  {
    code: 'CONFIRMATION', name: 'Confirmation of appointment',
    body: `{{organisation.name}}

Ref: {{letter.number}}
{{today}}

{{employee.full_name}}
Staff number {{employee.staff_number}}

# Confirmation of appointment

Dear {{employee.first_name}},

Following the successful completion of your probation, we are pleased to confirm your appointment as {{employee.position}} with effect from {{extra.effective_date}}. All other terms of your contract {{contract.number}} remain the same.

Congratulations.

{{signatory.name}}
{{signatory.title}}`,
  },
  {
    code: 'WARNING', name: 'Warning letter',
    body: `{{organisation.name}}

PRIVATE AND CONFIDENTIAL

Ref: {{letter.number}}
{{today}}

{{employee.full_name}}
Staff number {{employee.staff_number}}, {{employee.department}}

# {{extra.level}} warning

Dear {{employee.first_name}},

This letter is a {{extra.level}} warning about {{extra.matter}}.

{{extra.details}}

This warning stays on your file until {{extra.expires_on}}. You may reply in writing within seven days, and you may be accompanied by a colleague or a union representative at any hearing.

{{signatory.name}}
{{signatory.title}}`,
  },
];

/** Always: approval chains, checklist templates, letter templates, the notice pay component. */
export async function seedLifecycleDefaults(m: EntityManager): Promise<void> {
  if (!(await m.getRepository(PayComponent).existsBy({ code: 'NOTICE_PAY' }))) {
    await m.getRepository(PayComponent).save(m.getRepository(PayComponent).create({ code: 'NOTICE_PAY', name: 'Notice pay in lieu', kind: 'earning', method: 'fixed', taxable: true, prorate: false, sortOrder: 23 }));
  }
  const role = async (code: string) => (await m.getRepository(Role).findOneByOrFail({ code })).id;
  const defs: { code: string; name: string; description: string; kinds: string[] | null; priority: number; steps: Partial<WorkflowStep>[] }[] = [
    { code: 'LIFECYCLE', name: 'Lifecycle changes', kinds: null, priority: 100, description: 'Transfers, confirmations and contract renewals: the HR manager approves.', steps: [{ name: 'HR manager', approverRule: 'role', roleId: await role('hr_manager') }] },
    { code: 'LIFECYCLE-PROMO', name: 'Promotions', kinds: ['promotion'], priority: 200, description: 'The department head supports, then the HR manager approves.', steps: [{ name: 'Department head', approverRule: 'department_head', escalateAfterHours: 72, escalateTo: 'next_manager' }, { name: 'HR manager', approverRule: 'role', roleId: await role('hr_manager') }] },
    { code: 'LIFECYCLE-EXIT', name: 'Resignations and terminations', kinds: ['resignation', 'termination'], priority: 200, description: 'The line manager acknowledges, then the HR manager approves the exit date.', steps: [{ name: 'Line manager', approverRule: 'line_manager', escalateAfterHours: 48, escalateTo: 'next_manager' }, { name: 'HR manager', approverRule: 'role', roleId: await role('hr_manager') }] },
    { code: 'LIFECYCLE-DUES', name: 'Final dues', kinds: ['final_dues'], priority: 200, description: 'The HR manager checks the figures, then finance approves the payment.', steps: [{ name: 'HR manager', approverRule: 'role', roleId: await role('hr_manager') }, { name: 'Finance', approverRule: 'role', roleId: await role('finance_approver') }] },
  ];
  for (const d of defs) {
    if (await m.getRepository(WorkflowDefinition).existsBy({ code: d.code })) continue;
    const saved = await m.getRepository(WorkflowDefinition).save(m.getRepository(WorkflowDefinition).create({ code: d.code, name: d.name, requestType: 'lifecycle_change', description: d.description, conditions: d.kinds ? { kinds: d.kinds } : {}, priority: d.priority }));
    await m.getRepository(WorkflowStep).insert(d.steps.map((s, i) => ({ ...s, definitionId: saved.id, stepNo: i + 1 })));
  }
  for (const [code, name, kind, tasks] of [['ONBOARD', 'Standard onboarding', 'onboarding', ONBOARDING], ['OFFBOARD', 'Standard offboarding', 'offboarding', OFFBOARDING]] as const) {
    if (await m.getRepository(ChecklistTemplate).existsBy({ code })) continue;
    const t = await m.getRepository(ChecklistTemplate).save(m.getRepository(ChecklistTemplate).create({ code, name, kind, isDefault: true, employmentTypes: [] }));
    await m.getRepository(ChecklistTemplateTask).insert((tasks as readonly (readonly [string, Assignee, number, boolean?])[]).map(([title, assignee, offset, blocks], i) => ({ templateId: t.id, seq: i + 1, title, assignee, dueOffsetDays: offset, blocksExit: !!blocks })));
  }
  for (const l of LETTERS) {
    if (!(await m.getRepository(LetterTemplate).existsBy({ code: l.code }))) await m.getRepository(LetterTemplate).save(m.getRepository(LetterTemplate).create(l));
  }
}

/** Sample hospital: a contract for every sample employee; nurses on two-year fixed terms, a few ending soon. */
export async function seedSampleContracts(m: EntityManager): Promise<void> {
  if (await m.getRepository(EmployeeContract).exist()) return;
  const people: { id: string; staff_number: string; employment_type: string; hire: string; position_id: string | null }[] = await m.query(
    `SELECT id, staff_number, employment_type, to_char(hire_date, 'YYYY-MM-DD') AS hire, position_id FROM employee WHERE status <> 'exited' ORDER BY staff_number`,
  );
  const today = new Date().toISOString().slice(0, 10);
  for (const [i, p] of people.entries()) {
    const fixed = p.employment_type !== 'permanent' || i % 4 === 1;
    const end = fixed ? (i % 8 === 1 ? new Date(Date.now() + (20 + i) * 86_400_000).toISOString().slice(0, 10) : `${Number(today.slice(0, 4)) + 1}-${p.hire.slice(5)}`) : null;
    await m.getRepository(EmployeeContract).insert({
      number: `CON/SAMPLE/${String(i + 1).padStart(4, '0')}`, employeeId: p.id, contractType: fixed ? 'fixed_term' : 'permanent', positionId: p.position_id, startDate: p.hire,
      endDate: end && end > p.hire ? end : null, probationMonths: 6, noticeDays: fixed ? 30 : 90, status: 'active',
    });
  }
}
