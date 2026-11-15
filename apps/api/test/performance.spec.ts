import { api, bearer, closeApp, db, idOf, login, testApp, uniq } from './helpers';

afterAll(closeApp);

const B = '/api/v1';
const today = () => new Date().toISOString().slice(0, 10);
const plus = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/** Approves every step of a request, each by the first eligible person found. */
async function approveAll(subjectId: string) {
  const app = await testApp();
  const people = ['admin', 'hr.manager', 'head.nursing', 'line.manager', 'finance', 'hr.officer'];
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

describe('performance', () => {
  let cycleId = '';
  let reviewId = '';
  const goals: string[] = [];

  it('HR launches a cycle for the medical ward: one review each, reviewer = line manager', async () => {
    const app = await testApp();
    const hrm = await login(app, 'hr.manager');
    const dept = await idOf(app, 'department', 'code', 'MEDW');
    const bad = await api(app).post(`${B}/performance/cycles`).set(bearer(hrm)).send({ name: 'Backwards', kind: 'annual', period_start: plus(10), period_end: plus(1), goals_due: plus(5), self_review_due: plus(6), manager_review_due: plus(7) });
    expect(bad.status).toBe(422);
    const c = await api(app).post(`${B}/performance/cycles`).set(bearer(hrm)).send({ name: `Ward appraisal ${uniq()}`, kind: 'mid_year', period_start: plus(-180), period_end: plus(5), goals_due: plus(1), self_review_due: plus(30), manager_review_due: plus(40), department_id: dept });
    expect(c.status).toBe(201);
    cycleId = c.body.id;
    expect((await api(app).post(`${B}/performance/cycles/${cycleId}/status`).set(bearer(hrm)).send({ status: 'reviewing' })).status).toBe(409);
    const l = await api(app).post(`${B}/performance/cycles/${cycleId}/status`).set(bearer(hrm)).send({ status: 'goal_setting' });
    expect(l.status).toBe(200);
    expect(l.body.counts.reviews).toBeGreaterThanOrEqual(2);

    const emp = await login(app, 'employee');
    const mine = (await api(app).get(`${B}/me/reviews`).set(bearer(emp))).body.find((r: { cycle_id: string }) => r.cycle_id === cycleId);
    expect(mine).toMatchObject({ status: 'goal_setting', reviewer_name: expect.stringContaining('line.manager') });
    reviewId = mine.id;
    const lm = await login(app, 'line.manager');
    expect((await api(app).get(`${B}/me/team-reviews`).set(bearer(lm))).body.some((r: { id: string }) => r.id === reviewId)).toBe(true);
    // Not in the recruiter's world.
    expect((await api(app).get(`${B}/performance/reviews/${reviewId}`).set(bearer(await login(app, 'recruiter')))).status).toBe(404);
  });

  it('goals: proposed by the employee, agreed by the reviewer only when the weights add up to 100', async () => {
    const app = await testApp();
    const emp = await login(app, 'employee');
    const lm = await login(app, 'line.manager');
    const [ind] = await db(app).query(`SELECT id FROM performance_indicator WHERE code = 'HAND-HYG'`);
    for (const [title, weight, extra] of [['Hand hygiene audits', 60, { indicator_id: ind.id, measure: 'percent', target: '≥ 90%' }], ['Complete documentation', 30, { measure: 'percent', target: '95%' }]] as const) {
      const r = await api(app).post(`${B}/performance/reviews/${reviewId}/goals`).set(bearer(emp)).send({ title, weight, ...extra });
      expect(r.status).toBe(201);
    }
    expect((await api(app).post(`${B}/performance/reviews/${reviewId}/agree-goals`).set(bearer(emp))).status).toBe(403);
    const short = await api(app).post(`${B}/performance/reviews/${reviewId}/agree-goals`).set(bearer(lm));
    expect(short.status).toBe(422);
    expect(short.body.detail).toMatch(/90/);
    await api(app).post(`${B}/performance/reviews/${reviewId}/goals`).set(bearer(lm)).send({ title: 'Mentor a student nurse', weight: 10, measure: 'yes_no' });
    const ok = await api(app).post(`${B}/performance/reviews/${reviewId}/agree-goals`).set(bearer(lm));
    expect(ok.status).toBe(200);
    expect(ok.body.goal_list.map((g: { status: string }) => g.status)).toEqual(['agreed', 'agreed', 'agreed']);
    expect(ok.body.goal_list[0].indicator_name).toBe('Hand hygiene compliance');
    goals.push(...ok.body.goal_list.map((g: { id: string }) => g.id));
    const p = await api(app).post(`${B}/performance/goals/${goals[0]}/progress`).set(bearer(emp)).send({ progress: 70, note: 'Audits at 92% for Q3' });
    expect(p.body.goal_list[0]).toMatchObject({ progress: 70 });
  });

  it('self-review, then the manager assessment, which goes for approval and calibration', async () => {
    const app = await testApp();
    const hrm = await login(app, 'hr.manager');
    const emp = await login(app, 'employee');
    const lm = await login(app, 'line.manager');
    expect((await api(app).post(`${B}/performance/cycles/${cycleId}/status`).set(bearer(hrm)).send({ status: 'reviewing' })).status).toBe(200);
    // Goals are locked once reviewing starts.
    expect((await api(app).post(`${B}/performance/reviews/${reviewId}/goals`).set(bearer(emp)).send({ title: 'Late goal', weight: 10, measure: 'rating' })).status).toBe(409);
    // The manager waits for the self-review (its due date has not passed).
    expect((await api(app).put(`${B}/performance/reviews/${reviewId}/manager`).set(bearer(lm)).send({ comment: 'x' })).status).toBe(409);

    const missing = await api(app).put(`${B}/performance/reviews/${reviewId}/self`).set(bearer(emp)).send({ scores: [{ goal_id: goals[0], score: 4 }], submit: true });
    expect(missing.status).toBe(422);
    const self = await api(app).put(`${B}/performance/reviews/${reviewId}/self`).set(bearer(emp)).send({ scores: [{ goal_id: goals[0], score: 4 }, { goal_id: goals[1], score: 5 }, { goal_id: goals[2], score: 3 }], comment: 'A good year on the ward', submit: true });
    expect(self.status).toBe(200);
    // 4×60 + 5×30 + 3×10 = 420 → 4.20
    expect(self.body).toMatchObject({ status: 'manager_review', self_rating: '4.20' });

    const draft = await api(app).put(`${B}/performance/reviews/${reviewId}/manager`).set(bearer(lm)).send({ scores: [{ goal_id: goals[0], score: 4, comment: 'Consistent' }], comment: 'Strong year' });
    expect(draft.body).toMatchObject({ status: 'manager_review', manager_rating: null });
    expect((await api(app).get(`${B}/performance/reviews/${reviewId}`).set(bearer(emp))).body.goal_list[0].manager_score).toBeNull();
    const sub = await api(app).put(`${B}/performance/reviews/${reviewId}/manager`).set(bearer(lm)).send({ scores: [{ goal_id: goals[0], score: 4 }, { goal_id: goals[1], score: 3 }, { goal_id: goals[2], score: 3 }], comment: 'Strong year; documentation can improve', strengths: 'Infection control', development_needs: 'Charting', submit: true });
    expect(sub.status).toBe(200);
    // 4×60 + 3×30 + 3×10 = 360 → 3.60
    expect(sub.body).toMatchObject({ status: 'approval', manager_rating: '3.60' });

    expect((await api(app).put(`${B}/performance/reviews/${reviewId}/calibration`).set(bearer(lm)).send({ final_rating: 3.4, comment: 'Moderated' })).status).toBe(403);
    const cal = await api(app).put(`${B}/performance/reviews/${reviewId}/calibration`).set(bearer(hrm)).send({ final_rating: 3.4, comment: 'Moderated across the nursing directorate' });
    expect(cal.body).toMatchObject({ final_rating: '3.40', band: 'Meets expectations' });
    // The employee sees nothing of the manager’s assessment yet.
    expect((await api(app).get(`${B}/performance/reviews/${reviewId}`).set(bearer(emp))).body).toMatchObject({ manager_rating: null, final_rating: null, manager_comment: null });

    // Step 1 skips the line manager (the requester) and goes to their manager; step 2 is HR.
    const inbox = (await api(app).get(`${B}/workflow/inbox`).set(bearer(await login(app, 'head.nursing')))).body;
    expect(inbox.some((t: { subject_id: string }) => t.subject_id === reviewId)).toBe(true);
    await approveAll(reviewId);
    const r = (await api(app).get(`${B}/performance/reviews/${reviewId}`).set(bearer(emp))).body;
    expect(r).toMatchObject({ status: 'acknowledgement', final_rating: '3.40', manager_rating: '3.60', strengths: 'Infection control', can: { acknowledge: true } });
  });

  it('the employee acknowledges (disagreeing needs a reason); the event and the report follow', async () => {
    const app = await testApp();
    const emp = await login(app, 'employee');
    expect((await api(app).post(`${B}/performance/reviews/${reviewId}/acknowledge`).set(bearer(emp)).send({ agree: false })).status).toBe(422);
    const ack = await api(app).post(`${B}/performance/reviews/${reviewId}/acknowledge`).set(bearer(emp)).send({ agree: false, comment: 'I led the ward audit; documentation was above target' });
    expect(ack.body).toMatchObject({ status: 'completed', employee_agrees: false });
    const [evt] = await db(app).query(`SELECT data FROM outbox_event WHERE type = 'hr.performance.review_completed.v1' AND data->>'id' = $1`, [reviewId]);
    expect(evt.data).toMatchObject({ final_rating: '3.40', band: 'Meets expectations', employee_agrees: false });
    const [flag] = await db(app).query(`SELECT count(*)::int AS n FROM notification WHERE title LIKE 'Appraisal needs attention%' AND created_at > now() - interval '1 minute'`);
    expect(flag.n).toBeGreaterThan(0);
    const rep = (await api(app).get(`${B}/performance/cycles/${cycleId}/report`).set(bearer(await login(app, 'hr.manager')))).body;
    expect(rep.bands.find((b: { band: string }) => b.band === 'Meets expectations').count).toBe(1);
    expect(today()).toBeTruthy();
  });
});
