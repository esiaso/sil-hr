import type { INestApplicationContext } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { blindIndex, encrypt } from '../../common/crypto';
import { Employee, PositionAssignment, ProfessionalLicence, StatusHistory } from '../../modules/employees/employee.entities';
import { employeeEventData } from '../../modules/employees/employee.mapper';
import { OutboxService } from '../../modules/events/events.module';
import { User } from '../../modules/identity-access/identity.entities';
import { NumberingService } from '../../modules/numbering/numbering.module';
import { Department, Position } from '../../modules/organisation/organisation.entities';

/** Made-up names; any resemblance to real people is accidental. */
const FIRST = ['Achieng', 'Wanjiru', 'Kiprono', 'Njeri', 'Otieno', 'Mwangi', 'Chebet', 'Kamau', 'Atieno', 'Mutua', 'Wambui', 'Kipkemboi', 'Nyambura', 'Odhiambo', 'Jeptoo', 'Kariuki', 'Akinyi', 'Ndungu', 'Moraa', 'Ouma', 'Wairimu', 'Kiplagat', 'Nekesa', 'Muriuki', 'Awino', 'Gitau', 'Cherono', 'Omondi', 'Wangari', 'Kibet'];
const LAST = ['Amollo', 'Barasa', 'Cheruiyot', 'Gachanja', 'Kahindi', 'Langat', 'Macharia', 'Nduta', 'Ochieng', 'Rotich', 'Simiyu', 'Wekesa', 'Kirui', 'Muthoni', 'Okoth', 'Njoroge', 'Kosgei', 'Waweru', 'Onyango', 'Mbugua'];

/** How many of each position's headcount the sample fills. */
const FILL: Record<string, number> = {
  CEO: 1, DCS: 1, CNO: 1, 'WM-MED': 1, 'RN-MED': 6, 'RN-SUR': 4, MW: 3, 'RN-ICU': 3, MO: 4, LABTECH: 3, RADIOG: 2, PHARM: 2, HRM: 1, HRO: 2, PAYO: 1, ICTO: 2, CLEAN: 5,
};

/** Sample users linked to employees: username → position code (first holder). */
const LINKS: Record<string, string> = { 'hr.manager': 'HRM', 'hr.officer': 'HRO', payroll: 'PAYO', 'head.nursing': 'CNO', 'line.manager': 'WM-MED', employee: 'RN-MED' };

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function seedSampleEmployees(m: EntityManager, app: INestApplicationContext): Promise<void> {
  if (await m.getRepository(Employee).exist()) return;
  const outbox = app.get(OutboxService);
  const numbering = app.get(NumberingService);
  const [org] = await m.query(`SELECT id FROM organisation ORDER BY created_at LIMIT 1`);
  const today = new Date().toISOString().slice(0, 10);
  const positions = await m.getRepository(Position).find();
  const depts = new Map((await m.getRepository(Department).find()).map((d) => [d.id, d]));
  const byCode = new Map(positions.map((p) => [p.code, p]));
  const holders = new Map<string, Employee[]>();
  let n = 0;

  // Parents before children so managers exist: walk positions in reporting order.
  const ordered: Position[] = [];
  const visit = (p: Position) => {
    if (ordered.includes(p)) return;
    if (p.reportsToPositionId) visit(positions.find((x) => x.id === p.reportsToPositionId)!);
    ordered.push(p);
  };
  positions.forEach(visit);

  for (const p of ordered) {
    const fill = FILL[p.code] ?? 0;
    const dept = depts.get(p.departmentId)!;
    for (let i = 0; i < fill; i++, n++) {
      const managerHolder = p.reportsToPositionId ? holders.get(positions.find((x) => x.id === p.reportsToPositionId)!.code)?.[0] : undefined;
      const hireDate = addDays(today, -((n * 97) % 2900) - 40);
      const nationalId = String(20_000_000 + n * 7919).slice(0, 8);
      const kraPin = `A${String(100_000_000 + n * 104_729).slice(0, 9)}${String.fromCharCode(65 + (n % 26))}`;
      const first = FIRST[n % FIRST.length];
      const last = LAST[(n * 7) % LAST.length];
      const e = await m.getRepository(Employee).save(
        m.getRepository(Employee).create({
          organisationId: org.id,
          staffNumber: await numbering.next('staff_number', { manager: m, date: hireDate }),
          firstName: first,
          lastName: last,
          gender: n % 3 === 0 ? 'male' : 'female',
          dateOfBirth: addDays('1975-01-01', (n * 211) % 9000),
          nationality: 'Kenyan',
          nationalIdEnc: encrypt(nationalId),
          nationalIdBidx: blindIndex(nationalId),
          kraPinEnc: encrypt(kraPin),
          kraPinBidx: blindIndex(kraPin),
          nssfNumber: `NSSF-S${String(n).padStart(6, '0')}`,
          shaNumber: `SHA-S${String(n).padStart(7, '0')}`,
          workEmail: `${first}.${last}${n}@example.org`.toLowerCase(),
          workPhone: `+254 700 ${String(100000 + n).slice(-6)}`,
          personalPhone: `+254 711 ${String(200000 + n).slice(-6)}`,
          employmentType: p.code === 'CLEAN' ? 'casual' : p.code === 'MO' && i === 3 ? 'locum' : n % 9 === 0 ? 'contract' : 'permanent',
          status: n % 11 === 5 ? 'probation' : 'active',
          hireDate,
          positionId: p.id,
          departmentId: dept.id,
          branchId: dept.branchId,
          costCentreId: dept.costCentreId,
          managerId: managerHolder?.id ?? null,
          licenceStatus: null,
        }),
      );
      await m.getRepository(PositionAssignment).insert({ employeeId: e.id, positionId: p.id, departmentId: dept.id, branchId: dept.branchId, costCentreId: dept.costCentreId, managerId: e.managerId, effectiveFrom: hireDate, effectiveTo: null, reason: 'Hired' });
      await m.getRepository(StatusHistory).insert({ employeeId: e.id, fromStatus: null, toStatus: e.status, effectiveDate: hireDate, reason: 'Hired (sample data)' });
      if (p.licenceRequired) {
        // A spread of expiry dates so every licence state shows up in the sample.
        const offset = n % 7 === 0 ? -12 : n % 5 === 0 ? 35 : 200 + n * 3;
        await m.getRepository(ProfessionalLicence).insert({
          employeeId: e.id,
          licensingBody: p.licenceRequired,
          licenceNumber: `${p.licenceRequired}/S${String(10000 + n)}`,
          issueDate: addDays(today, offset - 365),
          expiryDate: addDays(today, offset),
          verifiedAt: n % 4 === 3 ? null : new Date(),
          suspended: false,
        });
      }
      await outbox.record(m, 'hr.employee.hired.v1', e.id, { ...employeeEventData(e, null), hire_date: hireDate });
      holders.set(p.code, [...(holders.get(p.code) ?? []), e]);
    }
  }

  for (const [username, code] of Object.entries(LINKS)) {
    const holder = holders.get(code)?.[code === 'RN-MED' ? 1 : 0];
    if (holder) await m.getRepository(User).update({ username }, { employeeId: holder.id });
  }
  // The sample employee reports to the sample line manager.
  const rn = holders.get('RN-MED')?.[1];
  const wm = holders.get('WM-MED')?.[0];
  if (rn && wm) {
    await m.getRepository(Employee).update({ id: rn.id }, { managerId: wm.id });
    await m.getRepository(PositionAssignment).update({ employeeId: rn.id }, { managerId: wm.id });
  }
  void byCode;
}
