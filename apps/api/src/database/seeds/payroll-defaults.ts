import type { EntityManager } from 'typeorm';
import { encrypt } from '../../common/crypto';
import { Employee, EmployeeBankAccount } from '../../modules/employees/employee.entities';
import { Role } from '../../modules/identity-access/identity.entities';
import { STATUTORY_SEED } from '../../modules/payroll/payroll.defaults';
import { EmployeeLoan, EmployeePayItem, EmployeeSalary, GlAccountMap, PayComponent, PaymentFileFormat, StatutoryRate } from '../../modules/payroll/payroll.entities';
import { WorkflowDefinition, WorkflowStep } from '../../modules/workflow/workflow.entities';

/**
 * Payroll reference data, seeded once and editable afterwards: built-in components,
 * common allowances and deductions, the statutory tables, placeholder account codes
 * (the chart of accounts is being updated), payment file layouts and the approval chain.
 */
const COMPONENTS: Partial<PayComponent>[] = [
  // Calculated by the payroll; listed so the account mapping and reports can name them.
  { code: 'BASIC', name: 'Basic pay', kind: 'earning', taxable: true, pensionable: true, isSystem: true, sortOrder: 1 },
  { code: 'UNPAID_LEAVE', name: 'Unpaid leave', kind: 'earning', taxable: true, isSystem: true, sortOrder: 2 },
  { code: 'PAYE', name: 'PAYE', kind: 'deduction', taxable: false, isSystem: true, sortOrder: 50 },
  { code: 'NSSF', name: 'NSSF', kind: 'deduction', taxable: false, isSystem: true, sortOrder: 51 },
  { code: 'SHIF', name: 'SHIF', kind: 'deduction', taxable: false, isSystem: true, sortOrder: 52 },
  { code: 'AHL', name: 'Housing Levy', kind: 'deduction', taxable: false, isSystem: true, sortOrder: 53 },
  { code: 'NSSF_ER', name: 'NSSF (employer)', kind: 'employer_contribution', taxable: false, isSystem: true, sortOrder: 90 },
  { code: 'AHL_ER', name: 'Housing Levy (employer)', kind: 'employer_contribution', taxable: false, isSystem: true, sortOrder: 91 },
  { code: 'NITA', name: 'NITA levy', kind: 'employer_contribution', taxable: false, isSystem: true, sortOrder: 92 },
  // Common at Kenyan hospitals: amounts are set per person, so defaults are empty.
  { code: 'HOUSE', name: 'House allowance', kind: 'earning', method: 'fixed', taxable: true, sortOrder: 10 },
  { code: 'TRANSPORT', name: 'Transport allowance', kind: 'earning', method: 'fixed', taxable: true, sortOrder: 11 },
  { code: 'RISK', name: 'Risk allowance', kind: 'earning', method: 'fixed', taxable: true, sortOrder: 12 },
  { code: 'CALL', name: 'On-call allowance', kind: 'earning', method: 'fixed', taxable: true, prorate: false, sortOrder: 13 },
  { code: 'RESPONSIBILITY', name: 'Responsibility allowance', kind: 'earning', method: 'fixed', taxable: true, sortOrder: 14 },
  { code: 'ARREARS', name: 'Salary arrears', kind: 'earning', method: 'fixed', taxable: true, pensionable: true, prorate: false, sortOrder: 20 },
  { code: 'BONUS', name: 'Bonus', kind: 'earning', method: 'fixed', taxable: true, prorate: false, sortOrder: 21 },
  { code: 'LEAVE_PAY', name: 'Leave encashment', kind: 'earning', method: 'fixed', taxable: true, prorate: false, sortOrder: 22 },
  { code: 'PENSION', name: 'Pension (staff contribution)', kind: 'deduction', method: 'percent_basic', taxTreatment: 'pension', taxable: false, prorate: false, sortOrder: 60 },
  { code: 'PENSION_ER', name: 'Pension (employer contribution)', kind: 'employer_contribution', method: 'percent_basic', taxable: false, prorate: false, sortOrder: 93 },
  { code: 'LIFE_COVER', name: 'Life insurance premium', kind: 'deduction', method: 'fixed', taxTreatment: 'insurance', taxable: false, prorate: false, sortOrder: 61 },
  { code: 'HELB', name: 'HELB loan repayment', kind: 'deduction', method: 'fixed', taxable: false, prorate: false, sortOrder: 62 },
  { code: 'LOAN', name: 'Staff loan', kind: 'deduction', method: 'fixed', taxable: false, prorate: false, sortOrder: 63 },
  { code: 'ADVANCE', name: 'Salary advance', kind: 'deduction', method: 'fixed', taxable: false, prorate: false, sortOrder: 64 },
  { code: 'SACCO', name: 'SACCO contribution', kind: 'deduction', method: 'fixed', taxable: false, prorate: false, sortOrder: 65 },
  { code: 'WELFARE', name: 'Staff welfare', kind: 'deduction', method: 'fixed', taxable: false, prorate: false, sortOrder: 66 },
  { code: 'RECOVERY', name: 'Overpayment recovery', kind: 'deduction', method: 'fixed', taxable: false, prorate: false, sortOrder: 67 },
  // Staff contributions to the hospital medical scheme, added by the medical module when contributions are on.
  { code: 'MEDICAL', name: 'Medical scheme contribution', kind: 'deduction', method: 'fixed', taxable: false, prorate: false, isSystem: true, sortOrder: 68 },
  { code: 'MEDICAL_BENEFIT', name: 'Medical cover (taxable benefit)', kind: 'benefit', method: 'fixed', taxable: true, prorate: false, sortOrder: 30 },
];

/** Placeholder account codes until finance confirms the chart of accounts (journals flag every TBD account). */
const ACCOUNTS: Partial<GlAccountMap>[] = [
  { key: 'EARNINGS', description: 'Salaries and wages (default for earnings)', debitAccount: 'TBD-5100' },
  { key: 'OVERTIME', description: 'Overtime', debitAccount: 'TBD-5110' },
  { key: 'DEDUCTIONS', description: 'Other staff deductions payable (default)', creditAccount: 'TBD-2190' },
  { key: 'EMPLOYER', description: 'Employer statutory contributions (default)', debitAccount: 'TBD-5150', creditAccount: 'TBD-2180' },
  { key: 'NET_PAY', description: 'Net salaries payable', creditAccount: 'TBD-2100' },
  { key: 'PAYE', description: 'PAYE payable', creditAccount: 'TBD-2110' },
  { key: 'NSSF', description: 'NSSF payable', creditAccount: 'TBD-2120' },
  { key: 'NSSF_ER', description: 'NSSF employer contribution', debitAccount: 'TBD-5151', creditAccount: 'TBD-2120' },
  { key: 'SHIF', description: 'SHIF payable', creditAccount: 'TBD-2130' },
  { key: 'AHL', description: 'Housing Levy payable', creditAccount: 'TBD-2140' },
  { key: 'AHL_ER', description: 'Housing Levy employer contribution', debitAccount: 'TBD-5152', creditAccount: 'TBD-2140' },
  { key: 'NITA', description: 'NITA levy', debitAccount: 'TBD-5153', creditAccount: 'TBD-2150' },
  { key: 'LOAN', description: 'Staff loans receivable', creditAccount: 'TBD-1310' },
  { key: 'ADVANCE', description: 'Salary advances receivable', creditAccount: 'TBD-1320' },
];

const FORMATS: Partial<PaymentFileFormat>[] = [
  {
    code: 'BANK_XLSX', name: 'Bank transfer (Excel)', channel: 'bank', fileType: 'xlsx', isDefault: true,
    note: 'Generic layout. Change the columns to match the salary bank’s Excel template.',
    columns: [
      { header: 'Beneficiary Name', field: 'account_name' }, { header: 'Account Number', field: 'account_number' }, { header: 'Bank Code', field: 'bank_code' },
      { header: 'Branch Code', field: 'branch_code' }, { header: 'Amount', field: 'amount' }, { header: 'Narration', field: 'reference' }, { header: 'Staff Number', field: 'staff_number' },
    ],
  },
  {
    code: 'MPESA_CSV', name: 'M-Pesa bulk payment (CSV)', channel: 'mobile_money', fileType: 'csv', isDefault: true,
    note: 'Generic layout pending the hospital’s M-Pesa bulk method (B2C portal or bank-mediated). Adjust the columns.',
    columns: [{ header: 'Phone Number', field: 'account_number' }, { header: 'Amount', field: 'amount' }, { header: 'Name', field: 'account_name' }, { header: 'Reference', field: 'reference' }],
  },
];

export async function seedPayrollDefaults(m: EntityManager): Promise<void> {
  for (const c of COMPONENTS) {
    if (!(await m.getRepository(PayComponent).existsBy({ code: c.code! }))) await m.getRepository(PayComponent).save(m.getRepository(PayComponent).create(c));
  }
  if (!(await m.getRepository(StatutoryRate).exist())) {
    for (const r of STATUTORY_SEED) await m.getRepository(StatutoryRate).insert({ code: r.code, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, params: r.params as never, source: r.source });
  }
  for (const a of ACCOUNTS) {
    if (!(await m.getRepository(GlAccountMap).existsBy({ key: a.key! }))) await m.getRepository(GlAccountMap).save(m.getRepository(GlAccountMap).create(a));
  }
  for (const f of FORMATS) {
    if (!(await m.getRepository(PaymentFileFormat).existsBy({ code: f.code! }))) await m.getRepository(PaymentFileFormat).save(m.getRepository(PaymentFileFormat).create(f));
  }
  if (!(await m.getRepository(WorkflowDefinition).existsBy({ code: 'PAYROLL' }))) {
    const role = async (code: string) => (await m.getRepository(Role).findOneByOrFail({ code })).id;
    const d = await m.getRepository(WorkflowDefinition).save(m.getRepository(WorkflowDefinition).create({
      code: 'PAYROLL', name: 'Payroll approval', requestType: 'payroll_run', priority: 100, conditions: {},
      description: 'The HR manager checks the payroll, then a finance approver releases it. The person who submits cannot approve.',
    }));
    await m.getRepository(WorkflowStep).insert([
      { definitionId: d.id, stepNo: 1, name: 'HR manager check', approverRule: 'role', roleId: await role('hr_manager') },
      { definitionId: d.id, stepNo: 2, name: 'Finance approval', approverRule: 'role', roleId: await role('finance_approver') },
    ]);
  }
}

/** Sample hospital only: salaries by grade, allowances, payment accounts and one staff loan. */
export async function seedSamplePayroll(m: EntityManager): Promise<void> {
  if (await m.getRepository(EmployeeSalary).exist()) return;
  const people: { id: string; staff_number: string; first_name: string; last_name: string; hire_date: string; rank: number | null; phone: string | null }[] = await m.query(
    `SELECT e.id, e.staff_number, e.first_name, e.last_name, to_char(e.hire_date, 'YYYY-MM-DD') AS hire_date, g.rank, e.personal_phone AS phone
       FROM employee e LEFT JOIN position p ON p.id = e.position_id LEFT JOIN job_grade g ON g.id = p.job_grade_id ORDER BY e.staff_number`,
  );
  const comp = async (code: string) => (await m.getRepository(PayComponent).findOneByOrFail({ code })).id;
  const [house, transport, risk, pension, pensionEr, loan] = [await comp('HOUSE'), await comp('TRANSPORT'), await comp('RISK'), await comp('PENSION'), await comp('PENSION_ER'), await comp('LOAN')];
  const BY_RANK = [0, 420000, 310000, 220000, 160000, 110000, 78000, 52000, 38000, 30000];
  const banks: [string, string][] = [['KCB Bank', '01'], ['Equity Bank', '68'], ['Co-operative Bank', '11'], ['NCBA Bank', '07']];
  for (const [i, p] of people.entries()) {
    const basic = BY_RANK[Math.min(p.rank ?? 7, BY_RANK.length - 1)] + (i % 5) * 1500;
    const from = p.hire_date > '2026-01-01' ? p.hire_date : '2026-01-01';
    await m.getRepository(EmployeeSalary).insert({ employeeId: p.id, basic: basic.toFixed(2), effectiveFrom: from, effectiveTo: null, reason: 'Sample salary' });
    const items: Partial<EmployeePayItem>[] = [
      { componentId: house, value: Math.round(basic * 0.15) },
      { componentId: transport, value: 6000 },
      { componentId: pension, value: 5 },
      { componentId: pensionEr, value: 10 },
    ];
    if (i % 3 === 0) items.push({ componentId: risk, value: 4500 });
    for (const it of items) await m.getRepository(EmployeePayItem).insert({ ...it, employeeId: p.id, effectiveFrom: from, effectiveTo: null, formula: null, note: null });
    // Most are paid by bank; every seventh person by M-Pesa; two have no account yet.
    if (i % 11 === 10) continue;
    const mobile = i % 7 === 6;
    const number = mobile ? `07${String(10000000 + i * 7919).slice(-8)}` : `${String(1100000000 + i * 104729)}`;
    const [bank, code] = banks[i % banks.length];
    await m.getRepository(EmployeeBankAccount).insert({
      employeeId: p.id, kind: mobile ? 'mobile_money' : 'bank', bankName: mobile ? 'M-Pesa' : bank, bankCode: mobile ? null : code, branchName: mobile ? null : 'Nairobi', branchCode: mobile ? null : '001',
      accountName: `${p.first_name} ${p.last_name}`, accountNumberEnc: encrypt(number)!, accountLast4: number.slice(-4), isPrimary: true,
    });
  }
  const borrower = people[2];
  if (borrower) await m.getRepository(EmployeeLoan).insert({ employeeId: borrower.id, componentId: loan, reference: 'SL-2026-014', principal: '60000.00', installment: '10000.00', startPeriod: '2026-09', status: 'active', note: 'Sample staff loan' });
  void Employee;
}
