import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import Decimal from 'decimal.js';
import { DataSource, EntityManager, In } from 'typeorm';
import { z } from 'zod';
import { cpdClaimFields, cpdDecision, recordAttendance, setCpdRequirements, trainingFeedback, upsertProgramme, upsertSession } from '@sil/hr-shared';
import { AccessProfile, applyScope, scopeAllows } from '../../common/access';
import { assertVersion } from '../../common/etag';
import { conflict, forbidden, notFound, unprocessable } from '../../common/problem';
import { writeAudit } from '../audit/audit.subscriber';
import { DocumentsService } from '../documents/documents.module';
import { OutboxService } from '../events/events.module';
import { NotificationsService } from '../notifications/notifications.module';
import { NumberingService } from '../numbering/numbering.module';
import { ScopeService } from '../organisation/scope.service';
import { SettingsService } from '../settings/settings.module';
import { WorkflowInstance } from '../workflow/workflow.entities';
import { WorkflowService } from '../workflow/workflow.service';
import { CpdEntry, CpdRequirement, TrainingEnrolment, TrainingProgramme, TrainingSession } from './training.entities';

type Dto<T extends z.ZodType> = z.infer<T>;
const p1 = (x: Decimal.Value | null) => (x === null ? null : new Decimal(x).toFixed(1));
const m2 = (x: Decimal.Value | null) => (x === null ? null : new Decimal(x).toFixed(2));
const addMonths = (date: string, months: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
};
const LIVE: string[] = ['requested', 'enrolled', 'attended', 'absent'];
/** CPD reminders start this many days before a licence expires. */
const CPD_REMINDER_DAYS = 60;

@Injectable()
export class TrainingService implements OnModuleInit {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly settings: SettingsService,
    private readonly workflow: WorkflowService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
    private readonly numbering: NumberingService,
    private readonly scope: ScopeService,
    private readonly docs: DocumentsService,
  ) {}

  onModuleInit(): void {
    this.workflow.registerHandler('training_request', {
      onApproved: (m, i) => this.requestDecided(m, i, true, null),
      onRejected: (m, i, c) => this.requestDecided(m, i, false, c),
      onReturned: (m, i, c) => this.requestDecided(m, i, false, c),
    });
  }

  private async localDate(d: Date, m?: EntityManager) {
    const timeZone = await this.settings.get('locale.timezone', m);
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  }

  private async employeeRow(m: EntityManager, id: string) {
    const [e] = await m.query(
      `SELECT e.id, e.first_name || ' ' || e.last_name AS name, e.staff_number, e.branch_id, e.department_id, e.status, p.is_clinical,
              (SELECT licensing_body FROM professional_licence l WHERE l.employee_id = e.id AND l.deleted_at IS NULL ORDER BY l.expiry_date DESC LIMIT 1) AS licensing_body,
              (SELECT id FROM user_account u WHERE u.employee_id = e.id AND u.status = 'active' AND u.deleted_at IS NULL LIMIT 1) AS user_id
         FROM employee e LEFT JOIN position p ON p.id = e.position_id WHERE e.id = $1 AND e.deleted_at IS NULL`,
      [id],
    );
    return e as { id: string; name: string; staff_number: string; branch_id: string | null; department_id: string | null; status: string; is_clinical: boolean | null; licensing_body: string | null; user_id: string | null } | undefined;
  }

  private async assertEmployeeInScope(access: AccessProfile, permission: string, e: { id: string; branch_id: string | null; department_id: string | null }) {
    if (!scopeAllows(await this.scope.filterFor(access, permission), { branchId: e.branch_id, departmentId: e.department_id, employeeId: e.id })) throw forbidden('That person is outside your area', 'out_of_scope');
  }

  // ================================================================== programmes
  private programmeDto(p: TrainingProgramme) {
    return {
      id: p.id, code: p.code, title: p.title, description: p.description, category: p.category as 'clinical', delivery: p.delivery as 'classroom', provider: p.provider, duration_hours: m2(p.durationHours)!, cpd_points: p1(p.cpdPoints)!,
      cpd_bodies: p.cpdBodies, mandatory_for: p.mandatoryFor, refresh_months: p.refreshMonths, pass_mark: p.passMark, status: p.status, created_at: p.createdAt.toISOString(), updated_at: p.updatedAt.toISOString(), version: p.version,
    };
  }

  async programmes(q: { status?: string }) {
    const rows = await this.dataSource.getRepository(TrainingProgramme).find({ where: q.status ? { status: q.status as 'active' } : {}, order: { title: 'ASC' } });
    return rows.map((p) => this.programmeDto(p));
  }

  async saveProgramme(dto: Dto<typeof upsertProgramme>, id?: string, version?: number) {
    const repo = this.dataSource.getRepository(TrainingProgramme);
    const p = id ? await repo.findOneBy({ id }) : repo.create();
    if (!p) throw notFound('Programme');
    if (id && version !== undefined) assertVersion(p.version, version);
    const clash = await repo.findOneBy({ code: dto.code });
    if (clash && clash.id !== p.id) throw conflict('duplicate_code', `Programme ${dto.code} already exists`);
    if (dto.refresh_months && dto.mandatory_for === 'none') throw unprocessable('refresh_needs_mandatory', 'Only mandatory training is repeated on a cycle', [{ path: 'refresh_months', message: 'Make the programme mandatory or clear this' }]);
    Object.assign(p, {
      code: dto.code, title: dto.title, description: dto.description ?? null, category: dto.category, delivery: dto.delivery, provider: dto.provider ?? null, durationHours: dto.duration_hours, cpdPoints: dto.cpd_points,
      cpdBodies: [...new Set(dto.cpd_bodies)], mandatoryFor: dto.mandatory_for, refreshMonths: dto.refresh_months ?? null, passMark: dto.pass_mark ?? null, status: dto.status,
    });
    return this.programmeDto(await repo.save(p));
  }

  // ================================================================== sessions
  private async sessionDto(m: EntityManager, s: TrainingSession, p?: TrainingProgramme) {
    const prog = p ?? (await m.getRepository(TrainingProgramme).findOneByOrFail({ id: s.programmeId }));
    const [c] = await m.query(
      `SELECT count(*) FILTER (WHERE status IN ('enrolled', 'attended', 'absent'))::int AS enrolled, count(*) FILTER (WHERE status = 'attended')::int AS attended, count(*) FILTER (WHERE status = 'requested')::int AS requested
         FROM training_enrolment WHERE session_id = $1`,
      [s.id],
    );
    return {
      id: s.id, number: s.number, programme_id: s.programmeId, programme_code: prog.code, programme_title: prog.title, cpd_points: p1(prog.cpdPoints)!, starts_at: s.startsAt.toISOString(), ends_at: s.endsAt.toISOString(),
      venue: s.venue, trainer: s.trainer, capacity: s.capacity, cost_per_person: m2(s.costPerPerson), open_for_requests: s.openForRequests, status: s.status, enrolled: c.enrolled, attended: c.attended, requested: c.requested,
      created_at: s.createdAt.toISOString(), updated_at: s.updatedAt.toISOString(), version: s.version,
    };
  }

  async sessions(q: { programme_id?: string; status?: string; from?: string }) {
    const m = this.dataSource.manager;
    const qb = m.getRepository(TrainingSession).createQueryBuilder('s').orderBy('s.startsAt', 'DESC').take(500);
    if (q.programme_id) qb.andWhere('s.programme_id = :p', { p: q.programme_id });
    if (q.status) qb.andWhere('s.status = :st', { st: q.status });
    if (q.from) qb.andWhere('s.ends_at >= :f', { f: q.from });
    return Promise.all((await qb.getMany()).map((s) => this.sessionDto(m, s)));
  }

  private async enrolmentDtos(m: EntityManager, rows: TrainingEnrolment[]) {
    if (!rows.length) return [];
    const info: Record<string, string | null>[] = await m.query(
      `SELECT x.id, s.number AS session_number, pr.title AS programme_title, s.starts_at, s.ends_at, s.venue, e.first_name || ' ' || e.last_name AS employee_name, e.staff_number, d.name AS department_name
         FROM training_enrolment x JOIN training_session s ON s.id = x.session_id JOIN training_programme pr ON pr.id = s.programme_id
         JOIN employee e ON e.id = x.employee_id LEFT JOIN department d ON d.id = e.department_id WHERE x.id = ANY($1::uuid[])`,
      [rows.map((r) => r.id)],
    );
    const by = new Map(info.map((i) => [i.id, i]));
    return rows.map((r) => {
      const i = by.get(r.id)!;
      return {
        id: r.id, session_id: r.sessionId, session_number: i.session_number!, programme_title: i.programme_title!, starts_at: new Date(i.starts_at!).toISOString(), ends_at: new Date(i.ends_at!).toISOString(), venue: i.venue,
        employee_id: r.employeeId, employee_name: i.employee_name!, staff_number: i.staff_number!, department_name: i.department_name, status: r.status, score: r.score, passed: r.passed, cpd_points: p1(r.cpdPoints),
        completed_on: r.completedOn, feedback_rating: r.feedbackRating, feedback_comment: r.feedbackComment, decision_comment: r.decisionComment, workflow_instance_id: r.workflowInstanceId,
      };
    });
  }

  async session(access: AccessProfile, id: string) {
    const m = this.dataSource.manager;
    const s = await m.getRepository(TrainingSession).findOneBy({ id });
    if (!s) throw notFound('Session');
    const p = await m.getRepository(TrainingProgramme).findOneByOrFail({ id: s.programmeId });
    const qb = m.getRepository(TrainingEnrolment).createQueryBuilder('x').innerJoin('employee', 'e', 'e.id = x.employee_id').where('x.session_id = :s', { s: id }).orderBy('e.last_name', 'ASC');
    applyScope(qb, await this.scope.filterFor(access, 'training:read'), { branch: 'e.branch_id', department: 'e.department_id', employee: 'e.id' });
    return { ...(await this.sessionDto(m, s, p)), pass_mark: p.passMark, attendees: await this.enrolmentDtos(m, await qb.getMany()) };
  }

  async saveSession(dto: Dto<typeof upsertSession>, id?: string, version?: number) {
    return this.dataSource.transaction(async (m) => {
      const p = await m.getRepository(TrainingProgramme).findOneBy({ id: dto.programme_id });
      if (!p || p.status !== 'active') throw unprocessable('programme_not_found', 'Unknown or inactive programme', [{ path: 'programme_id', message: 'Not found' }]);
      const repo = m.getRepository(TrainingSession);
      const s = id ? await repo.findOneBy({ id }) : repo.create({ number: await this.numbering.next('training_session', { manager: m }), status: 'scheduled' as const });
      if (!s) throw notFound('Session');
      if (id && version !== undefined) assertVersion(s.version, version);
      if (s.status !== 'scheduled') throw conflict('locked', `The session is ${s.status}`);
      if (id && dto.capacity) {
        const [{ n }] = await m.query(`SELECT count(*)::int AS n FROM training_enrolment WHERE session_id = $1 AND status IN ('enrolled', 'attended', 'absent')`, [id]);
        if (n > dto.capacity) throw unprocessable('capacity', `${n} people are already enrolled`, [{ path: 'capacity', message: `At least ${n}` }]);
      }
      Object.assign(s, { programmeId: p.id, startsAt: new Date(dto.starts_at), endsAt: new Date(dto.ends_at), venue: dto.venue ?? null, trainer: dto.trainer ?? null, capacity: dto.capacity ?? null, costPerPerson: dto.cost_per_person ?? null, openForRequests: dto.open_for_requests });
      return this.sessionDto(m, await repo.save(s), p);
    });
  }

  async cancelSession(id: string) {
    return this.dataSource.transaction(async (m) => {
      const s = await m.getRepository(TrainingSession).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!s) throw notFound('Session');
      if (s.status !== 'scheduled') throw conflict('locked', `The session is ${s.status}`);
      const p = await m.getRepository(TrainingProgramme).findOneByOrFail({ id: s.programmeId });
      const live = await m.getRepository(TrainingEnrolment).find({ where: { sessionId: id, status: In(['requested', 'enrolled']) } });
      for (const x of live.filter((x) => x.status === 'requested')) await this.workflow.cancel(m, 'training_request', x.id);
      await m.getRepository(TrainingEnrolment).update({ sessionId: id, status: In(['requested', 'enrolled']) }, { status: 'withdrawn', decisionComment: 'The session was cancelled' });
      s.status = 'cancelled';
      await m.getRepository(TrainingSession).save(s);
      const users: { id: string }[] = await m.query(`SELECT id FROM user_account WHERE employee_id = ANY($1::uuid[]) AND status = 'active'`, [live.map((x) => x.employeeId)]);
      await this.notifications.notifyUsers(users.map((u) => u.id), 'training_cancelled', { programme: p.title, number: s.number, starts: await this.when(s.startsAt, m) }, '/me/training', m);
      return this.sessionDto(m, s, p);
    });
  }

  private async when(d: Date, m?: EntityManager) {
    const timeZone = await this.settings.get('locale.timezone', m);
    return new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);
  }

  private async assertRoom(m: EntityManager, s: TrainingSession, adding: number) {
    if (!s.capacity) return;
    const [{ n }] = await m.query(`SELECT count(*)::int AS n FROM training_enrolment WHERE session_id = $1 AND status IN ('enrolled', 'attended', 'absent')`, [s.id]);
    if (n + adding > s.capacity) throw conflict('session_full', `The session has ${Math.max(0, s.capacity - n)} place(s) left`);
  }

  /** Training managers enrol staff directly (no approval). */
  async enrol(access: AccessProfile, sessionId: string, employeeIds: string[]) {
    await this.dataSource.transaction(async (m) => {
      const s = await m.getRepository(TrainingSession).findOne({ where: { id: sessionId }, lock: { mode: 'pessimistic_write' } });
      if (!s) throw notFound('Session');
      if (s.status !== 'scheduled') throw conflict('locked', `The session is ${s.status}`);
      const p = await m.getRepository(TrainingProgramme).findOneByOrFail({ id: s.programmeId });
      const existing = new Map((await m.getRepository(TrainingEnrolment).find({ where: { sessionId } })).map((x) => [x.employeeId, x]));
      const fresh = [...new Set(employeeIds)].filter((e) => !['enrolled', 'attended', 'absent'].includes(existing.get(e)?.status ?? ''));
      await this.assertRoom(m, s, fresh.length);
      const users: string[] = [];
      for (const empId of fresh) {
        const e = await this.employeeRow(m, empId);
        if (!e || ['exited', 'suspended'].includes(e.status)) throw unprocessable('employee_not_found', 'Unknown or inactive employee', [{ path: 'employee_ids', message: empId }]);
        await this.assertEmployeeInScope(access, 'training:manage', e);
        const prior = existing.get(empId);
        if (prior?.status === 'requested') await this.workflow.cancel(m, 'training_request', prior.id);
        if (prior) await m.getRepository(TrainingEnrolment).update({ id: prior.id }, { status: 'enrolled', decisionComment: null });
        else await m.getRepository(TrainingEnrolment).insert({ sessionId, employeeId: empId, status: 'enrolled' });
        if (e.user_id) users.push(e.user_id);
      }
      await this.notifications.notifyUsers(users, 'training_enrolled', { programme: p.title, number: s.number, starts: await this.when(s.startsAt, m), venue: s.venue ?? 'to be confirmed' }, '/me/training', m);
    });
    return this.session(access, sessionId);
  }

  /** A member of staff asks for a place; the TRAINING approval workflow decides. */
  async requestPlace(access: AccessProfile, sessionId: string, reason: string | null) {
    if (!access.employeeId) throw forbidden('Your account is not linked to an employee record');
    const id = await this.dataSource.transaction(async (m) => {
      const s = await m.getRepository(TrainingSession).findOne({ where: { id: sessionId }, lock: { mode: 'pessimistic_write' } });
      if (!s) throw notFound('Session');
      if (s.status !== 'scheduled' || !s.openForRequests || s.startsAt <= new Date()) throw conflict('not_open', 'This session is not taking requests');
      const p = await m.getRepository(TrainingProgramme).findOneByOrFail({ id: s.programmeId });
      const prior = await m.getRepository(TrainingEnrolment).findOneBy({ sessionId, employeeId: access.employeeId! });
      if (prior && LIVE.includes(prior.status)) throw conflict('already', prior.status === 'requested' ? 'You have already asked for a place' : 'You are already on this session');
      await this.assertRoom(m, s, 1);
      const x = prior ?? m.getRepository(TrainingEnrolment).create({ sessionId, employeeId: access.employeeId! });
      Object.assign(x, { status: 'requested', reason, decisionComment: null });
      await m.getRepository(TrainingEnrolment).save(x);
      const e = (await this.employeeRow(m, access.employeeId!))!;
      const funded = !!s.costPerPerson && new Decimal(s.costPerPerson).gt(0);
      const instance = await this.workflow.submit(m, {
        requestType: 'training_request', kind: funded ? 'funded' : 'internal', subjectId: x.id, subjectEmployeeId: e.id, requesterUserId: access.actorId, value: funded ? Number(s.costPerPerson) : 0,
        summary: `${e.name}: a place on ${p.title} (${s.number})${funded ? `, KES ${new Decimal(s.costPerPerson!).toFixed(2)}` : ''}`,
      });
      x.workflowInstanceId = instance.id;
      await m.getRepository(TrainingEnrolment).save(x);
      return x.id;
    });
    return (await this.enrolmentDtos(this.dataSource.manager, [await this.dataSource.getRepository(TrainingEnrolment).findOneByOrFail({ id })]))[0];
  }

  private async requestDecided(m: EntityManager, i: WorkflowInstance, approved: boolean, comment: string | null) {
    const x = await m.getRepository(TrainingEnrolment).findOneByOrFail({ id: i.subjectId });
    if (x.status !== 'requested') return;
    const s = await m.getRepository(TrainingSession).findOneByOrFail({ id: x.sessionId });
    if (approved) {
      const [{ n }] = await m.query(`SELECT count(*)::int AS n FROM training_enrolment WHERE session_id = $1 AND status IN ('enrolled', 'attended', 'absent')`, [s.id]);
      const full = !!s.capacity && n >= s.capacity;
      const gone = s.status !== 'scheduled';
      Object.assign(x, full || gone ? { status: 'declined', decisionComment: gone ? `The session is ${s.status}` : 'Approved, but the session filled up first' } : { status: 'enrolled', decisionComment: null });
    } else Object.assign(x, { status: 'declined', decisionComment: comment });
    await m.getRepository(TrainingEnrolment).save(x);
  }

  async withdraw(access: AccessProfile, enrolmentId: string) {
    await this.dataSource.transaction(async (m) => {
      const x = await m.getRepository(TrainingEnrolment).findOne({ where: { id: enrolmentId }, lock: { mode: 'pessimistic_write' } });
      if (!x) throw notFound('Enrolment');
      const own = !!access.employeeId && x.employeeId === access.employeeId;
      if (!own) {
        if (!access.has('training:manage')) throw notFound('Enrolment');
        await this.assertEmployeeInScope(access, 'training:manage', (await this.employeeRow(m, x.employeeId))!);
      }
      const s = await m.getRepository(TrainingSession).findOneByOrFail({ id: x.sessionId });
      if (!['requested', 'enrolled'].includes(x.status) || s.status !== 'scheduled') throw conflict('locked', 'This place can no longer be given up');
      if (x.status === 'requested') await this.workflow.cancel(m, 'training_request', x.id);
      Object.assign(x, { status: 'withdrawn', decisionComment: own ? 'Withdrawn by the employee' : 'Withdrawn by HR' });
      await m.getRepository(TrainingEnrolment).save(x);
    });
    return (await this.enrolmentDtos(this.dataSource.manager, [await this.dataSource.getRepository(TrainingEnrolment).findOneByOrFail({ id: enrolmentId })]))[0];
  }

  /**
   * Marks who came. Attending (and passing, when there is a pass mark) completes the
   * training and credits the programme's CPD points; marking someone absent again takes
   * the points back while the session is still open.
   */
  async recordAttendance(access: AccessProfile, sessionId: string, dto: Dto<typeof recordAttendance>) {
    await this.dataSource.transaction(async (m) => {
      const s = await m.getRepository(TrainingSession).findOne({ where: { id: sessionId }, lock: { mode: 'pessimistic_write' } });
      if (!s) throw notFound('Session');
      if (s.status !== 'scheduled') throw conflict('locked', `The session is ${s.status}`);
      if (s.startsAt > new Date()) throw conflict('not_started', 'Attendance can be recorded once the session has started');
      const p = await m.getRepository(TrainingProgramme).findOneByOrFail({ id: s.programmeId });
      const completedOn = await this.localDate(s.endsAt, m);
      for (const rec of dto.records) {
        const x = await m.getRepository(TrainingEnrolment).findOneBy({ id: rec.enrolment_id, sessionId });
        if (!x || !['enrolled', 'attended', 'absent'].includes(x.status)) throw unprocessable('not_enrolled', 'Someone in the list is not enrolled on this session', [{ path: 'records', message: rec.enrolment_id }]);
        const e = (await this.employeeRow(m, x.employeeId))!;
        await this.assertEmployeeInScope(access, 'training:manage', e);
        if (rec.attended && p.passMark && (rec.score === null || rec.score === undefined)) throw unprocessable('score_required', `${p.title} has a pass mark: enter each attendee’s score`, [{ path: 'records', message: e.name }]);
        const wasComplete = x.status === 'attended' && x.passed !== false;
        x.status = rec.attended ? 'attended' : 'absent';
        x.score = rec.attended ? rec.score ?? null : null;
        x.passed = rec.attended && p.passMark ? (rec.score ?? 0) >= p.passMark : null;
        const complete = x.status === 'attended' && x.passed !== false;
        x.completedOn = complete ? completedOn : null;
        const recognised = !p.cpdBodies.length || (!!e.licensing_body && p.cpdBodies.includes(e.licensing_body));
        const points = complete && new Decimal(p.cpdPoints).gt(0) ? p.cpdPoints : null;
        x.cpdPoints = points;
        await m.getRepository(TrainingEnrolment).save(x);
        if (complete && !wasComplete) {
          if (points) {
            const c = await m.getRepository(CpdEntry).save(m.getRepository(CpdEntry).create({
              employeeId: e.id, source: 'training', enrolmentId: x.id, title: p.title, provider: p.provider ?? 'In-house', activityDate: completedOn, points, licensingBody: recognised ? e.licensing_body ?? (p.cpdBodies[0] ?? null) : p.cpdBodies[0] ?? null,
              status: 'verified', verifiedAt: new Date(), verifiedBy: access.actorId,
            }));
            await this.outbox.record(m, 'hr.cpd.verified.v1', e.id, { id: c.id, employee_id: e.id, staff_number: e.staff_number, points: p1(points)!, licensing_body: c.licensingBody, activity_date: completedOn, source: 'training' });
          }
          await this.outbox.record(m, 'hr.training.completed.v1', e.id, {
            id: x.id, employee_id: e.id, staff_number: e.staff_number, programme_id: p.id, programme_code: p.code, completed_on: completedOn, passed: x.passed, cpd_points: p1(points ?? 0)!, valid_until: p.refreshMonths ? addMonths(completedOn, p.refreshMonths) : null,
          });
        }
        if (!complete && wasComplete) await m.getRepository(CpdEntry).delete({ enrolmentId: x.id });
      }
    });
    return this.session(access, sessionId);
  }

  async completeSession(access: AccessProfile, id: string) {
    await this.dataSource.transaction(async (m) => {
      const s = await m.getRepository(TrainingSession).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!s) throw notFound('Session');
      if (s.status !== 'scheduled') throw conflict('locked', `The session is ${s.status}`);
      if (s.endsAt > new Date()) throw conflict('not_finished', 'The session has not finished yet');
      const [{ n }] = await m.query(`SELECT count(*)::int AS n FROM training_enrolment WHERE session_id = $1 AND status = 'enrolled'`, [id]);
      if (n) throw conflict('attendance_missing', `Mark attendance for the ${n} remaining attendee(s) first`);
      for (const x of await m.getRepository(TrainingEnrolment).findBy({ sessionId: id, status: 'requested' })) await this.workflow.cancel(m, 'training_request', x.id);
      await m.getRepository(TrainingEnrolment).update({ sessionId: id, status: 'requested' }, { status: 'declined', decisionComment: 'The session took place before the request was decided' });
      s.status = 'completed';
      await m.getRepository(TrainingSession).save(s);
      await writeAudit(m, { action: 'update', entityType: 'TrainingSession', entityId: s.id, after: { status: 'completed' } });
    });
    return this.session(access, id);
  }

  async feedback(access: AccessProfile, enrolmentId: string, dto: Dto<typeof trainingFeedback>) {
    const repo = this.dataSource.getRepository(TrainingEnrolment);
    const x = await repo.findOneBy({ id: enrolmentId });
    if (!x || x.employeeId !== access.employeeId) throw notFound('Enrolment');
    if (x.status !== 'attended') throw conflict('not_attended', 'Feedback is for sessions you attended');
    Object.assign(x, { feedbackRating: dto.rating, feedbackComment: dto.comment ?? null });
    await repo.save(x);
    return (await this.enrolmentDtos(this.dataSource.manager, [x]))[0];
  }

  // ================================================================== mandatory training
  private async mandatoryRows(m: EntityManager, filter: { employeeId?: string; access?: AccessProfile }) {
    const today = await this.settings.today(m);
    const soon = new Date(`${today}T00:00:00Z`);
    soon.setUTCDate(soon.getUTCDate() + 60);
    const params: unknown[] = [];
    let where = '';
    if (filter.employeeId) {
      params.push(filter.employeeId);
      where = `AND e.id = $1`;
    } else if (filter.access) {
      const f = await this.scope.filterFor(filter.access, 'training:read');
      if (!f.all) {
        params.push(f.branchIds, f.departmentIds, f.employeeIds);
        where = `AND (e.branch_id = ANY($1::uuid[]) OR e.department_id = ANY($2::uuid[]) OR e.id = ANY($3::uuid[]))`;
      }
    }
    const rows: { employee_id: string; employee_name: string; staff_number: string; department_name: string | null; programme_id: string; programme_title: string; refresh_months: number | null; last_completed: string | null }[] = await m.query(
      `SELECT e.id AS employee_id, e.first_name || ' ' || e.last_name AS employee_name, e.staff_number, d.name AS department_name, pr.id AS programme_id, pr.title AS programme_title, pr.refresh_months,
              (SELECT max(x.completed_on)::text FROM training_enrolment x JOIN training_session s ON s.id = x.session_id
                WHERE x.employee_id = e.id AND s.programme_id = pr.id AND x.status = 'attended' AND x.passed IS DISTINCT FROM false) AS last_completed
         FROM training_programme pr
         JOIN employee e ON e.deleted_at IS NULL AND e.status IN ('active', 'probation', 'onboarding')
         LEFT JOIN position p ON p.id = e.position_id LEFT JOIN department d ON d.id = e.department_id
        WHERE pr.status = 'active' AND (pr.mandatory_for = 'all' OR (pr.mandatory_for = 'clinical' AND p.is_clinical)) ${where}
        ORDER BY pr.title, e.last_name, e.first_name`,
      params,
    );
    const soonIso = soon.toISOString().slice(0, 10);
    return rows.map((r) => {
      const due = r.last_completed && r.refresh_months ? addMonths(r.last_completed, r.refresh_months) : null;
      const state: 'current' | 'due_soon' | 'overdue' | 'never' = !r.last_completed ? 'never' : !due ? 'current' : due < today ? 'overdue' : due <= soonIso ? 'due_soon' : 'current';
      return { employee_id: r.employee_id, employee_name: r.employee_name, staff_number: r.staff_number, department_name: r.department_name, programme_id: r.programme_id, programme_title: r.programme_title, last_completed: r.last_completed, due_on: due, state };
    });
  }

  async mandatoryCompliance(access: AccessProfile) {
    const rows = await this.mandatoryRows(this.dataSource.manager, { access });
    const progs = new Map<string, { programme_id: string; programme_title: string; staff: number; current: number; due_soon: number; overdue: number; never: number }>();
    for (const r of rows) {
      const p = progs.get(r.programme_id) ?? { programme_id: r.programme_id, programme_title: r.programme_title, staff: 0, current: 0, due_soon: 0, overdue: 0, never: 0 };
      p.staff++;
      p[r.state]++;
      progs.set(r.programme_id, p);
    }
    const rank = { overdue: 0, never: 1, due_soon: 2, current: 3 };
    return { programmes: [...progs.values()], gaps: rows.filter((r) => r.state !== 'current').sort((a, b) => rank[a.state] - rank[b.state]).slice(0, 1000) };
  }

  async myTraining(access: AccessProfile) {
    if (!access.employeeId) return { enrolments: [], mandatory: [], open_sessions: [] };
    const m = this.dataSource.manager;
    const ids: { id: string }[] = await m.query(`SELECT x.id FROM training_enrolment x JOIN training_session s ON s.id = x.session_id WHERE x.employee_id = $1 ORDER BY s.starts_at DESC LIMIT 200`, [access.employeeId]);
    const byId = new Map((await m.getRepository(TrainingEnrolment).findBy({ id: In(ids.map((i) => i.id)) })).map((x) => [x.id, x]));
    const mine = ids.map((i) => byId.get(i.id)!);
    const open = await m.getRepository(TrainingSession).createQueryBuilder('s').where(`s.status = 'scheduled' AND s.open_for_requests AND s.starts_at > now() AND EXISTS (SELECT 1 FROM training_programme p WHERE p.id = s.programme_id AND p.status = 'active')`).orderBy('s.startsAt', 'ASC').take(50).getMany();
    return { enrolments: await this.enrolmentDtos(m, mine), mandatory: await this.mandatoryRows(m, { employeeId: access.employeeId }), open_sessions: await Promise.all(open.map((s) => this.sessionDto(m, s))) };
  }

  // ================================================================== CPD
  private async cpdDtos(m: EntityManager, rows: CpdEntry[]) {
    if (!rows.length) return [];
    const names = new Map<string, { name: string; staff_number: string }>((await m.query(`SELECT id, first_name || ' ' || last_name AS name, staff_number FROM employee WHERE id = ANY($1::uuid[])`, [[...new Set(rows.map((r) => r.employeeId))]])).map((x: { id: string; name: string; staff_number: string }) => [x.id, x]));
    return rows.map((c) => ({
      id: c.id, employee_id: c.employeeId, employee_name: names.get(c.employeeId)?.name ?? '', staff_number: names.get(c.employeeId)?.staff_number ?? '', source: c.source, enrolment_id: c.enrolmentId, title: c.title, provider: c.provider,
      activity_date: c.activityDate, points: p1(c.points)!, licensing_body: c.licensingBody, evidence_document_id: c.evidenceDocumentId, status: c.status, decision_comment: c.decisionComment, verified_at: c.verifiedAt?.toISOString() ?? null, created_at: c.createdAt.toISOString(),
    }));
  }

  async claimCpd(access: AccessProfile, fields: Dto<typeof cpdClaimFields>, file: Express.Multer.File | undefined) {
    if (!access.employeeId) throw forbidden('Your account is not linked to an employee record');
    const m = this.dataSource.manager;
    const today = await this.settings.today();
    if (fields.activity_date > today) throw unprocessable('future', 'The activity date is in the future', [{ path: 'activity_date', message: 'In the future' }]);
    const e = (await this.employeeRow(m, access.employeeId))!;
    const doc = file ? await this.docs.create({ owner_type: 'employee', owner_id: e.id, title: `CPD evidence: ${fields.title}`.slice(0, 200), category: 'cpd_evidence', is_sensitive: 'false' }, file, access.actorId) : null;
    const c = await m.getRepository(CpdEntry).save(m.getRepository(CpdEntry).create({
      employeeId: e.id, source: 'external', title: fields.title, provider: fields.provider || null, activityDate: fields.activity_date, points: fields.points, licensingBody: fields.licensing_body || e.licensing_body, evidenceDocumentId: doc?.id ?? null, status: 'pending',
    }));
    await this.notifications.notifyPermissionHolders('cpd:verify', 'cpd_claim_submitted', { employee: e.name, staff_number: e.staff_number, points: p1(c.points), title: c.title }, '/training/cpd', m);
    return (await this.cpdDtos(m, [c]))[0];
  }

  async cpdEntries(access: AccessProfile, q: { status?: string; employee_id?: string }) {
    const m = this.dataSource.manager;
    const qb = m.getRepository(CpdEntry).createQueryBuilder('c').innerJoin('employee', 'e', 'e.id = c.employee_id').orderBy('c.createdAt', 'DESC').take(1000);
    if (q.status) qb.andWhere('c.status = :s', { s: q.status });
    if (q.employee_id) qb.andWhere('c.employee_id = :e', { e: q.employee_id });
    applyScope(qb, await this.scope.filterFor(access, 'training:read'), { branch: 'e.branch_id', department: 'e.department_id', employee: 'e.id' });
    return this.cpdDtos(m, await qb.getMany());
  }

  async decideCpd(access: AccessProfile, id: string, dto: Dto<typeof cpdDecision>) {
    return this.dataSource.transaction(async (tm) => {
      const c = await tm.getRepository(CpdEntry).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!c) throw notFound('CPD entry');
      const e = (await this.employeeRow(tm, c.employeeId))!;
      await this.assertEmployeeInScope(access, 'cpd:verify', e);
      if (c.employeeId === access.employeeId) throw forbidden('Nobody verifies their own CPD');
      if (c.status !== 'pending') throw conflict('decided', `Already ${c.status}`);
      const verified = dto.decision === 'verify';
      Object.assign(c, { status: verified ? 'verified' : 'rejected', decisionComment: dto.comment ?? null, verifiedBy: access.actorId, verifiedAt: new Date() });
      await tm.getRepository(CpdEntry).save(c);
      if (verified) await this.outbox.record(tm, 'hr.cpd.verified.v1', e.id, { id: c.id, employee_id: e.id, staff_number: e.staff_number, points: p1(c.points)!, licensing_body: c.licensingBody, activity_date: c.activityDate, source: 'external' });
      if (e.user_id) await this.notifications.notifyUsers([e.user_id], 'cpd_claim_decided', { title: c.title, outcome: c.status, comment: c.decisionComment ?? '' }, '/me/training', tm);
      return (await this.cpdDtos(tm, [c]))[0];
    });
  }

  async cpdEvidence(access: AccessProfile, id: string) {
    const m = this.dataSource.manager;
    const c = await m.getRepository(CpdEntry).findOneBy({ id });
    if (!c || !c.evidenceDocumentId) throw notFound('Evidence');
    if (c.employeeId !== access.employeeId) {
      const e = (await this.employeeRow(m, c.employeeId))!;
      const f1 = access.has('training:read') ? await this.scope.filterFor(access, 'training:read') : null;
      const f2 = access.has('cpd:verify') ? await this.scope.filterFor(access, 'cpd:verify') : null;
      const row = { branchId: e.branch_id, departmentId: e.department_id, employeeId: e.id };
      if (!(f1 && scopeAllows(f1, row)) && !(f2 && scopeAllows(f2, row))) throw notFound('Evidence');
    }
    return this.docs.read(c.evidenceDocumentId);
  }

  async requirements() {
    const rows = await this.dataSource.getRepository(CpdRequirement).find({ order: { licensingBody: 'ASC' } });
    return rows.map((r) => ({ licensing_body: r.licensingBody, points_per_year: p1(r.pointsPerYear)!, description: r.description }));
  }

  async setRequirements(dto: Dto<typeof setCpdRequirements>) {
    if (new Set(dto.requirements.map((r) => r.licensing_body)).size !== dto.requirements.length) throw unprocessable('duplicate', 'Each licensing body once', [{ path: 'requirements', message: 'Duplicate' }]);
    await this.dataSource.transaction(async (m) => {
      const before = await m.getRepository(CpdRequirement).find();
      const dropped = before.map((b) => b.licensingBody).filter((b) => !dto.requirements.some((r) => r.licensing_body === b));
      if (dropped.length) await m.getRepository(CpdRequirement).delete({ licensingBody: In(dropped) });
      for (const r of dto.requirements) {
        const row = before.find((b) => b.licensingBody === r.licensing_body) ?? m.getRepository(CpdRequirement).create({ licensingBody: r.licensing_body });
        Object.assign(row, { pointsPerYear: r.points_per_year, description: r.description ?? null });
        await m.getRepository(CpdRequirement).save(row);
      }
      await writeAudit(m, { action: 'update', entityType: 'CpdRequirement', entityId: '00000000-0000-0000-0000-000000000000', before: { requirements: before.map((b) => ({ body: b.licensingBody, points: b.pointsPerYear })) }, after: { requirements: dto.requirements } });
    });
    return this.requirements();
  }

  /** CPD per clinical member of staff for a calendar year, against their licensing body's requirement. */
  private async complianceRows(m: EntityManager, year: number, filter: { employeeId?: string; access?: AccessProfile }) {
    const params: unknown[] = [`${year}-01-01`, `${year}-12-31`];
    let where = '';
    if (filter.employeeId) {
      params.push(filter.employeeId);
      where = `AND e.id = $3`;
    } else if (filter.access) {
      const f = await this.scope.filterFor(filter.access, 'training:read');
      if (!f.all) {
        params.push(f.branchIds, f.departmentIds, f.employeeIds);
        where = `AND (e.branch_id = ANY($3::uuid[]) OR e.department_id = ANY($4::uuid[]) OR e.id = ANY($5::uuid[]))`;
      }
    }
    const rows: { employee_id: string; employee_name: string; staff_number: string; department_name: string | null; licensing_body: string; licence_expiry: string | null; required: string | null; earned: string; pending: string }[] = await m.query(
      `SELECT e.id AS employee_id, e.first_name || ' ' || e.last_name AS employee_name, e.staff_number, d.name AS department_name, l.licensing_body, l.expiry_date::text AS licence_expiry, rq.points_per_year AS required,
              COALESCE((SELECT sum(c.points) FROM cpd_entry c WHERE c.employee_id = e.id AND c.status = 'verified' AND c.licensing_body = l.licensing_body AND c.activity_date BETWEEN $1 AND $2), 0) AS earned,
              COALESCE((SELECT sum(c.points) FROM cpd_entry c WHERE c.employee_id = e.id AND c.status = 'pending' AND c.licensing_body = l.licensing_body AND c.activity_date BETWEEN $1 AND $2), 0) AS pending
         FROM employee e
         JOIN LATERAL (SELECT licensing_body, expiry_date FROM professional_licence pl WHERE pl.employee_id = e.id AND pl.deleted_at IS NULL ORDER BY pl.expiry_date DESC LIMIT 1) l ON true
         LEFT JOIN cpd_requirement rq ON rq.licensing_body = l.licensing_body
         LEFT JOIN department d ON d.id = e.department_id
        WHERE e.deleted_at IS NULL AND e.status IN ('active', 'probation', 'onboarding', 'on_notice') ${where}
        ORDER BY e.last_name, e.first_name`,
      params,
    );
    return rows.map((r) => ({
      ...r, required: p1(r.required ?? 0)!, earned: p1(r.earned)!, pending: p1(r.pending)!,
      status: (r.required === null ? 'no_requirement' : new Decimal(r.earned).gte(r.required) ? 'met' : 'short') as 'met' | 'short' | 'no_requirement',
    }));
  }

  async cpdCompliance(access: AccessProfile, year: number) {
    return this.complianceRows(this.dataSource.manager, year, { access });
  }

  async myCpd(access: AccessProfile, year: number) {
    if (!access.employeeId) return { year, entries: [], summary: [] };
    const m = this.dataSource.manager;
    const entries = await m.getRepository(CpdEntry).createQueryBuilder('c').where('c.employee_id = :e', { e: access.employeeId }).andWhere(`extract(year FROM c.activity_date) = :y`, { y: year }).orderBy('c.activityDate', 'DESC').getMany();
    return { year, entries: await this.cpdDtos(m, entries), summary: await this.complianceRows(m, year, { employeeId: access.employeeId }) };
  }

  /**
   * Daily: a licence expiring within 60 days whose holder is short of CPD points for the
   * twelve months before expiry gets one reminder (to the holder and to training managers).
   */
  async sweep(): Promise<number> {
    const m = this.dataSource.manager;
    const today = await this.settings.today();
    const until = new Date(`${today}T00:00:00Z`);
    until.setUTCDate(until.getUTCDate() + CPD_REMINDER_DAYS);
    const due: { id: string; employee_id: string; licensing_body: string; expiry_date: string; required: string; earned: string; name: string; staff_number: string; user_id: string | null }[] = await m.query(
      `SELECT l.id, l.employee_id, l.licensing_body, l.expiry_date::text AS expiry_date, rq.points_per_year AS required, e.first_name || ' ' || e.last_name AS name, e.staff_number,
              (SELECT id FROM user_account u WHERE u.employee_id = e.id AND u.status = 'active' LIMIT 1) AS user_id,
              COALESCE((SELECT sum(c.points) FROM cpd_entry c WHERE c.employee_id = e.id AND c.status = 'verified' AND c.licensing_body = l.licensing_body AND c.activity_date > l.expiry_date - interval '12 months' AND c.activity_date <= l.expiry_date), 0) AS earned
         FROM professional_licence l JOIN employee e ON e.id = l.employee_id JOIN cpd_requirement rq ON rq.licensing_body = l.licensing_body
        WHERE l.deleted_at IS NULL AND NOT l.suspended AND e.deleted_at IS NULL AND e.status <> 'exited'
          AND l.expiry_date BETWEEN $1 AND $2 AND l.cpd_notified_for IS DISTINCT FROM l.expiry_date AND rq.points_per_year > 0`,
      [today, until.toISOString().slice(0, 10)],
    );
    let sent = 0;
    for (const d of due) {
      await m.query(`UPDATE professional_licence SET cpd_notified_for = expiry_date WHERE id = $1`, [d.id]);
      if (new Decimal(d.earned).gte(d.required)) continue;
      const vars = { name: d.name, staff_number: d.staff_number, body: d.licensing_body, expiry: d.expiry_date, earned: p1(d.earned), required: p1(d.required) };
      if (d.user_id) await this.notifications.notifyUsers([d.user_id], 'cpd_shortfall', vars, '/me/training', m);
      await this.notifications.notifyPermissionHolders('training:manage', 'cpd_shortfall', vars, '/training/cpd', m);
      sent++;
    }
    return sent;
  }
}
