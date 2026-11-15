import { RecruitmentService } from '../src/modules/recruitment/recruitment.service';
import { api, bearer, closeApp, db, idOf, login, testApp, uniq } from './helpers';

afterAll(closeApp);

const B = '/api/v1';
const plus = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

/** Approves every step of a request, each by the first eligible person found. */
async function approveAll(subjectId: string) {
  const app = await testApp();
  const people = ['admin', 'hr.manager', 'finance', 'head.nursing', 'line.manager', 'hr.officer'];
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

describe('recruitment', () => {
  let reqId = '';
  let slug = '';
  let postingId = '';
  let appId = '';
  const email = `candidate.${uniq().toLowerCase()}@example.com`;

  it('a requisition is approved through its workflow', async () => {
    const app = await testApp();
    const head = await login(app, 'head.nursing');
    const pos = await idOf(app, 'position', 'code', 'RN-MED');
    const bad = await api(app).post(`${B}/requisitions`).set(bearer(head)).send({ position_id: pos, employment_type: 'permanent', reason: 'replacement', justification: 'Someone resigned last month' });
    expect(bad.status).toBe(422);
    const r = await api(app).post(`${B}/requisitions`).set(bearer(head)).send({ position_id: pos, headcount: 1, employment_type: 'permanent', reason: 'new', salary_min: '60000.00', salary_max: '80000.00', justification: 'More beds opened on the medical ward' });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('pending');
    reqId = r.body.id;
    await approveAll(reqId);
    const list = (await api(app).get(`${B}/requisitions`).set(bearer(await login(app, 'recruiter')))).body;
    expect(list.find((x: { id: string }) => x.id === reqId).status).toBe('approved');
    const [evt] = await db(app).query(`SELECT count(*)::int AS n FROM outbox_event WHERE type = 'hr.requisition.approved.v1' AND subject = $1`, [reqId]);
    expect(evt.n).toBe(1);
  });

  it('the recruiter advertises it; the public careers site lists it and takes applications', async () => {
    const app = await testApp();
    const rec = await login(app, 'recruiter');
    const p = await api(app).post(`${B}/job-postings`).set(bearer(rec)).send({
      requisition_id: reqId, title: 'Registered Nurse, Medical Ward', description: 'Care for adult medical patients on a busy 32-bed ward, day and night shifts.', closing_date: plus(14), show_salary: true, status: 'published',
      questions: [{ key: 'nck_licence', label: 'Do you hold a current NCK licence?', type: 'yes_no', required: true }],
    });
    expect(p.status).toBe(201);
    slug = p.body.slug;
    postingId = p.body.id;
    const jobs = (await api(app).get(`${B}/careers/jobs`)).body;
    const job = jobs.find((j: { slug: string }) => j.slug === slug);
    expect(job).toMatchObject({ title: 'Registered Nurse, Medical Ward', salary: 'KES 60,000 – 80,000 a month' });
    expect(job.id).toBeUndefined();

    const form = (extra: Record<string, string> = {}) => {
      const r = api(app).post(`${B}/careers/jobs/${slug}/applications`);
      for (const [k, v] of Object.entries({ first_name: 'Akoth', last_name: 'Wanyama', email, phone: '+254712345678', consent: 'true', answers: JSON.stringify({ nck_licence: 'yes' }), ...extra })) r.field(k, v);
      return r;
    };
    expect((await form({ consent: 'false' }).attach('cv', PDF, { filename: 'cv.pdf', contentType: 'application/pdf' })).status).toBe(422);
    expect((await form({ answers: '{}' }).attach('cv', PDF, { filename: 'cv.pdf', contentType: 'application/pdf' })).status).toBe(422);
    expect((await form()).status).toBe(422); // no CV
    const ok = await form().attach('cv', PDF, { filename: 'cv.pdf', contentType: 'application/pdf' });
    expect(ok.status).toBe(201);
    expect(ok.body.reference).toMatch(/^APP\//);
    expect((await form().attach('cv', PDF, { filename: 'cv.pdf', contentType: 'application/pdf' })).status).toBe(409);
    const apps = (await api(app).get(`${B}/job-applications`).query({ posting_id: postingId }).set(bearer(rec))).body;
    expect(apps).toHaveLength(1);
    appId = apps[0].id;
    expect(apps[0]).toMatchObject({ candidate_name: 'Akoth Wanyama', stage: 'applied', answers: { nck_licence: 'yes' } });
    const cv = await api(app).get(`${B}/job-applications/${appId}/cv`).set(bearer(rec));
    expect(cv.status).toBe(200);
  });

  it('pipeline: shortlist, interview with a panel, panel feedback', async () => {
    const app = await testApp();
    const rec = await login(app, 'recruiter');
    expect((await api(app).post(`${B}/job-applications/${appId}/stage`).set(bearer(rec)).send({ stage: 'hired' })).status).toBe(422);
    expect((await api(app).post(`${B}/job-applications/${appId}/stage`).set(bearer(rec)).send({ stage: 'shortlisted', rating: 4 })).body.stage).toBe('shortlisted');
    const [panel] = await db(app).query(`SELECT id FROM user_account WHERE username = 'line.manager'`);
    const i = await api(app).post(`${B}/job-applications/${appId}/interviews`).set(bearer(rec)).send({ scheduled_at: new Date(Date.now() - 3_600_000).toISOString(), panel_user_ids: [panel.id], location: 'Board room' });
    expect(i.status).toBe(201);
    const lm = await login(app, 'line.manager');
    const mine = (await api(app).get(`${B}/me/interviews`).set(bearer(lm))).body.find((x: { id: string }) => x.id === i.body.id);
    expect(mine).toMatchObject({ candidate_name: 'Akoth Wanyama', my_feedback: false });
    expect((await api(app).get(`${B}/interviews/${i.body.id}/cv`).set(bearer(lm))).status).toBe(200);
    expect((await api(app).put(`${B}/interviews/${i.body.id}/feedback`).set(bearer(rec)).send({ recommendation: 'yes' })).status).toBe(403);
    expect((await api(app).put(`${B}/interviews/${i.body.id}/feedback`).set(bearer(lm)).send({ recommendation: 'strong_yes', scores: { clinical_knowledge: 5, communication: 4 }, comment: 'Excellent on sepsis scenarios' })).status).toBe(200);
    const d = (await api(app).get(`${B}/job-applications/${appId}`).set(bearer(rec))).body;
    expect(d).toMatchObject({ stage: 'interview', panel_score: 2 });
    expect(d.interviews_detail[0]).toMatchObject({ status: 'completed', feedback: [{ recommendation: 'strong_yes' }] });
  });

  it('offer: approved with a letter; accepted makes an employee with contract, pay and onboarding', async () => {
    const app = await testApp();
    const rec = await login(app, 'recruiter');
    const start = plus(30);
    const o = await api(app).post(`${B}/job-applications/${appId}/offers`).set(bearer(rec)).send({ contract_type: 'permanent', start_date: start, basic: '75000.00', probation_months: 6, notice_days: 30 });
    expect(o.status).toBe(201);
    expect((await api(app).post(`${B}/job-offers/${o.body.id}/response`).set(bearer(rec)).send({ response: 'accepted' })).status).toBe(409);
    await approveAll(o.body.id);
    const letter = await api(app).get(`${B}/job-offers/${o.body.id}/letter`).set(bearer(rec)).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (x: Buffer) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect((letter.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    const acc = await api(app).post(`${B}/job-offers/${o.body.id}/response`).set(bearer(rec)).send({ response: 'accepted' });
    expect(acc.status).toBe(200);
    const empId = acc.body.employee_id;
    const hrm = await login(app, 'hr.manager');
    expect((await api(app).get(`${B}/employees/${empId}`).set(bearer(hrm))).body).toMatchObject({ first_name: 'Akoth', status: 'onboarding', hire_date: start });
    expect((await api(app).get(`${B}/contracts`).query({ employee_id: empId }).set(bearer(hrm))).body[0]).toMatchObject({ contract_type: 'permanent', start_date: start, basic: '75000.00' });
    expect((await api(app).get(`${B}/employees/${empId}/pay`).set(bearer(hrm))).body.salaries[0]).toMatchObject({ basic: '75000.00', effective_from: start });
    expect((await api(app).get(`${B}/checklists`).query({ employee_id: empId }).set(bearer(hrm))).body[0]).toMatchObject({ kind: 'onboarding', status: 'open' });
    const r = (await api(app).get(`${B}/requisitions`).set(bearer(rec))).body.find((x: { id: string }) => x.id === reqId);
    expect(r).toMatchObject({ status: 'filled', hired: 1 });
    expect((await api(app).get(`${B}/careers/jobs/${slug}`)).status).toBe(404);
  });

  it('candidates past their retention period are forgotten', async () => {
    const app = await testApp();
    const [c] = await db(app).query(`INSERT INTO candidate (email, first_name, last_name, consent_at, retain_until) VALUES ($1, 'Old', 'Applicant', now(), current_date - 1) RETURNING id`, [`old.${uniq().toLowerCase()}@example.com`]);
    await app.get(RecruitmentService).sweep();
    const [after] = await db(app).query(`SELECT first_name, email FROM candidate WHERE id = $1`, [c.id]);
    expect(after.first_name).toBe('Removed');
    expect(after.email).toMatch(/^removed-/);
  });
});
