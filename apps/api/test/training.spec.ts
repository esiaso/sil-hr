import { TrainingService } from '../src/modules/training/training.service';
import { api, bearer, closeApp, db, login, testApp, uniq } from './helpers';

afterAll(closeApp);

const B = '/api/v1';
const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

async function approveAll(subjectId: string) {
  const app = await testApp();
  const people = ['line.manager', 'hr.manager', 'head.nursing', 'admin'];
  for (let guard = 0; guard < 6; guard++) {
    let acted = false;
    for (const p of people) {
      const t = await login(app, p);
      const task = (await api(app).get(`${B}/workflow/inbox`).set(bearer(t))).body.find((x: { subject_id: string }) => x.subject_id === subjectId);
      if (!task) continue;
      const r = await api(app).post(`${B}/workflow/tasks/${task.id}/decision`).set(bearer(t)).send({ decision: 'approve' });
      if (r.status === 200) { acted = true; break; }
    }
    if (!acted) return;
  }
}

describe('training', () => {
  const code = `SEPSIS${uniq()}`;
  let progId = '';
  let future = '';
  let past = '';
  let empId = '';
  let otherId = '';

  it('HR sets up a programme with a pass mark and NCK CPD points, and sessions', async () => {
    const app = await testApp();
    const hrm = await login(app, 'hr.manager');
    expect((await api(app).post(`${B}/training/programmes`).set(bearer(hrm)).send({ code, title: 'Sepsis recognition', category: 'clinical', delivery: 'classroom', refresh_months: 12 })).status).toBe(422);
    const p = await api(app).post(`${B}/training/programmes`).set(bearer(hrm)).send({ code, title: 'Sepsis recognition', category: 'clinical', delivery: 'classroom', duration_hours: '4', cpd_points: '4', cpd_bodies: ['nck'], pass_mark: 75 });
    expect(p.status).toBe(201);
    expect(p.body).toMatchObject({ cpd_points: '4.0', cpd_bodies: ['NCK'], pass_mark: 75 });
    progId = p.body.id;
    const f = await api(app).post(`${B}/training/sessions`).set(bearer(hrm)).send({ programme_id: progId, starts_at: hoursFromNow(48), ends_at: hoursFromNow(52), venue: 'Skills lab', capacity: 10 });
    expect(f.status).toBe(201);
    expect(f.body.number).toMatch(/^TRN\//);
    future = f.body.id;
    const s = await api(app).post(`${B}/training/sessions`).set(bearer(hrm)).send({ programme_id: progId, starts_at: hoursFromNow(-4), ends_at: hoursFromNow(-1), venue: 'Skills lab', capacity: 2 });
    past = s.body.id;
    expect((await api(app).get(`${B}/training/sessions`).set(bearer(await login(app, 'recruiter')))).status).toBe(403);
    [{ employee_id: empId }] = await db(app).query(`SELECT employee_id FROM user_account WHERE username = 'employee'`);
    [{ id: otherId }] = await db(app).query(`SELECT e.id FROM employee e JOIN position p ON p.id = e.position_id WHERE p.code = 'RN-MED' AND e.id <> $1 AND e.status = 'active' AND EXISTS (SELECT 1 FROM professional_licence l WHERE l.employee_id = e.id) ORDER BY e.staff_number LIMIT 1`, [empId]);
  });

  it('staff ask for a place; the line manager approves it', async () => {
    const app = await testApp();
    const emp = await login(app, 'employee');
    const dbg = await api(app).get(`${B}/me/training`).set(bearer(emp));
    expect(dbg.body.open_sessions.some((s: { id: string }) => s.id === future)).toBe(true);
    const r = await api(app).post(`${B}/training/sessions/${future}/request`).set(bearer(emp)).send({ reason: 'Sepsis cases rising on the ward' });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('requested');
    expect((await api(app).post(`${B}/training/sessions/${future}/request`).set(bearer(emp)).send({})).status).toBe(409);
    await approveAll(r.body.id);
    const mine = (await api(app).get(`${B}/me/training`).set(bearer(emp))).body.enrolments.find((x: { id: string }) => x.id === r.body.id);
    expect(mine.status).toBe('enrolled');
    const w = await api(app).post(`${B}/training/enrolments/${r.body.id}/withdraw`).set(bearer(emp));
    expect(w.body.status).toBe('withdrawn');
  });

  it('a funded session needs the HR manager as well', async () => {
    const app = await testApp();
    const hrm = await login(app, 'hr.manager');
    const s = await api(app).post(`${B}/training/sessions`).set(bearer(hrm)).send({ programme_id: progId, starts_at: hoursFromNow(200), ends_at: hoursFromNow(208), cost_per_person: '12000.00' });
    const r = await api(app).post(`${B}/training/sessions/${s.body.id}/request`).set(bearer(await login(app, 'employee'))).send({});
    const [inst] = await db(app).query(`SELECT d.code FROM workflow_instance i JOIN workflow_definition d ON d.id = i.definition_id WHERE i.subject_id = $1`, [r.body.id]);
    expect(inst.code).toBe('TRAINING-FUNDED');
    await approveAll(r.body.id);
    const [x] = await db(app).query(`SELECT status FROM training_enrolment WHERE id = $1`, [r.body.id]);
    expect(x.status).toBe('enrolled');
  });

  it('attendance with scores: a pass completes the training and credits CPD points', async () => {
    const app = await testApp();
    const hrm = await login(app, 'hr.manager');
    const [third] = await db(app).query(`SELECT e.id FROM employee e JOIN position p ON p.id = e.position_id WHERE p.code = 'RN-SUR' LIMIT 1`);
    expect((await api(app).post(`${B}/training/sessions/${past}/enrol`).set(bearer(hrm)).send({ employee_ids: [empId, otherId, third.id] })).status).toBe(409);
    const en = await api(app).post(`${B}/training/sessions/${past}/enrol`).set(bearer(hrm)).send({ employee_ids: [empId, otherId] });
    expect(en.status).toBe(200);
    const byEmp = (id: string) => en.body.attendees.find((a: { employee_id: string }) => a.employee_id === id).id;
    expect((await api(app).post(`${B}/training/sessions/${past}/complete`).set(bearer(hrm))).status).toBe(409);
    expect((await api(app).post(`${B}/training/sessions/${past}/attendance`).set(bearer(hrm)).send({ records: [{ enrolment_id: byEmp(empId), attended: true }] })).status).toBe(422);
    const at = await api(app).post(`${B}/training/sessions/${past}/attendance`).set(bearer(hrm)).send({ records: [{ enrolment_id: byEmp(empId), attended: true, score: 90 }, { enrolment_id: byEmp(otherId), attended: true, score: 60 }] });
    expect(at.status).toBe(200);
    const mineRow = at.body.attendees.find((a: { employee_id: string }) => a.employee_id === empId);
    expect(mineRow).toMatchObject({ status: 'attended', passed: true, cpd_points: '4.0' });
    expect(at.body.attendees.find((a: { employee_id: string }) => a.employee_id === otherId)).toMatchObject({ passed: false, cpd_points: null });
    const [evt] = await db(app).query(`SELECT data FROM outbox_event WHERE type = 'hr.training.completed.v1' AND data->>'id' = $1`, [byEmp(empId)]);
    expect(evt.data).toMatchObject({ programme_code: code, passed: true, cpd_points: '4.0', valid_until: null });
    expect((await api(app).post(`${B}/training/sessions/${past}/complete`).set(bearer(hrm))).body.status).toBe('completed');

    const emp = await login(app, 'employee');
    expect((await api(app).put(`${B}/training/enrolments/${byEmp(empId)}/feedback`).set(bearer(emp)).send({ rating: 5, comment: 'Practical and useful' })).body.feedback_rating).toBe(5);
    const cpd = (await api(app).get(`${B}/me/cpd`).set(bearer(emp))).body;
    expect(cpd.entries.find((e: { enrolment_id: string }) => e.enrolment_id === byEmp(empId))).toMatchObject({ points: '4.0', licensing_body: 'NCK', status: 'verified' });
    expect(cpd.summary[0]).toMatchObject({ licensing_body: 'NCK', required: '20.0' });
  });

  it('outside CPD is claimed with evidence and verified by HR', async () => {
    const app = await testApp();
    const emp = await login(app, 'employee');
    const before = (await api(app).get(`${B}/me/cpd`).set(bearer(emp))).body.summary[0].earned;
    const c = await api(app).post(`${B}/me/cpd`).set(bearer(emp)).field('title', 'Kenya nursing conference').field('provider', 'NNAK').field('activity_date', new Date().toISOString().slice(0, 10)).field('points', '6').attach('evidence', PDF, { filename: 'cert.pdf', contentType: 'application/pdf' });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ status: 'pending', licensing_body: 'NCK', points: '6.0' });
    expect((await api(app).get(`${B}/training/cpd/${c.body.id}/evidence`).set(bearer(emp))).status).toBe(200);
    expect((await api(app).post(`${B}/training/cpd/${c.body.id}/decision`).set(bearer(emp)).send({ decision: 'verify' })).status).toBe(403);
    const hro = await login(app, 'hr.officer');
    expect((await api(app).post(`${B}/training/cpd/${c.body.id}/decision`).set(bearer(hro)).send({ decision: 'reject' })).status).toBe(422);
    expect((await api(app).post(`${B}/training/cpd/${c.body.id}/decision`).set(bearer(hro)).send({ decision: 'verify' })).body.status).toBe('verified');
    const after = (await api(app).get(`${B}/me/cpd`).set(bearer(emp))).body.summary[0].earned;
    expect(Number(after) - Number(before)).toBeCloseTo(6);
    const rows = (await api(app).get(`${B}/training/cpd-compliance`).set(bearer(await login(app, 'hr.manager')))).body;
    expect(rows.find((r: { employee_id: string }) => r.employee_id === empId)).toMatchObject({ licensing_body: 'NCK' });
  });

  it('mandatory training compliance and the CPD reminder before a licence expires', async () => {
    const app = await testApp();
    const hrm = await login(app, 'hr.manager');
    const comp = (await api(app).get(`${B}/training/compliance`).set(bearer(hrm))).body;
    const bls = comp.programmes.find((p: { programme_title: string }) => p.programme_title.startsWith('Basic Life Support'));
    expect(bls.staff).toBeGreaterThan(5);
    expect(bls.current).toBeGreaterThan(0);

    const body = `TB${uniq()}`;
    const exp = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    await db(app).query(`INSERT INTO cpd_requirement (licensing_body, points_per_year) VALUES ($1, 10)`, [body]);
    const [lic] = await db(app).query(`INSERT INTO professional_licence (employee_id, licensing_body, licence_number, expiry_date) VALUES ($1, $2, $3, $4) RETURNING id`, [otherId, body, `${body}/1`, exp]);
    try {
      expect(await app.get(TrainingService).sweep()).toBeGreaterThan(0);
      const [l] = await db(app).query(`SELECT cpd_notified_for::text AS d FROM professional_licence WHERE id = $1`, [lic.id]);
      expect(l.d).toBe(exp);
      expect(await app.get(TrainingService).sweep()).toBe(0);
    } finally {
      await db(app).query(`DELETE FROM professional_licence WHERE id = $1`, [lic.id]);
      await db(app).query(`DELETE FROM cpd_requirement WHERE licensing_body = $1`, [body]);
    }
  });
});
