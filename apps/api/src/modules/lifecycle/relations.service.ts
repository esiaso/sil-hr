import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { z } from 'zod';
import { addRelationsNote, createRelationsCase, raiseComplaint, updateRelationsCase } from '@sil/hr-shared';
import { AccessProfile, scopeAllows } from '../../common/access';
import { conflict, notFound, unprocessable } from '../../common/problem';
import { RequestContext } from '../../common/request-context';
import { NotificationsService } from '../notifications/notifications.module';
import { ScopeService } from '../organisation/scope.service';
import { SettingsService } from '../settings/settings.module';
import { ImprovementObjective, RelationsCase, RelationsCaseAccess, RelationsNote } from './lifecycle.entities';

type Dto<T extends z.ZodType> = z.infer<T>;

/**
 * Warnings, improvement plans, awards, disciplinary cases and complaints.
 *
 * Visibility: an ordinary case is seen by holders of relations:read in scope and by the
 * employee it is about (with the notes marked for them). A restricted case (every
 * complaint) is seen only by the people named on it and by the complainant; HR scope does
 * not reach it, and the person complained about does not see it.
 */
@Injectable()
export class RelationsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly scope: ScopeService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  private async canSee(m: EntityManager, access: AccessProfile, c: RelationsCase): Promise<'full' | 'employee' | null> {
    const named = await m.getRepository(RelationsCaseAccess).existsBy({ caseId: c.id, userId: access.actorId });
    if (named) return 'full';
    if (c.restricted) return c.complainantEmployeeId && c.complainantEmployeeId === access.employeeId ? 'employee' : null;
    if (c.employeeId && c.employeeId === access.employeeId) return 'employee';
    if (!access.has('relations:read') || !c.employeeId) return null;
    const [e] = await m.query(`SELECT branch_id, department_id FROM employee WHERE id = $1`, [c.employeeId]);
    return scopeAllows(await this.scope.filterFor(access, 'relations:read'), { branchId: e?.branch_id, departmentId: e?.department_id, employeeId: c.employeeId }) ? 'full' : null;
  }

  private async dto(m: EntityManager, c: RelationsCase, view: 'full' | 'employee') {
    const [names] = await m.query(
      `SELECT (SELECT first_name || ' ' || last_name FROM employee WHERE id = $1) AS employee, (SELECT first_name || ' ' || last_name FROM employee WHERE id = $2) AS complainant`,
      [c.employeeId, c.complainantEmployeeId],
    );
    const notes = await m.getRepository(RelationsNote).find({ where: { caseId: c.id, ...(view === 'employee' ? { visibleToEmployee: true } : {}) }, order: { createdAt: 'ASC' } });
    const objectives = await m.getRepository(ImprovementObjective).find({ where: { caseId: c.id }, order: { seq: 'ASC' } });
    const access: { user_id: string; name: string; role: 'owner' | 'investigator' }[] = view === 'full' ? await m.query(`SELECT a.user_id, u.display_name AS name, a.role FROM relations_case_access a JOIN user_account u ON u.id = a.user_id WHERE a.case_id = $1`, [c.id]) : [];
    // A complainant sees their own complaint but not who else is named, nor internal notes.
    const aboutName = c.kind === 'complaint' && view === 'employee' ? null : names.employee;
    return {
      id: c.id, number: c.number, kind: c.kind, employee_id: c.kind === 'complaint' && view === 'employee' ? null : c.employeeId, employee_name: aboutName, subject: c.subject, details: c.details, severity: c.severity,
      opened_on: c.openedOn, review_date: c.reviewDate, expires_on: c.expiresOn, status: c.status, outcome: c.outcome, restricted: c.restricted, complainant_name: view === 'full' ? names.complainant : null,
      acknowledged_at: c.acknowledgedAt?.toISOString() ?? null, document_ids: c.documentIds,
      objectives: objectives.map((o) => ({ id: o.id, objective: o.objective, measure: o.measure, due_date: o.dueDate, status: o.status, comment: o.comment })),
      notes: notes.map((n) => ({ id: n.id, created_at: n.createdAt.toISOString(), author_name: n.authorName, body: n.body, visible_to_employee: n.visibleToEmployee })),
      access, created_at: c.createdAt.toISOString(), updated_at: c.updatedAt.toISOString(), version: c.version,
    };
  }

  async list(access: AccessProfile, q: { employee_id?: string; kind?: string; status?: string }) {
    const m = this.dataSource.manager;
    const rows = await m.getRepository(RelationsCase).createQueryBuilder('c')
      .where(q.employee_id ? 'c.employee_id = :e' : '1=1', { e: q.employee_id })
      .andWhere(q.kind ? 'c.kind = :k' : '1=1', { k: q.kind })
      .andWhere(q.status ? 'c.status = :s' : '1=1', { s: q.status })
      .orderBy('c.openedOn', 'DESC').take(1000).getMany();
    const out = [];
    for (const c of rows) {
      const view = await this.canSee(m, access, c);
      if (view) out.push(await this.dto(m, c, view));
    }
    return out;
  }

  async get(access: AccessProfile, id: string) {
    const m = this.dataSource.manager;
    const c = await m.getRepository(RelationsCase).findOneBy({ id });
    const view = c ? await this.canSee(m, access, c) : null;
    if (!c || !view) throw notFound('Case');
    return this.dto(m, c, view);
  }

  private async number(m: EntityManager) {
    const [{ n }] = await m.query(`SELECT count(*)::int + 1 AS n FROM relations_case WHERE created_at >= date_trunc('year', now())`);
    return `ER/${new Date().getUTCFullYear()}/${String(n).padStart(5, '0')}`;
  }

  private async hrManagers(m: EntityManager): Promise<string[]> {
    return (await m.query(`SELECT DISTINCT u.id FROM user_account u JOIN role_assignment ra ON ra.user_id = u.id JOIN role r ON r.id = ra.role_id WHERE r.code = 'hr_manager' AND u.status = 'active'`)).map((r: { id: string }) => r.id);
  }

  async create(access: AccessProfile, dto: Dto<typeof createRelationsCase>) {
    return this.dataSource.transaction(async (m) => {
      if (dto.employee_id) {
        const [e] = await m.query(`SELECT branch_id, department_id FROM employee WHERE id = $1`, [dto.employee_id]);
        if (!e) throw notFound('Employee');
        if (!scopeAllows(await this.scope.filterFor(access, 'relations:manage'), { branchId: e.branch_id, departmentId: e.department_id, employeeId: dto.employee_id })) throw notFound('Employee');
      }
      const restricted = dto.kind === 'complaint' ? true : (dto.restricted ?? false);
      const c = await m.getRepository(RelationsCase).save(m.getRepository(RelationsCase).create({
        number: await this.number(m), kind: dto.kind, employeeId: dto.employee_id ?? null, subject: dto.subject, details: dto.details ?? null, severity: dto.kind === 'warning' ? (dto.severity ?? null) : null,
        openedOn: dto.opened_on ?? (await this.settings.today(m)), reviewDate: dto.review_date ?? null, expiresOn: dto.expires_on ?? null, restricted, complainantEmployeeId: dto.complainant_employee_id ?? null, documentIds: dto.document_ids,
      }));
      await m.getRepository(RelationsCaseAccess).insert([{ caseId: c.id, userId: access.actorId, role: 'owner' }, ...dto.investigator_user_ids.filter((u) => u !== access.actorId).map((u) => ({ caseId: c.id, userId: u, role: 'investigator' as const }))]);
      if (dto.objectives.length) await m.getRepository(ImprovementObjective).insert(dto.objectives.map((o, i) => ({ caseId: c.id, seq: i + 1, objective: o.objective, measure: o.measure ?? null, dueDate: o.due_date ?? null, status: o.status, comment: o.comment ?? null })));
      // The employee is told about warnings, plans and awards (not about complaints against them).
      if (c.employeeId && !restricted) {
        const users: { id: string }[] = await m.query(`SELECT id FROM user_account WHERE employee_id = $1 AND status = 'active'`, [c.employeeId]);
        await this.notifications.notifyUsers(users.map((u) => u.id), 'relations_case_opened', { kind: dto.kind.replace('_', ' '), subject: c.subject }, '/lifecycle/relations', m);
      }
      return this.dto(m, c, 'full');
    });
  }

  /** Staff raise their own grievance: restricted from the start, owned by the HR managers. */
  async raise(access: AccessProfile, dto: Dto<typeof raiseComplaint>) {
    if (!access.employeeId) throw unprocessable('no_employee', 'Your account is not linked to an employee record');
    return this.dataSource.transaction(async (m) => {
      const c = await m.getRepository(RelationsCase).save(m.getRepository(RelationsCase).create({
        number: await this.number(m), kind: 'complaint', employeeId: dto.about_employee_id ?? null, subject: dto.subject, details: dto.details, openedOn: await this.settings.today(m), restricted: true,
        complainantEmployeeId: access.employeeId, documentIds: dto.document_ids,
      }));
      const owners = await this.hrManagers(m);
      if (owners.length) await m.getRepository(RelationsCaseAccess).insert(owners.map((u) => ({ caseId: c.id, userId: u, role: 'owner' as const })));
      await this.notifications.notifyUsers(owners, 'relations_complaint_raised', { number: c.number }, '/lifecycle/relations', m);
      return this.dto(m, c, 'employee');
    });
  }

  private async loadFull(m: EntityManager, access: AccessProfile, id: string) {
    const c = await m.getRepository(RelationsCase).findOneBy({ id });
    if (!c || (await this.canSee(m, access, c)) !== 'full') throw notFound('Case');
    return c;
  }

  async update(access: AccessProfile, id: string, dto: Dto<typeof updateRelationsCase>) {
    return this.dataSource.transaction(async (m) => {
      const c = await this.loadFull(m, access, id);
      if (dto.status) c.status = dto.status;
      if (dto.outcome !== undefined) c.outcome = dto.outcome ?? null;
      if (dto.review_date !== undefined) c.reviewDate = dto.review_date ?? null;
      await m.getRepository(RelationsCase).save(c);
      if (dto.objectives) {
        await m.getRepository(ImprovementObjective).delete({ caseId: c.id });
        await m.getRepository(ImprovementObjective).insert(dto.objectives.map((o, i) => ({ caseId: c.id, seq: i + 1, objective: o.objective, measure: o.measure ?? null, dueDate: o.due_date ?? null, status: o.status, comment: o.comment ?? null })));
      }
      if (dto.investigator_user_ids) {
        await m.query(`DELETE FROM relations_case_access WHERE case_id = $1 AND role = 'investigator'`, [c.id]);
        const owners = new Set((await m.getRepository(RelationsCaseAccess).findBy({ caseId: c.id })).map((a) => a.userId));
        const add = dto.investigator_user_ids.filter((u) => !owners.has(u));
        if (add.length) await m.getRepository(RelationsCaseAccess).insert(add.map((u) => ({ caseId: c.id, userId: u, role: 'investigator' as const })));
      }
      return this.dto(m, c, 'full');
    });
  }

  async addNote(access: AccessProfile, id: string, dto: Dto<typeof addRelationsNote>) {
    return this.dataSource.transaction(async (m) => {
      const c = await this.loadFull(m, access, id);
      await m.getRepository(RelationsNote).insert({ caseId: c.id, createdBy: access.actorId, authorName: RequestContext.get()?.actorName ?? access.actorName, body: dto.body, visibleToEmployee: dto.visible_to_employee });
      return this.dto(m, c, 'full');
    });
  }

  /** The employee confirms they have received a warning, plan or award. */
  async acknowledge(access: AccessProfile, id: string) {
    return this.dataSource.transaction(async (m) => {
      const c = await m.getRepository(RelationsCase).findOneBy({ id });
      if (!c || !c.employeeId || c.employeeId !== access.employeeId || c.restricted) throw notFound('Case');
      if (c.acknowledgedAt) throw conflict('already_acknowledged', 'Already acknowledged');
      c.acknowledgedAt = new Date();
      await m.getRepository(RelationsCase).save(c);
      return this.dto(m, c, 'employee');
    });
  }
}
