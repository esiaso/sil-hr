import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { z } from 'zod';
import {
  attendanceQuery, clockEventBatch, requestRegularisation, rosterChange, rosterPattern, setDepartmentShifts, upsertOvertimeRule, upsertShift,
  type AttendanceDay as DayDto, type Page, type Shift as ShiftDto,
} from '@sil/hr-shared';
import { AccessProfile, applyScope, scopeAllows } from '../../common/access';
import { assertVersion } from '../../common/etag';
import { notFound, ProblemException, unprocessable } from '../../common/problem';
import { Employee } from '../employees/employee.entities';
import { OutboxService } from '../events/events.module';
import { LeaveService } from '../leave/leave.service';
import { ScopeService } from '../organisation/scope.service';
import { SettingsService } from '../settings/settings.module';
import { WorkflowInstance } from '../workflow/workflow.entities';
import { WorkflowService } from '../workflow/workflow.service';
import { AttendanceDay, ClockEvent, DepartmentShiftSetting, OvertimeRule, Regularisation, RosterEntry, Shift } from './attendance.entities';
import { addDays, computeDay, localDate, scheduleFor, shiftMinutes, WINDOW_AFTER_MIN, WINDOW_BEFORE_MIN, type ShiftDef } from './attendance.rules';

export interface IncomingPunch {
  employeeId?: string;
  staffNumber?: string;
  deviceUserId?: string;
  occurredAt: Date;
  direction: 'in' | 'out' | 'unknown';
  source: ClockEvent['source'];
  connectorId?: string | null;
  deviceId?: string | null;
  externalId?: string | null;
  raw?: unknown;
  recordedBy?: string | null;
}

export interface IngestResult {
  accepted: number;
  duplicates: number;
  unmatched: number;
  errors: { index: number; message: string }[];
}

const toShiftDto = (s: Shift): ShiftDto => ({
  id: s.id, code: s.code, name: s.name, start_time: s.startTime.slice(0, 5), end_time: s.endTime.slice(0, 5), crosses_midnight: s.endTime.slice(0, 5) <= s.startTime.slice(0, 5),
  paid_minutes: shiftMinutes(s), break_minutes: s.breakMinutes, late_grace_minutes: s.lateGraceMinutes, early_leave_grace_minutes: s.earlyLeaveGraceMinutes, colour: s.colour, status: s.status,
  created_at: s.createdAt.toISOString(), updated_at: s.updatedAt.toISOString(), version: s.version,
});

@Injectable()
export class AttendanceService implements OnModuleInit {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly scope: ScopeService,
    private readonly settings: SettingsService,
    private readonly outbox: OutboxService,
    private readonly workflow: WorkflowService,
    private readonly leave: LeaveService,
  ) {}

  onModuleInit(): void {
    // Regularisations are decided through the approval engine.
    this.workflow.registerHandler('attendance_regularisation', {
      onApproved: (m, i) => this.applyRegularisation(m, i),
      onRejected: (m, i, c) => this.closeRegularisation(m, i, 'rejected', c),
      onReturned: (m, i, c) => this.closeRegularisation(m, i, 'returned', c),
    });
    // Leave counts rostered staff on their planned shifts instead of the working week.
    this.leave.registerScheduleProvider(async (m, employeeId, from, to) => {
      const mode = await this.modeFor(m, employeeId);
      if (mode?.mode !== 'rostered') return undefined;
      const rows: { d: string; kind: string }[] = await m.query(
        `SELECT to_char(work_date, 'YYYY-MM-DD') AS d, kind FROM roster_entry WHERE employee_id = $1 AND work_date BETWEEN $2 AND $3`,
        [employeeId, from, to],
      );
      const planned = new Map<string, boolean>();
      for (const r of rows) planned.set(r.d, (planned.get(r.d) ?? false) || r.kind === 'shift');
      // Unplanned days fall back to the working week.
      return (d: string) => planned.get(d);
    });
  }

  // ------------------------------------------------------------------ shifts
  async shifts() {
    return (await this.dataSource.getRepository(Shift).find({ order: { startTime: 'ASC' } })).map(toShiftDto);
  }

  async saveShift(dto: z.infer<typeof upsertShift>, id?: string, version?: number) {
    const repo = this.dataSource.getRepository(Shift);
    const s = id ? await repo.findOneBy({ id }) : repo.create();
    if (!s) throw notFound('Shift');
    if (id && version !== undefined) assertVersion(s.version, version);
    if (dto.start_time === dto.end_time) throw unprocessable('zero_length', 'A shift needs a different start and end', [{ path: 'end_time', message: 'Same as start' }]);
    Object.assign(s, { code: dto.code, name: dto.name, startTime: dto.start_time, endTime: dto.end_time, breakMinutes: dto.break_minutes, lateGraceMinutes: dto.late_grace_minutes ?? null, earlyLeaveGraceMinutes: dto.early_leave_grace_minutes ?? null, colour: dto.colour ?? null, ...(dto.status ? { status: dto.status } : {}) });
    return toShiftDto(await repo.save(s));
  }

  /** The department's own setting, or the nearest ancestor's. */
  private async settingFor(m: EntityManager, departmentId: string): Promise<{ setting: DepartmentShiftSetting; inheritedFrom: string | null } | null> {
    const [d] = await m.query(`SELECT path FROM department WHERE id = $1`, [departmentId]);
    if (!d) return null;
    const chain: string[] = [departmentId, ...[...(d.path as string[])].reverse()];
    const rows = await m.getRepository(DepartmentShiftSetting).findBy({ departmentId: In(chain) });
    for (const id of chain) {
      const s = rows.find((r) => r.departmentId === id);
      if (s) return { setting: s, inheritedFrom: id === departmentId ? null : id };
    }
    return null;
  }

  private async modeFor(m: EntityManager, employeeId: string) {
    const [e] = await m.query(`SELECT department_id FROM employee WHERE id = $1`, [employeeId]);
    if (!e?.department_id) return null;
    return (await this.settingFor(m, e.department_id))?.setting ?? null;
  }

  async departmentShifts(departmentId: string) {
    const r = await this.settingFor(this.dataSource.manager, departmentId);
    if (!r) return { department_id: departmentId, mode: 'standing' as const, standing_shift_id: null, shift_ids: [], inherited_from: null };
    return { department_id: departmentId, mode: r.setting.mode, standing_shift_id: r.setting.standingShiftId, shift_ids: r.setting.shiftIds, inherited_from: r.inheritedFrom };
  }

  async setDepartmentShifts(departmentId: string, dto: z.infer<typeof setDepartmentShifts>) {
    const ids = [...new Set([...dto.shift_ids, ...(dto.standing_shift_id ? [dto.standing_shift_id] : [])])];
    if ((await this.dataSource.getRepository(Shift).countBy({ id: In(ids) })) !== ids.length) throw unprocessable('shift_not_found', 'Unknown shift');
    const repo = this.dataSource.getRepository(DepartmentShiftSetting);
    const row = (await repo.findOneBy({ departmentId })) ?? repo.create({ departmentId });
    Object.assign(row, { mode: dto.mode, standingShiftId: dto.mode === 'standing' ? dto.standing_shift_id : null, shiftIds: ids });
    await repo.save(row);
    return this.departmentShifts(departmentId);
  }

  // ------------------------------------------------------------------ rosters
  private async employeesInScope(access: AccessProfile, permission: string, ids: string[], m: EntityManager = this.dataSource.manager): Promise<Employee[]> {
    const rows = await m.getRepository(Employee).findBy({ id: In(ids) });
    const filter = await this.scope.filterFor(access, permission);
    const out = rows.filter((e) => scopeAllows(filter, { branchId: e.branchId, departmentId: e.departmentId, employeeId: e.id }));
    if (out.length !== new Set(ids).size) throw new ProblemException(403, 'out_of_scope', 'Some of these people are outside your scope');
    return out;
  }

  async roster(access: AccessProfile, q: { from: string; to: string; department_id?: string; employee_id?: string }) {
    if (Date.parse(q.to) - Date.parse(q.from) > 62 * 86_400_000 || q.to < q.from) throw unprocessable('bad_window', 'Choose up to 62 days');
    const qb = this.dataSource.getRepository(RosterEntry).createQueryBuilder('r').innerJoin(Employee, 'e', 'e.id = r.employee_id').where('r.work_date BETWEEN :from AND :to', q);
    const filter = await this.scope.filterFor(access, 'roster:read');
    if (access.employeeId && !filter.all) filter.employeeIds.push(access.employeeId);
    applyScope(qb, filter, { branch: 'e.branch_id', department: 'e.department_id', employee: 'e.id' });
    if (q.department_id) qb.andWhere('e.department_id IN (SELECT id FROM department WHERE id = :dep OR :dep = ANY(path))', { dep: q.department_id });
    if (q.employee_id) qb.andWhere('r.employee_id = :emp', { emp: q.employee_id });
    return (await qb.orderBy('r.work_date').getMany()).map((r) => ({ id: r.id, employee_id: r.employeeId, work_date: r.workDate, shift_id: r.shiftId, kind: r.kind, note: r.note }));
  }

  /** Replaces each listed person-day with the given shifts (or a rest day). */
  async changeRoster(access: AccessProfile, dto: z.infer<typeof rosterChange>) {
    return this.dataSource.transaction(async (m) => {
      const people = await this.employeesInScope(access, 'roster:manage', [...new Set(dto.entries.map((e) => e.employee_id))], m);
      const shifts = new Set((await m.getRepository(Shift).findBy({ status: 'active' })).map((s) => s.id));
      for (const [i, e] of dto.entries.entries()) {
        for (const sid of e.shift_ids) if (!shifts.has(sid)) throw unprocessable('shift_not_found', `Entry ${i}: unknown or inactive shift`);
        await m.getRepository(RosterEntry).delete({ employeeId: e.employee_id, workDate: e.work_date });
        if (e.kind === 'off') await m.getRepository(RosterEntry).insert({ employeeId: e.employee_id, workDate: e.work_date, shiftId: null, kind: 'off', note: e.note ?? null, createdBy: access.actorId });
        else for (const sid of e.shift_ids) await m.getRepository(RosterEntry).insert({ employeeId: e.employee_id, workDate: e.work_date, shiftId: sid, kind: 'shift', note: e.note ?? null, createdBy: access.actorId });
      }
      await this.announceRoster(m, people, dto.entries.map((e) => e.work_date));
      return { changed: dto.entries.length };
    });
  }

  /** Cycles a pattern of shift codes (and OFF) over a range; with stagger each person starts one day later. */
  async applyPattern(access: AccessProfile, dto: z.infer<typeof rosterPattern>) {
    const shifts = await this.dataSource.getRepository(Shift).findBy({ status: 'active' });
    const byCode = new Map(shifts.map((s) => [s.code.toUpperCase(), s.id]));
    for (const code of dto.pattern) if (code.toUpperCase() !== 'OFF' && !byCode.has(code.toUpperCase())) throw unprocessable('unknown_shift_code', `Unknown shift code ${code}`, [{ path: 'pattern', message: code }]);
    if (Date.parse(dto.to) - Date.parse(dto.from) > 92 * 86_400_000 || dto.to < dto.from) throw unprocessable('bad_window', 'Choose up to 92 days');
    const entries: z.infer<typeof rosterChange>['entries'] = [];
    dto.employee_ids.forEach((id, k) => {
      let i = dto.stagger ? k : 0;
      for (let d = dto.from; d <= dto.to; d = addDays(d, 1), i++) {
        const code = dto.pattern[i % dto.pattern.length].toUpperCase();
        entries.push(code === 'OFF' ? { employee_id: id, work_date: d, shift_ids: [], kind: 'off' } : { employee_id: id, work_date: d, shift_ids: [byCode.get(code)!], kind: 'shift' });
      }
    });
    return this.changeRoster(access, { entries });
  }

  private async announceRoster(m: EntityManager, people: Employee[], dates: string[]) {
    const sorted = [...dates].sort();
    const byDept = new Map<string | null, string[]>();
    for (const p of people) byDept.set(p.departmentId, [...(byDept.get(p.departmentId) ?? []), p.id]);
    for (const [dept, ids] of byDept) {
      await this.outbox.record(m, 'hr.roster.changed.v1', dept ?? ids[0], { department_id: dept, employee_ids: ids, from: sorted[0], to: sorted[sorted.length - 1] });
    }
  }

  /** What a person is scheduled to work on a date: rostered shifts, or the standing shift on a working day. */
  async scheduleOf(m: EntityManager, employee: Employee, date: string): Promise<{ shifts: Shift[]; dayType: 'normal' | 'rest_day' | 'public_holiday' }> {
    const [holiday] = await m.query(`SELECT 1 FROM public_holiday WHERE date = $1 AND (branch_id IS NULL OR branch_id = $2) LIMIT 1`, [date, employee.branchId]);
    const setting = employee.departmentId ? (await this.settingFor(m, employee.departmentId))?.setting : null;
    const roster = await m.getRepository(RosterEntry).findBy({ employeeId: employee.id, workDate: date });
    let shifts: Shift[] = [];
    let rest = false;
    if (roster.length) {
      const ids = roster.filter((r) => r.kind === 'shift').map((r) => r.shiftId!);
      shifts = ids.length ? await m.getRepository(Shift).findBy({ id: In(ids) }) : [];
      rest = !ids.length;
    } else if (setting?.mode === 'standing' && setting.standingShiftId) {
      const working = await this.settings.get('calendar.working_days', m);
      const wd = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
      if (working.includes(wd)) shifts = await m.getRepository(Shift).findBy({ id: setting.standingShiftId });
      else rest = true;
    }
    // Rostered staff work public holidays when rostered; standing staff do not.
    const dayType = holiday && (setting?.mode !== 'rostered' || !roster.length) ? 'public_holiday' : rest ? 'rest_day' : holiday ? 'public_holiday' : 'normal';
    return { shifts: dayType === 'public_holiday' && setting?.mode !== 'rostered' ? [] : shifts, dayType };
  }

  // ------------------------------------------------------------------ clock events
  private async resolveEmployees(m: EntityManager, punches: IncomingPunch[]): Promise<(string | null)[]> {
    const staffNos = [...new Set(punches.map((p) => p.staffNumber ?? (p.connectorId ? undefined : p.deviceUserId)).filter((x): x is string => !!x))];
    const byStaff = new Map<string, string>();
    if (staffNos.length) {
      const rows: { id: string; sn: string }[] = await m.query(`SELECT id, lower(staff_number) AS sn FROM employee WHERE lower(staff_number) = ANY($1::text[]) AND deleted_at IS NULL`, [staffNos.map((s) => s.toLowerCase())]);
      for (const r of rows) byStaff.set(r.sn, r.id);
    }
    const out: (string | null)[] = [];
    for (const p of punches) {
      if (p.employeeId) out.push(p.employeeId);
      else if (p.staffNumber) out.push(byStaff.get(p.staffNumber.toLowerCase()) ?? null);
      else if (p.deviceUserId && p.connectorId) {
        const [c] = await m.query(`SELECT match_by FROM connector WHERE id = $1`, [p.connectorId]);
        const [mapped] = await m.query(`SELECT employee_id FROM device_user_mapping WHERE connector_id = $1 AND device_user_id = $2`, [p.connectorId, p.deviceUserId]);
        if (mapped) out.push(mapped.employee_id);
        else if (c?.match_by === 'staff_number') {
          const [e] = await m.query(`SELECT id FROM employee WHERE lower(staff_number) = lower($1) AND deleted_at IS NULL`, [p.deviceUserId]);
          out.push(e?.id ?? null);
        } else out.push(null);
      } else if (p.deviceUserId) out.push(byStaff.get(p.deviceUserId.toLowerCase()) ?? null);
      else out.push(null);
    }
    return out;
  }

  /**
   * Stores punches exactly once (by source + device + external id, or by person + minute)
   * and recomputes the affected days. Unknown people are kept unmatched so they can be
   * mapped later without losing the punch.
   */
  async ingest(punches: IncomingPunch[]): Promise<IngestResult & { affected: { employeeId: string; date: string }[] }> {
    const result: IngestResult = { accepted: 0, duplicates: 0, unmatched: 0, errors: [] };
    const affected = new Map<string, { employeeId: string; date: string }>();
    const tz = await this.settings.get('locale.timezone');
    await this.dataSource.transaction(async (m) => {
      const employees = await this.resolveEmployees(m, punches);
      for (const [i, p] of punches.entries()) {
        const employeeId = employees[i];
        if (Number.isNaN(p.occurredAt.getTime())) {
          result.errors.push({ index: i, message: 'Invalid time' });
          continue;
        }
        if (p.occurredAt.getTime() > Date.now() + 5 * 60_000) {
          result.errors.push({ index: i, message: 'In the future' });
          continue;
        }
        const who = employeeId ?? `${p.connectorId ?? 'none'}:${p.deviceUserId ?? p.staffNumber ?? '?'}`;
        const key = p.externalId ? `${p.source}:${p.connectorId ?? p.deviceId ?? '-'}:${p.externalId}` : `${who}:${Math.floor(p.occurredAt.getTime() / 60_000)}:${p.direction}`;
        const res = await m.query(
          `INSERT INTO clock_event (employee_id, occurred_at, direction, source, connector_id, device_id, device_user_id, dedup_key, raw, recorded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (dedup_key) DO NOTHING RETURNING id`,
          [employeeId, p.occurredAt, p.direction, p.source, p.connectorId ?? null, p.deviceId ?? null, p.deviceUserId ?? p.staffNumber ?? null, key.slice(0, 200), p.raw === undefined ? null : JSON.stringify(p.raw), p.recordedBy ?? null],
        );
        if (!res.length) {
          result.duplicates++;
          continue;
        }
        result.accepted++;
        if (!employeeId) {
          result.unmatched++;
          continue;
        }
        // A punch can belong to the shift that started the previous day (night shifts).
        const d = localDate(p.occurredAt, tz);
        for (const date of [d, addDays(d, -1)]) affected.set(`${employeeId}:${date}`, { employeeId, date });
      }
    });
    for (const a of affected.values()) await this.computeDay(a.employeeId, a.date);
    return { ...result, affected: [...affected.values()] };
  }

  async postBatch(access: AccessProfile, dto: z.infer<typeof clockEventBatch>) {
    const r = await this.ingest(dto.events.map((e) => ({
      employeeId: e.employee_id, staffNumber: e.staff_number, deviceUserId: e.device_user_id, occurredAt: new Date(e.occurred_at), direction: e.direction,
      source: access.actorType === 'client' ? 'api' : 'import', deviceId: e.device_id ?? null, externalId: e.external_id ?? null, raw: e, recordedBy: access.actorId,
    })));
    return { accepted: r.accepted, duplicates: r.duplicates, unmatched: r.unmatched, errors: r.errors };
  }

  async selfClock(access: AccessProfile, direction: 'in' | 'out', source: 'web' | 'mobile', geo?: { latitude?: number; longitude?: number }) {
    if (!access.employeeId) throw new ProblemException(404, 'no_employee_record', 'Your account is not linked to an employee record');
    const now = new Date();
    await this.ingest([{ employeeId: access.employeeId, occurredAt: now, direction, source, recordedBy: access.actorId, raw: geo && (geo.latitude !== undefined ? geo : undefined) }]);
    const tz = await this.settings.get('locale.timezone');
    return this.myDay(access, localDate(now, tz));
  }

  async rematch(connectorId: string): Promise<number> {
    const rows: { id: string; device_user_id: string }[] = await this.dataSource.query(`SELECT id, device_user_id FROM clock_event WHERE connector_id = $1 AND employee_id IS NULL`, [connectorId]);
    let n = 0;
    for (const r of rows) {
      const [emp] = await this.resolveEmployees(this.dataSource.manager, [{ deviceUserId: r.device_user_id, connectorId, occurredAt: new Date(), direction: 'unknown', source: 'device' }]);
      if (!emp) continue;
      await this.dataSource.query(`UPDATE clock_event SET employee_id = $2 WHERE id = $1`, [r.id, emp]);
      const [ev] = await this.dataSource.query(`SELECT occurred_at FROM clock_event WHERE id = $1`, [r.id]);
      const d = localDate(new Date(ev.occurred_at), await this.settings.get('locale.timezone'));
      await this.computeDay(emp, d);
      await this.computeDay(emp, addDays(d, -1));
      n++;
    }
    return n;
  }

  // ------------------------------------------------------------------ deriving a day
  private async overtimeRule(m: EntityManager, dayType: string, date: string): Promise<OvertimeRule | null> {
    return m.getRepository(OvertimeRule).createQueryBuilder('o').where('o.day_type = :t AND o.effective_from <= :d AND (o.effective_to IS NULL OR o.effective_to >= :d)', { t: dayType, d: date }).getOne();
  }

  /** Recomputes one person's day from scratch (idempotent): schedule + punches + leave + policy. */
  async computeDay(employeeId: string, date: string, outer?: EntityManager): Promise<AttendanceDay[]> {
    const run = (fn: (m: EntityManager) => Promise<AttendanceDay[]>) => (outer ? fn(outer) : this.dataSource.transaction(fn));
    return run(async (m) => {
      const e = await m.getRepository(Employee).findOneBy({ id: employeeId });
      if (!e || e.hireDate > date || (e.exitDate && e.exitDate < date)) return [];
      const tz = await this.settings.get('locale.timezone', m);
      const grace = await this.settings.get('attendance.late_grace_minutes', m);
      const earlyGrace = await this.settings.get('attendance.early_leave_grace_minutes', m);
      const halfDay = (await this.settings.get('attendance.half_day_min_hours', m)) * 60;
      const { shifts, dayType } = await this.scheduleOf(m, e, date);
      const [leave] = await m.query(
        `SELECT r.id, r.start_date, r.end_date, r.start_half_day, r.end_half_day FROM leave_request r WHERE r.employee_id = $1 AND r.status = 'approved' AND r.start_date <= $2 AND r.end_date >= $2 LIMIT 1`,
        [employeeId, date],
      );
      const leaveFraction: 0 | 0.5 | 1 = !leave ? 0 : (leave.start_half_day && leave.start_date === date) || (leave.end_half_day && leave.end_date === date) ? 0.5 : 1;
      const regularised = (await m.getRepository(Regularisation).countBy({ employeeId, workDate: date, status: 'approved' })) > 0;

      const schedules = shifts.map((s) => ({ shift: s, window: scheduleFor(date, s, tz) })).sort((a, b) => a.window.start.getTime() - b.window.start.getTime());
      // Punch window: the scheduled shifts widened, or the local day for unscheduled days.
      const from = schedules.length ? new Date(schedules[0].window.start.getTime() - WINDOW_BEFORE_MIN * 60_000) : new Date(`${date}T00:00:00Z`);
      const to = schedules.length ? new Date(schedules[schedules.length - 1].window.end.getTime() + WINDOW_AFTER_MIN * 60_000) : new Date(Date.parse(`${addDays(date, 1)}T00:00:00Z`));
      let punches = await m.getRepository(ClockEvent).createQueryBuilder('c').where('c.employee_id = :e AND c.occurred_at >= :from AND c.occurred_at < :to', { e: employeeId, from, to }).orderBy('c.occurred_at').getMany();
      // Punches that belong to the previous day's shift (a night shift ending this morning) are not this day's.
      const prev = await this.scheduleOf(m, e, addDays(date, -1));
      const prevWindows = prev.shifts.map((s) => scheduleFor(addDays(date, -1), s, tz)).map((w) => ({ from: w.start.getTime() - WINDOW_BEFORE_MIN * 60_000, to: w.end.getTime() + 2 * 3_600_000 }));
      const firstShiftStart = schedules[0]?.window.start.getTime();
      punches = punches.filter((p) => {
        const t = p.occurredAt.getTime();
        const inPrev = prevWindows.some((w) => t >= w.from && t <= w.to);
        return !inPrev || (firstShiftStart !== undefined && t >= firstShiftStart - 60 * 60_000);
      });

      await m.getRepository(AttendanceDay).delete({ employeeId, workDate: date });
      const out: AttendanceDay[] = [];
      const units = schedules.length ? schedules : [{ shift: null as Shift | null, window: null as { start: Date; end: Date } | null }];
      const claimed = new Set<string>();
      for (const [idx, u] of units.entries()) {
        // With split shifts each punch goes to the shift whose window it falls in, earliest first.
        const nextStart = units[idx + 1]?.window?.start;
        const mine = punches.filter((p) => !claimed.has(p.id) && (!nextStart || p.occurredAt.getTime() < nextStart.getTime() - 30 * 60_000 || idx === units.length - 1));
        mine.forEach((p) => claimed.add(p.id));
        const rule = await this.overtimeRule(m, dayType, date);
        const def: ShiftDef | null = u.shift ? { startTime: u.shift.startTime, endTime: u.shift.endTime, breakMinutes: u.shift.breakMinutes, lateGraceMinutes: u.shift.lateGraceMinutes ?? grace, earlyLeaveGraceMinutes: u.shift.earlyLeaveGraceMinutes ?? earlyGrace } : null;
        const r = computeDay({ schedule: u.window, shift: def, punches: mine.map((p) => ({ at: p.occurredAt, direction: p.direction })), dayType, leave: leaveFraction, halfDayMinMinutes: halfDay, overtimeMinMinutes: rule?.minMinutes ?? 30 });
        // Unscheduled days with no punches are not stored: nothing to report.
        if (r.status === 'not_scheduled' && !mine.length) continue;
        const row = m.getRepository(AttendanceDay).create({
          employeeId, workDate: date, shiftId: u.shift?.id ?? null, scheduledStart: u.window?.start ?? null, scheduledEnd: u.window?.end ?? null, firstIn: r.firstIn, lastOut: r.lastOut,
          workedMinutes: r.workedMinutes, lateMinutes: r.lateMinutes, earlyLeaveMinutes: r.earlyLeaveMinutes, overtimeMinutes: rule?.requiresApproval && !regularised ? 0 : r.overtimeMinutes,
          dayType, status: r.status, leaveRequestId: leave?.id ?? null, regularised, computedAt: new Date(),
        });
        out.push(await m.getRepository(AttendanceDay).save(row));
      }
      return out;
    });
  }

  /** Recomputes everyone (or one department) over a date range. Used by the nightly job and on demand. */
  async recompute(access: AccessProfile | null, from: string, to: string, departmentId?: string): Promise<number> {
    if (Date.parse(to) - Date.parse(from) > 62 * 86_400_000 || to < from) throw unprocessable('bad_window', 'Choose up to 62 days');
    const qb = this.dataSource.getRepository(Employee).createQueryBuilder('e').where(`e.status <> 'exited' OR e.exit_date >= :from`, { from });
    if (access) applyScope(qb, await this.scope.filterFor(access, 'attendance:manage'), { branch: 'e.branch_id', department: 'e.department_id', employee: 'e.id' });
    if (departmentId) qb.andWhere('e.department_id IN (SELECT id FROM department WHERE id = :dep OR :dep = ANY(path))', { dep: departmentId });
    const people = await qb.getMany();
    let n = 0;
    for (const p of people) for (let d = from; d <= to; d = addDays(d, 1)) n += (await this.computeDay(p.id, d)).length;
    return n;
  }

  /** Nightly: yesterday and the day before for everyone (late punches and night shifts settle). */
  async recomputeRecent(): Promise<number> {
    const today = await this.settings.today();
    return this.recompute(null, addDays(today, -2), addDays(today, -1));
  }

  private dayDto(d: AttendanceDay, names?: Map<string, string>, codes?: Map<string, string>): DayDto {
    const iso = (x: Date | null) => (x ? x.toISOString() : null);
    return {
      id: d.id, employee_id: d.employeeId, employee_name: names?.get(d.employeeId), work_date: d.workDate, shift_id: d.shiftId, shift_code: d.shiftId ? (codes?.get(d.shiftId) ?? null) : null,
      scheduled_start: iso(d.scheduledStart), scheduled_end: iso(d.scheduledEnd), first_in: iso(d.firstIn), last_out: iso(d.lastOut), worked_minutes: d.workedMinutes, late_minutes: d.lateMinutes,
      early_leave_minutes: d.earlyLeaveMinutes, overtime_minutes: d.overtimeMinutes, day_type: d.dayType, status: d.status as DayDto['status'], leave_request_id: d.leaveRequestId, regularised: d.regularised, computed_at: d.computedAt.toISOString(),
    };
  }

  async days(access: AccessProfile, q: z.infer<typeof attendanceQuery>): Promise<Page<DayDto>> {
    if (Date.parse(q.to) - Date.parse(q.from) > 92 * 86_400_000 || q.to < q.from) throw unprocessable('bad_window', 'Choose up to 92 days');
    const qb = this.dataSource.getRepository(AttendanceDay).createQueryBuilder('a').innerJoin(Employee, 'e', 'e.id = a.employee_id').where('a.work_date BETWEEN :from AND :to', { from: q.from, to: q.to });
    applyScope(qb, await this.scope.filterFor(access, 'attendance:read'), { branch: 'e.branch_id', department: 'e.department_id', employee: 'e.id' });
    if (q.department_id) qb.andWhere('e.department_id IN (SELECT id FROM department WHERE id = :dep OR :dep = ANY(path))', { dep: q.department_id });
    if (q.employee_id) qb.andWhere('a.employee_id = :emp', { emp: q.employee_id });
    if (q.status) qb.andWhere('a.status = :st', { st: q.status });
    // Offset cursor: attendance pages are short date windows, not an incremental-sync feed.
    const offset = q.cursor ? Number(Buffer.from(q.cursor, 'base64url').toString()) || 0 : 0;
    const rows = await qb.orderBy('a.work_date', 'DESC').addOrderBy('a.id').limit(q.limit + 1).offset(offset).getMany();
    const more = rows.length > q.limit;
    const data = more ? rows.slice(0, q.limit) : rows;
    const names = new Map<string, string>((await this.dataSource.query(`SELECT id, first_name || ' ' || last_name AS n FROM employee WHERE id = ANY($1::uuid[])`, [[...new Set(data.map((d) => d.employeeId))]])).map((r: { id: string; n: string }) => [r.id, r.n]));
    const codes = new Map((await this.dataSource.getRepository(Shift).find()).map((s) => [s.id, s.code]));
    return { data: data.map((d) => this.dayDto(d, names, codes)), next_cursor: more ? Buffer.from(String(offset + q.limit)).toString('base64url') : null };
  }

  async myDay(access: AccessProfile, date: string) {
    if (!access.employeeId) throw new ProblemException(404, 'no_employee_record', 'Your account is not linked to an employee record');
    const rows = await this.dataSource.getRepository(AttendanceDay).find({ where: { employeeId: access.employeeId, workDate: date } });
    const punches = await this.dataSource.getRepository(ClockEvent).createQueryBuilder('c').where('c.employee_id = :e AND c.occurred_at >= :from', { e: access.employeeId, from: new Date(Date.now() - 36 * 3_600_000) }).orderBy('c.occurred_at').getMany();
    const codes = new Map((await this.dataSource.getRepository(Shift).find()).map((s) => [s.id, s.code]));
    return { date, days: rows.map((d) => this.dayDto(d, undefined, codes)), punches: punches.map((p) => ({ at: p.occurredAt.toISOString(), direction: p.direction, source: p.source })) };
  }

  async timesheet(access: AccessProfile, employeeId: string, from: string, to: string) {
    const e = await this.dataSource.getRepository(Employee).findOneBy({ id: employeeId });
    if (!e) throw notFound('Employee');
    if (employeeId !== access.employeeId && !scopeAllows(await this.scope.filterFor(access, 'attendance:read'), { branchId: e.branchId, departmentId: e.departmentId, employeeId: e.id })) throw notFound('Employee');
    const days = await this.dataSource.getRepository(AttendanceDay).createQueryBuilder('a').where('a.employee_id = :e AND a.work_date BETWEEN :from AND :to', { e: employeeId, from, to }).getMany();
    const sum = (f: (d: AttendanceDay) => number) => days.reduce((s, d) => s + f(d), 0);
    const ot = new Map<string, number>();
    for (const d of days) if (d.overtimeMinutes) ot.set(d.dayType, (ot.get(d.dayType) ?? 0) + d.overtimeMinutes);
    const overtime = [];
    for (const [dayType, minutes] of ot) overtime.push({ day_type: dayType as 'normal' | 'rest_day' | 'public_holiday', minutes, multiplier: (await this.overtimeRule(this.dataSource.manager, dayType, to))?.multiplier ?? null });
    return {
      employee_id: e.id, employee_name: `${e.firstName} ${e.lastName}`, from, to,
      scheduled_days: days.filter((d) => d.scheduledStart).length,
      present_days: sum((d) => (['present', 'late'].includes(d.status) ? 1 : d.status === 'half_day' ? 0.5 : 0)),
      absent_days: days.filter((d) => d.status === 'absent').length,
      late_days: days.filter((d) => d.status === 'late').length,
      leave_days: sum((d) => (d.status === 'on_leave' ? 1 : 0)),
      worked_minutes: sum((d) => d.workedMinutes), late_minutes: sum((d) => d.lateMinutes), overtime,
    };
  }

  // ------------------------------------------------------------------ overtime rules
  async overtimeRules() {
    return (await this.dataSource.getRepository(OvertimeRule).find({ order: { dayType: 'ASC', effectiveFrom: 'DESC' } })).map((r) => ({ id: r.id, day_type: r.dayType, multiplier: r.multiplier, min_minutes: r.minMinutes, requires_approval: r.requiresApproval, effective_from: r.effectiveFrom, effective_to: r.effectiveTo }));
  }

  async saveOvertimeRule(dto: z.infer<typeof upsertOvertimeRule>, id?: string) {
    const repo = this.dataSource.getRepository(OvertimeRule);
    const r = id ? await repo.findOneBy({ id }) : repo.create();
    if (!r) throw notFound('Overtime rule');
    Object.assign(r, { dayType: dto.day_type, multiplier: dto.multiplier ?? null, minMinutes: dto.min_minutes, requiresApproval: dto.requires_approval, effectiveFrom: dto.effective_from, effectiveTo: dto.effective_to ?? null });
    const s = await repo.save(r);
    return { id: s.id, day_type: s.dayType, multiplier: s.multiplier, min_minutes: s.minMinutes, requires_approval: s.requiresApproval, effective_from: s.effectiveFrom, effective_to: s.effectiveTo };
  }

  // ------------------------------------------------------------------ regularisation
  private regDto(r: Regularisation) {
    return { id: r.id, employee_id: r.employeeId, work_date: r.workDate, clock_in: r.clockIn?.toISOString() ?? null, clock_out: r.clockOut?.toISOString() ?? null, reason: r.reason, status: r.status, decision_comment: r.decisionComment, created_at: r.createdAt.toISOString() };
  }

  async requestRegularisation(access: AccessProfile, dto: z.infer<typeof requestRegularisation>) {
    const employeeId = dto.employee_id ?? access.employeeId;
    if (!employeeId) throw new ProblemException(404, 'no_employee_record', 'Your account is not linked to an employee record');
    if (employeeId !== access.employeeId) await this.employeesInScope(access, 'attendance:manage', [employeeId]);
    const today = await this.settings.today();
    if (dto.work_date > today) throw unprocessable('future', 'You can only correct days that have happened');
    return this.dataSource.transaction(async (m) => {
      const repo = m.getRepository(Regularisation);
      const r = await repo.save(repo.create({ employeeId, workDate: dto.work_date, clockIn: dto.clock_in ? new Date(dto.clock_in) : null, clockOut: dto.clock_out ? new Date(dto.clock_out) : null, reason: dto.reason }));
      const e = await m.getRepository(Employee).findOneByOrFail({ id: employeeId });
      const [u] = await m.query(`SELECT id FROM user_account WHERE employee_id = $1`, [employeeId]);
      await this.workflow.submit(m, { requestType: 'attendance_regularisation', subjectId: r.id, subjectEmployeeId: employeeId, requesterUserId: u?.id ?? access.actorId, summary: `Attendance correction: ${e.firstName} ${e.lastName}, ${dto.work_date}` });
      return this.regDto(r);
    });
  }

  async regularisations(access: AccessProfile, employeeId?: string) {
    const id = employeeId ?? access.employeeId;
    if (!id) return [];
    if (id !== access.employeeId) await this.employeesInScope(access, 'attendance:read', [id]);
    return (await this.dataSource.getRepository(Regularisation).find({ where: { employeeId: id }, order: { createdAt: 'DESC' }, take: 50 })).map((r) => this.regDto(r));
  }

  private async applyRegularisation(m: EntityManager, i: WorkflowInstance) {
    const r = await m.getRepository(Regularisation).findOneByOrFail({ id: i.subjectId });
    r.status = 'approved';
    await m.getRepository(Regularisation).save(r);
    for (const [at, direction] of [[r.clockIn, 'in'], [r.clockOut, 'out']] as const) {
      if (!at) continue;
      await m.query(
        `INSERT INTO clock_event (employee_id, occurred_at, direction, source, dedup_key, raw) VALUES ($1, $2, $3, 'regularisation', $4, $5) ON CONFLICT (dedup_key) DO NOTHING`,
        [r.employeeId, at, direction, `regularisation:${r.id}:${direction}`, JSON.stringify({ regularisation_id: r.id, reason: r.reason })],
      );
    }
    // Recompute in the same transaction, so the approval and the corrected day commit together.
    await this.computeDay(r.employeeId, r.workDate, m);
  }

  private async closeRegularisation(m: EntityManager, i: WorkflowInstance, status: 'rejected' | 'returned', comment: string | null) {
    await m.getRepository(Regularisation).update({ id: i.subjectId }, { status: status === 'returned' ? 'returned' : 'rejected', decisionComment: comment });
  }
}
