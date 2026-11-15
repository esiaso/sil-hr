import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Slice 7: requisitions, postings, candidates and applications, interviews with panel
 * feedback, assessments and offers; the public careers site reads published postings.
 */
export class Recruitment1763900000000 implements MigrationInterface {
  name = 'Recruitment1763900000000';

  public async up(q: QueryRunner): Promise<void> {
    const base = `
      id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
      created_at timestamptz(3) NOT NULL DEFAULT now(),
      updated_at timestamptz(3) NOT NULL DEFAULT now(),
      created_by uuid,
      updated_by uuid,
      version int NOT NULL DEFAULT 1`;
    const money = 'numeric(14,2)';

    await q.query(`
      CREATE TABLE job_requisition (${base},
        number varchar(40) NOT NULL UNIQUE,
        position_id uuid NOT NULL REFERENCES position(id) ON DELETE RESTRICT,
        headcount int NOT NULL DEFAULT 1 CHECK (headcount BETWEEN 1 AND 100),
        employment_type varchar(12) NOT NULL,
        reason varchar(12) NOT NULL CHECK (reason IN ('new', 'replacement', 'temporary')),
        replaces_employee_id uuid REFERENCES employee(id) ON DELETE RESTRICT,
        salary_min ${money},
        salary_max ${money},
        needed_by date,
        justification varchar(4000) NOT NULL,
        status varchar(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'returned', 'filled', 'cancelled')),
        requested_by uuid,
        decision_comment varchar(1000),
        workflow_instance_id uuid REFERENCES workflow_instance(id) ON DELETE RESTRICT,
        hired int NOT NULL DEFAULT 0,
        CONSTRAINT ck_req_salary CHECK (salary_min IS NULL OR salary_max IS NULL OR salary_max >= salary_min)
      )`);

    await q.query(`
      CREATE TABLE job_posting (${base},
        requisition_id uuid NOT NULL REFERENCES job_requisition(id) ON DELETE RESTRICT,
        slug varchar(120) NOT NULL UNIQUE,
        title varchar(200) NOT NULL,
        summary varchar(500),
        description text NOT NULL,
        requirements text,
        location varchar(200),
        employment_type varchar(12) NOT NULL,
        show_salary boolean NOT NULL DEFAULT false,
        closing_date date NOT NULL,
        internal_only boolean NOT NULL DEFAULT false,
        questions jsonb NOT NULL DEFAULT '[]',
        status varchar(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'closed')),
        published_at timestamptz(3)
      )`);
    await q.query(`CREATE INDEX ix_posting_public ON job_posting (status, closing_date)`);

    await q.query(`
      CREATE TABLE candidate (${base},
        email varchar(200) NOT NULL UNIQUE,
        first_name varchar(100) NOT NULL,
        last_name varchar(100) NOT NULL,
        phone varchar(30),
        location varchar(200),
        employee_id uuid REFERENCES employee(id) ON DELETE SET NULL,
        consent_at timestamptz(3) NOT NULL,
        retain_until date NOT NULL
      )`);

    await q.query(`
      CREATE TABLE job_application (${base},
        number varchar(40) NOT NULL UNIQUE,
        posting_id uuid NOT NULL REFERENCES job_posting(id) ON DELETE RESTRICT,
        candidate_id uuid NOT NULL REFERENCES candidate(id) ON DELETE RESTRICT,
        source varchar(12) NOT NULL DEFAULT 'careers' CHECK (source IN ('careers', 'internal', 'referral', 'agency', 'other')),
        stage varchar(12) NOT NULL DEFAULT 'applied' CHECK (stage IN ('applied', 'screening', 'shortlisted', 'interview', 'assessment', 'offer', 'hired', 'rejected', 'withdrawn')),
        cv_document_id uuid REFERENCES document(id) ON DELETE RESTRICT,
        cover_note varchar(4000),
        answers jsonb NOT NULL DEFAULT '{}',
        rating int CHECK (rating BETWEEN 1 AND 5),
        rejection_reason varchar(500),
        hired_employee_id uuid REFERENCES employee(id) ON DELETE RESTRICT,
        UNIQUE (posting_id, candidate_id)
      )`);
    await q.query(`CREATE INDEX ix_application_posting ON job_application (posting_id, stage)`);
    await q.query(`
      CREATE TABLE application_event (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
        application_id uuid NOT NULL REFERENCES job_application(id) ON DELETE CASCADE,
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        created_by uuid,
        actor_name varchar(200),
        from_stage varchar(12),
        to_stage varchar(12),
        note varchar(2000)
      )`);

    await q.query(`
      CREATE TABLE interview (${base},
        application_id uuid NOT NULL REFERENCES job_application(id) ON DELETE CASCADE,
        scheduled_at timestamptz(3) NOT NULL,
        duration_minutes int NOT NULL DEFAULT 45,
        location varchar(300),
        kind varchar(12) NOT NULL DEFAULT 'panel' CHECK (kind IN ('phone', 'panel', 'practical', 'online')),
        status varchar(12) NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled', 'no_show')),
        panel_user_ids uuid[] NOT NULL DEFAULT '{}'
      )`);
    await q.query(`
      CREATE TABLE interview_feedback (${base},
        interview_id uuid NOT NULL REFERENCES interview(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
        scores jsonb NOT NULL DEFAULT '{}',
        recommendation varchar(12) NOT NULL CHECK (recommendation IN ('strong_yes', 'yes', 'no', 'strong_no')),
        comment varchar(4000),
        UNIQUE (interview_id, user_id)
      )`);
    await q.query(`
      CREATE TABLE assessment (${base},
        application_id uuid NOT NULL REFERENCES job_application(id) ON DELETE CASCADE,
        name varchar(200) NOT NULL,
        score numeric(6,2) NOT NULL,
        max_score numeric(6,2) NOT NULL CHECK (max_score > 0),
        taken_on date NOT NULL,
        notes varchar(2000)
      )`);

    await q.query(`
      CREATE TABLE job_offer (${base},
        number varchar(40) NOT NULL UNIQUE,
        application_id uuid NOT NULL REFERENCES job_application(id) ON DELETE RESTRICT,
        position_id uuid NOT NULL REFERENCES position(id) ON DELETE RESTRICT,
        contract_type varchar(15) NOT NULL,
        start_date date NOT NULL,
        end_date date,
        basic ${money} NOT NULL CHECK (basic > 0),
        probation_months int,
        notice_days int NOT NULL DEFAULT 30,
        conditions varchar(4000),
        status varchar(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'returned', 'accepted', 'declined', 'withdrawn')),
        decision_comment varchar(1000),
        workflow_instance_id uuid REFERENCES workflow_instance(id) ON DELETE RESTRICT,
        letter_document_id uuid REFERENCES document(id) ON DELETE RESTRICT,
        responded_at timestamptz(3),
        employee_id uuid REFERENCES employee(id) ON DELETE RESTRICT
      )`);
    await q.query(`CREATE UNIQUE INDEX ux_offer_live ON job_offer (application_id) WHERE status IN ('pending', 'approved', 'accepted')`);
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const t of ['job_offer', 'assessment', 'interview_feedback', 'interview', 'application_event', 'job_application', 'candidate', 'job_posting', 'job_requisition']) await q.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
  }
}
