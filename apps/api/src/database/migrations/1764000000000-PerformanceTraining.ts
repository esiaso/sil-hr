import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Slice 8: the indicator (KPI) library, review cycles, appraisals with weighted goals;
 * training programmes, sessions, enrolments with attendance and scores, and a CPD ledger
 * with yearly requirements per licensing body.
 */
export class PerformanceTraining1764000000000 implements MigrationInterface {
  name = 'PerformanceTraining1764000000000';

  public async up(q: QueryRunner): Promise<void> {
    const base = `
      id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
      created_at timestamptz(3) NOT NULL DEFAULT now(),
      updated_at timestamptz(3) NOT NULL DEFAULT now(),
      created_by uuid,
      updated_by uuid,
      version int NOT NULL DEFAULT 1`;
    const rating = 'numeric(3,2) CHECK (%s BETWEEN 1 AND 5)';
    const r = (c: string) => `${c} ${rating.replace('%s', c)}`;

    // ------------------------------------------------------------------ performance
    await q.query(`
      CREATE TABLE performance_indicator (${base},
        code varchar(30) NOT NULL UNIQUE,
        name varchar(200) NOT NULL,
        description varchar(2000),
        category varchar(20) NOT NULL CHECK (category IN ('clinical', 'quality', 'patient_experience', 'operational', 'behaviour', 'learning')),
        measure varchar(10) NOT NULL CHECK (measure IN ('rating', 'percent', 'number', 'yes_no')),
        default_target varchar(100),
        department_id uuid REFERENCES department(id) ON DELETE RESTRICT,
        position_id uuid REFERENCES position(id) ON DELETE RESTRICT,
        status varchar(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive'))
      )`);
    await q.query(`
      CREATE TABLE review_cycle (${base},
        name varchar(120) NOT NULL,
        kind varchar(10) NOT NULL CHECK (kind IN ('annual', 'mid_year', 'quarterly', 'probation')),
        period_start date NOT NULL,
        period_end date NOT NULL,
        goals_due date NOT NULL,
        self_review_due date NOT NULL,
        manager_review_due date NOT NULL,
        department_id uuid REFERENCES department(id) ON DELETE RESTRICT,
        status varchar(12) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'goal_setting', 'reviewing', 'closed')),
        launched_at timestamptz(3),
        CONSTRAINT ck_cycle_period CHECK (period_end > period_start)
      )`);
    await q.query(`
      CREATE TABLE performance_review (${base},
        cycle_id uuid NOT NULL REFERENCES review_cycle(id) ON DELETE RESTRICT,
        employee_id uuid NOT NULL REFERENCES employee(id) ON DELETE RESTRICT,
        reviewer_user_id uuid REFERENCES user_account(id) ON DELETE SET NULL,
        status varchar(16) NOT NULL DEFAULT 'goal_setting' CHECK (status IN ('goal_setting', 'self_review', 'manager_review', 'approval', 'acknowledgement', 'completed')),
        ${r('self_rating')},
        self_comment varchar(4000),
        self_submitted_at timestamptz(3),
        ${r('manager_rating')},
        manager_comment varchar(4000),
        strengths varchar(4000),
        development_needs varchar(4000),
        manager_submitted_at timestamptz(3),
        ${r('final_rating')},
        calibration_comment varchar(2000),
        employee_agrees boolean,
        employee_comment varchar(2000),
        acknowledged_at timestamptz(3),
        workflow_instance_id uuid REFERENCES workflow_instance(id) ON DELETE RESTRICT,
        UNIQUE (cycle_id, employee_id)
      )`);
    await q.query(`CREATE INDEX ix_review_reviewer ON performance_review (reviewer_user_id, status)`);
    await q.query(`CREATE INDEX ix_review_employee ON performance_review (employee_id)`);
    await q.query(`
      CREATE TABLE performance_goal (${base},
        review_id uuid NOT NULL REFERENCES performance_review(id) ON DELETE CASCADE,
        indicator_id uuid REFERENCES performance_indicator(id) ON DELETE RESTRICT,
        title varchar(300) NOT NULL,
        description varchar(2000),
        measure varchar(10) NOT NULL CHECK (measure IN ('rating', 'percent', 'number', 'yes_no')),
        target varchar(100),
        weight int NOT NULL CHECK (weight BETWEEN 5 AND 100),
        status varchar(10) NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'agreed', 'dropped')),
        progress int NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
        progress_note varchar(1000),
        self_score int CHECK (self_score BETWEEN 1 AND 5),
        self_comment varchar(2000),
        manager_score int CHECK (manager_score BETWEEN 1 AND 5),
        manager_comment varchar(2000)
      )`);
    await q.query(`CREATE INDEX ix_goal_review ON performance_goal (review_id)`);

    // ------------------------------------------------------------------ training
    await q.query(`
      CREATE TABLE training_programme (${base},
        code varchar(30) NOT NULL UNIQUE,
        title varchar(200) NOT NULL,
        description varchar(4000),
        category varchar(12) NOT NULL CHECK (category IN ('clinical', 'mandatory', 'compliance', 'induction', 'leadership', 'technical', 'soft_skills')),
        delivery varchar(12) NOT NULL CHECK (delivery IN ('classroom', 'online', 'on_the_job', 'external', 'conference')),
        provider varchar(200),
        duration_hours numeric(6,2) NOT NULL DEFAULT 0 CHECK (duration_hours >= 0),
        cpd_points numeric(4,1) NOT NULL DEFAULT 0 CHECK (cpd_points >= 0),
        cpd_bodies varchar(20)[] NOT NULL DEFAULT '{}',
        mandatory_for varchar(10) NOT NULL DEFAULT 'none' CHECK (mandatory_for IN ('none', 'all', 'clinical')),
        refresh_months int CHECK (refresh_months BETWEEN 1 AND 120),
        pass_mark int CHECK (pass_mark BETWEEN 1 AND 100),
        status varchar(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive'))
      )`);
    await q.query(`
      CREATE TABLE training_session (${base},
        number varchar(40) NOT NULL UNIQUE,
        programme_id uuid NOT NULL REFERENCES training_programme(id) ON DELETE RESTRICT,
        starts_at timestamptz(3) NOT NULL,
        ends_at timestamptz(3) NOT NULL,
        venue varchar(200),
        trainer varchar(200),
        capacity int CHECK (capacity > 0),
        cost_per_person numeric(14,2) CHECK (cost_per_person >= 0),
        open_for_requests boolean NOT NULL DEFAULT true,
        status varchar(10) NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled')),
        CONSTRAINT ck_session_time CHECK (ends_at > starts_at)
      )`);
    await q.query(`CREATE INDEX ix_session_start ON training_session (starts_at)`);
    await q.query(`
      CREATE TABLE training_enrolment (${base},
        session_id uuid NOT NULL REFERENCES training_session(id) ON DELETE RESTRICT,
        employee_id uuid NOT NULL REFERENCES employee(id) ON DELETE RESTRICT,
        status varchar(10) NOT NULL CHECK (status IN ('requested', 'enrolled', 'attended', 'absent', 'withdrawn', 'declined')),
        reason varchar(1000),
        score int CHECK (score BETWEEN 0 AND 100),
        passed boolean,
        cpd_points numeric(4,1),
        completed_on date,
        feedback_rating int CHECK (feedback_rating BETWEEN 1 AND 5),
        feedback_comment varchar(2000),
        decision_comment varchar(1000),
        workflow_instance_id uuid REFERENCES workflow_instance(id) ON DELETE RESTRICT,
        UNIQUE (session_id, employee_id)
      )`);
    await q.query(`CREATE INDEX ix_enrolment_employee ON training_enrolment (employee_id, status)`);

    await q.query(`
      CREATE TABLE cpd_requirement (${base},
        licensing_body varchar(20) NOT NULL UNIQUE,
        points_per_year numeric(4,1) NOT NULL CHECK (points_per_year >= 0),
        description varchar(300)
      )`);
    await q.query(`
      CREATE TABLE cpd_entry (${base},
        employee_id uuid NOT NULL REFERENCES employee(id) ON DELETE RESTRICT,
        source varchar(10) NOT NULL CHECK (source IN ('training', 'external')),
        enrolment_id uuid UNIQUE REFERENCES training_enrolment(id) ON DELETE RESTRICT,
        title varchar(300) NOT NULL,
        provider varchar(200),
        activity_date date NOT NULL,
        points numeric(4,1) NOT NULL CHECK (points > 0),
        licensing_body varchar(20),
        evidence_document_id uuid REFERENCES document(id) ON DELETE RESTRICT,
        status varchar(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected')),
        decision_comment varchar(1000),
        verified_by uuid,
        verified_at timestamptz(3),
        CONSTRAINT ck_cpd_source CHECK ((source = 'training') = (enrolment_id IS NOT NULL))
      )`);
    await q.query(`CREATE INDEX ix_cpd_employee ON cpd_entry (employee_id, activity_date)`);
    // The licence expiry a CPD-shortfall reminder was last sent for (sent once per expiry).
    await q.query(`ALTER TABLE professional_licence ADD COLUMN cpd_notified_for date`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE professional_licence DROP COLUMN IF EXISTS cpd_notified_for`);
    for (const t of ['cpd_entry', 'cpd_requirement', 'training_enrolment', 'training_session', 'training_programme', 'performance_goal', 'performance_review', 'review_cycle', 'performance_indicator']) await q.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
  }
}
