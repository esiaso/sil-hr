import type { INestApplicationContext } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { DepartmentShiftSetting, RosterEntry, Shift } from '../../modules/attendance/attendance.entities';
import { addDays, zonedToUtc } from '../../modules/attendance/attendance.rules';
import { AttendanceService } from '../../modules/attendance/attendance.service';
import { Department } from '../../modules/organisation/organisation.entities';

/**
 * Starting shifts (editable): a 12-hour day/night pair for inpatient wards, an 8-hour
 * three-shift rotation, and the 08:00–17:00 office day. No overtime rates are seeded:
 * the hospital has none today; HR adds them under Time & attendance → Overtime rules.
 */
export const SHIFTS: Partial<Shift>[] = [
  { code: 'D', name: 'Day (12 h)', startTime: '07:00', endTime: '19:00', breakMinutes: 60, colour: '#f59e0b' },
  { code: 'N', name: 'Night (12 h)', startTime: '19:00', endTime: '07:00', breakMinutes: 60, colour: '#4338ca' },
  { code: 'M', name: 'Morning (8 h)', startTime: '07:00', endTime: '15:00', breakMinutes: 30, colour: '#10b981' },
  { code: 'E', name: 'Evening (8 h)', startTime: '15:00', endTime: '23:00', breakMinutes: 30, colour: '#0ea5e9' },
  { code: 'L', name: 'Late night (8 h)', startTime: '23:00', endTime: '07:00', breakMinutes: 30, colour: '#6d28d9' },
  { code: 'OFFICE', name: 'Office day 08:00–17:00', startTime: '08:00', endTime: '17:00', breakMinutes: 60, colour: '#64748b' },
];

export async function seedShifts(m: EntityManager): Promise<void> {
  for (const s of SHIFTS) if (!(await m.getRepository(Shift).existsBy({ code: s.code }))) await m.getRepository(Shift).save(m.getRepository(Shift).create(s));
}

/** Which department runs what (sample hospital), sample rosters for wards, and two weeks of punches. */
export type SamplePunches = Parameters<AttendanceService['ingest']>[0];

export async function seedSampleAttendance(m: EntityManager): Promise<SamplePunches> {
  if (await m.getRepository(DepartmentShiftSetting).exist()) return [];
  const shift = async (code: string) => (await m.getRepository(Shift).findOneByOrFail({ code })).id;
  const dept = async (code: string) => (await m.getRepository(Department).findOneBy({ code }))?.id;
  const set = async (code: string, mode: 'standing' | 'rostered', codes: string[]) => {
    const id = await dept(code);
    if (!id) return;
    const ids = await Promise.all(codes.map(shift));
    await m.getRepository(DepartmentShiftSetting).save(m.getRepository(DepartmentShiftSetting).create({ departmentId: id, mode, standingShiftId: mode === 'standing' ? ids[0] : null, shiftIds: ids }));
  };
  // The organisation default is the office day; children inherit unless they say otherwise.
  for (const code of ['ADMIN', 'FAC', 'RAD', 'PHAR', 'CLIN', 'SAT-OPD']) await set(code, 'standing', ['OFFICE']);
  await set('NURS', 'rostered', ['D', 'N']);
  await set('LAB', 'rostered', ['D', 'N']);
  await set('ICU', 'rostered', ['M', 'E', 'L']);
  await set('EMER', 'rostered', ['M', 'E', 'L']);

  // Rosters: medical ward on a D,D,N,N,OFF,OFF rotation, staggered, from two weeks ago to two weeks ahead.
  const today = new Date().toISOString().slice(0, 10);
  const from = addDays(today, -14);
  const pattern = ['D', 'D', 'N', 'N', 'OFF', 'OFF'];
  const codes = new Map((await m.getRepository(Shift).find()).map((s) => [s.code, s]));
  const nurses: { id: string }[] = await m.query(`SELECT e.id FROM employee e JOIN department d ON d.id = e.department_id WHERE d.code IN ('MEDW', 'SURW', 'MATW') ORDER BY e.staff_number`);
  for (const [k, n] of nurses.entries()) {
    for (let i = 0, d = from; i < 28; i++, d = addDays(d, 1)) {
      const code = pattern[(i + k) % pattern.length];
      await m.getRepository(RosterEntry).insert(code === 'OFF' ? { employeeId: n.id, workDate: d, shiftId: null, kind: 'off' } : { employeeId: n.id, workDate: d, shiftId: codes.get(code)!.id, kind: 'shift' });
    }
  }

  // Punches for the past fortnight: mostly on time, some late, an occasional missed clock-out.
  const tz = 'Africa/Nairobi';
  const office: { id: string; staff_number: string }[] = await m.query(`SELECT e.id, e.staff_number FROM employee e JOIN department d ON d.id = e.department_id WHERE d.code IN ('HR', 'FIN', 'ICT', 'PROC') ORDER BY e.staff_number`);
  const punches: SamplePunches = [];
  for (const [k, e] of office.entries()) {
    for (let d = from; d < today; d = addDays(d, 1)) {
      const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
      if (wd === 0 || wd === 6) continue;
      const seed = (k * 7 + Number(d.slice(8))) % 10;
      const inAt = zonedToUtc(d, seed === 3 ? '08:41' : `07:${String(45 + seed).padStart(2, '0')}`, tz);
      punches.push({ employeeId: e.id, occurredAt: inAt, direction: 'in', source: 'device', deviceId: 'SAMPLE-ADMIN-01', externalId: `sample:${e.staff_number}:${d}:in` });
      if (seed !== 7) punches.push({ employeeId: e.id, occurredAt: zonedToUtc(d, seed === 5 ? '18:20' : '17:0' + (seed % 10), tz), direction: 'out', source: 'device', deviceId: 'SAMPLE-ADMIN-01', externalId: `sample:${e.staff_number}:${d}:out` });
    }
  }
  // Stored after the seed transaction commits (ingesting opens its own transactions).
  return punches;
}

/** Called after the seed transaction: stores the sample punches and derives the days. */
export async function ingestSamplePunches(app: INestApplicationContext, punches: SamplePunches): Promise<void> {
  if (!punches.length) return;
  const att = app.get(AttendanceService);
  await att.ingest(punches);
  const today = new Date().toISOString().slice(0, 10);
  await att.recompute(null, addDays(today, -14), addDays(today, -1));
}
