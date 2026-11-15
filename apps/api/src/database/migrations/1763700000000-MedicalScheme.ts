import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Staff medical scheme: schemes and cover categories, dated limit rules and contribution
 * rates by grade and employment type, members (staff and dependants), applications through
 * the approval engine, and an append-only usage ledger with holds and reversals.
 */
export class MedicalScheme1763700000000 implements MigrationInterface {
  name = 'MedicalScheme1763700000000';

  public async up(q: QueryRunner): Promise<void> {
    const base = `
      id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
      created_at timestamptz(3) NOT NULL DEFAULT now(),
      updated_at timestamptz(3) NOT NULL DEFAULT now(),
      created_by uuid,
      updated_by uuid,
      version int NOT NULL DEFAULT 1`;
    const money = 'numeric(14,2)';
    const ZERO = `'00000000-0000-0000-0000-000000000000'::uuid`;

    await q.query(`
      CREATE TABLE medical_scheme (${base},
        code varchar(30) NOT NULL UNIQUE,
        name varchar(200) NOT NULL,
        description varchar(1000),
        year_start_month int NOT NULL DEFAULT 1 CHECK (year_start_month BETWEEN 1 AND 12),
        unused_limit_policy varchar(12) NOT NULL DEFAULT 'reset' CHECK (unused_limit_policy IN ('reset', 'carry_over')),
        carry_over_max_pct numeric(5,2) NOT NULL DEFAULT 100 CHECK (carry_over_max_pct BETWEEN 0 AND 100),
        max_dependants int NOT NULL DEFAULT 5 CHECK (max_dependants >= 0),
        over_limit_action varchar(10) NOT NULL DEFAULT 'approval' CHECK (over_limit_action IN ('block', 'approval')),
        contributions_enabled boolean NOT NULL DEFAULT false,
        status varchar(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive'))
      )`);

    await q.query(`
      CREATE TABLE medical_category (${base},
        scheme_id uuid NOT NULL REFERENCES medical_scheme(id) ON DELETE CASCADE,
        code varchar(30) NOT NULL,
        name varchar(200) NOT NULL,
        sharing varchar(12) NOT NULL DEFAULT 'shared' CHECK (sharing IN ('shared', 'per_person')),
        co_pay_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (co_pay_pct BETWEEN 0 AND 100),
        per_visit_cap ${money} CHECK (per_visit_cap > 0),
        waiting_days int NOT NULL DEFAULT 0 CHECK (waiting_days >= 0),
        principal_and_spouse_only boolean NOT NULL DEFAULT false,
        sort_order int NOT NULL DEFAULT 100,
        status varchar(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
        UNIQUE (scheme_id, code)
      )`);

    await q.query(`
      CREATE TABLE medical_limit_rule (${base},
        scheme_id uuid NOT NULL REFERENCES medical_scheme(id) ON DELETE CASCADE,
        category_id uuid NOT NULL REFERENCES medical_category(id) ON DELETE CASCADE,
        job_grade_id uuid REFERENCES job_grade(id) ON DELETE RESTRICT,
        employment_type varchar(12),
        annual_limit ${money} NOT NULL CHECK (annual_limit >= 0),
        dependant_limit ${money} CHECK (dependant_limit >= 0),
        effective_from date NOT NULL,
        effective_to date,
        CONSTRAINT ck_limit_dates CHECK (effective_to IS NULL OR effective_to >= effective_from),
        CONSTRAINT ex_limit_overlap EXCLUDE USING gist (category_id WITH =, coalesce(job_grade_id, ${ZERO}) WITH =, coalesce(employment_type, '') WITH =, daterange(effective_from, effective_to, '[]') WITH &&)
      )`);

    await q.query(`
      CREATE TABLE medical_contribution_rate (${base},
        scheme_id uuid NOT NULL REFERENCES medical_scheme(id) ON DELETE CASCADE,
        job_grade_id uuid REFERENCES job_grade(id) ON DELETE RESTRICT,
        employment_type varchar(12),
        method varchar(15) NOT NULL CHECK (method IN ('fixed', 'percent_basic')),
        value numeric(14,4) NOT NULL CHECK (value >= 0),
        per_dependant ${money} NOT NULL DEFAULT 0 CHECK (per_dependant >= 0),
        effective_from date NOT NULL,
        effective_to date,
        CONSTRAINT ck_rate_dates CHECK (effective_to IS NULL OR effective_to >= effective_from),
        CONSTRAINT ex_rate_overlap EXCLUDE USING gist (scheme_id WITH =, coalesce(job_grade_id, ${ZERO}) WITH =, coalesce(employment_type, '') WITH =, daterange(effective_from, effective_to, '[]') WITH &&)
      )`);

    await q.query(`
      CREATE TABLE medical_member (${base},
        scheme_id uuid NOT NULL REFERENCES medical_scheme(id) ON DELETE RESTRICT,
        employee_id uuid NOT NULL REFERENCES employee(id) ON DELETE RESTRICT,
        dependant_id uuid REFERENCES employee_dependant(id) ON DELETE RESTRICT,
        principal_member_id uuid REFERENCES medical_member(id) ON DELETE RESTRICT,
        member_number varchar(30) NOT NULL UNIQUE,
        name varchar(300) NOT NULL,
        relationship varchar(12) NOT NULL CHECK (relationship IN ('principal', 'spouse', 'child', 'other')),
        date_of_birth date,
        cover_start date NOT NULL,
        cover_end date,
        status varchar(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
        end_reason varchar(200),
        CONSTRAINT ck_member_principal CHECK ((relationship = 'principal') = (dependant_id IS NULL) AND (relationship = 'principal') = (principal_member_id IS NULL))
      )`);
    await q.query(`CREATE UNIQUE INDEX ux_member_active ON medical_member (scheme_id, employee_id, coalesce(dependant_id, ${ZERO})) WHERE status = 'active'`);
    await q.query(`CREATE INDEX ix_member_employee ON medical_member (employee_id)`);
    await q.query(`CREATE INDEX ix_member_name ON medical_member USING gin (name gin_trgm_ops)`);

    await q.query(`
      CREATE TABLE medical_application (${base},
        number varchar(40) NOT NULL UNIQUE,
        kind varchar(20) NOT NULL CHECK (kind IN ('enrol', 'add_dependant', 'remove_dependant', 'top_up', 'pre_auth', 'over_limit_claim')),
        scheme_id uuid NOT NULL REFERENCES medical_scheme(id) ON DELETE RESTRICT,
        employee_id uuid NOT NULL REFERENCES employee(id) ON DELETE RESTRICT,
        member_id uuid REFERENCES medical_member(id) ON DELETE RESTRICT,
        category_id uuid REFERENCES medical_category(id) ON DELETE RESTRICT,
        amount ${money} CHECK (amount > 0),
        effective_date date,
        details jsonb NOT NULL DEFAULT '{}',
        document_ids uuid[] NOT NULL DEFAULT '{}',
        reason varchar(1000),
        status varchar(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'returned', 'cancelled')),
        decision_comment varchar(1000),
        workflow_instance_id uuid REFERENCES workflow_instance(id) ON DELETE RESTRICT,
        result jsonb
      )`);
    await q.query(`CREATE INDEX ix_med_app_employee ON medical_application (employee_id, created_at DESC)`);

    // Usage is a ledger: claims, reversals, adjustments, top-ups, carry-over, holds and their release.
    await q.query(`
      CREATE TABLE medical_ledger (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        created_by uuid,
        scheme_id uuid NOT NULL REFERENCES medical_scheme(id) ON DELETE RESTRICT,
        category_id uuid NOT NULL REFERENCES medical_category(id) ON DELETE RESTRICT,
        pool_member_id uuid NOT NULL REFERENCES medical_member(id) ON DELETE RESTRICT,
        member_id uuid NOT NULL REFERENCES medical_member(id) ON DELETE RESTRICT,
        scheme_year int NOT NULL,
        entry_type varchar(15) NOT NULL CHECK (entry_type IN ('claim', 'reversal', 'adjustment', 'top_up', 'carry_over', 'hold', 'hold_release')),
        amount ${money} NOT NULL,
        invoice_amount ${money},
        member_share ${money},
        occurred_on date NOT NULL,
        facility varchar(200),
        department varchar(200),
        invoice_ref varchar(100),
        external_ref varchar(200),
        source varchar(10) NOT NULL DEFAULT 'web' CHECK (source IN ('web', 'api', 'system')),
        reverses_id uuid UNIQUE REFERENCES medical_ledger(id) ON DELETE RESTRICT,
        hold_id uuid REFERENCES medical_ledger(id) ON DELETE RESTRICT,
        expires_on date,
        reason varchar(500),
        document_id uuid REFERENCES document(id) ON DELETE RESTRICT,
        application_id uuid REFERENCES medical_application(id) ON DELETE RESTRICT,
        CONSTRAINT ck_ledger_sign CHECK (entry_type = 'adjustment' OR amount > 0),
        CONSTRAINT ck_ledger_reversal CHECK ((entry_type = 'reversal') = (reverses_id IS NOT NULL)),
        CONSTRAINT ck_ledger_release CHECK (entry_type <> 'hold_release' OR hold_id IS NOT NULL),
        CONSTRAINT ck_ledger_hold CHECK (entry_type <> 'hold' OR expires_on IS NOT NULL)
      )`);
    await q.query(`CREATE INDEX ix_ledger_pool ON medical_ledger (pool_member_id, category_id, scheme_year)`);
    await q.query(`CREATE INDEX ix_ledger_member ON medical_ledger (member_id, occurred_on)`);
    await q.query(`CREATE UNIQUE INDEX ux_ledger_release ON medical_ledger (hold_id) WHERE entry_type = 'hold_release'`);
    await q.query(`CREATE UNIQUE INDEX ux_ledger_external ON medical_ledger (source, entry_type, external_ref) WHERE external_ref IS NOT NULL`);
    await q.query(`CREATE UNIQUE INDEX ux_ledger_carry ON medical_ledger (pool_member_id, category_id, scheme_year) WHERE entry_type = 'carry_over'`);
    await q.query(`
      CREATE FUNCTION medical_ledger_append_only() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'the medical ledger is append-only: post a reversal or an adjustment' USING ERRCODE = 'check_violation';
      END $$ LANGUAGE plpgsql`);
    await q.query(`CREATE TRIGGER tr_medical_ledger_append_only BEFORE UPDATE OR DELETE ON medical_ledger FOR EACH ROW EXECUTE FUNCTION medical_ledger_append_only()`);

    await q.query(`
      CREATE TABLE medical_threshold_alert (
        pool_member_id uuid NOT NULL REFERENCES medical_member(id) ON DELETE RESTRICT,
        category_id uuid NOT NULL REFERENCES medical_category(id) ON DELETE RESTRICT,
        scheme_year int NOT NULL,
        threshold int NOT NULL,
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        PRIMARY KEY (pool_member_id, category_id, scheme_year, threshold)
      )`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS medical_threshold_alert CASCADE`);
    await q.query(`DROP TABLE IF EXISTS medical_ledger CASCADE`);
    await q.query(`DROP FUNCTION IF EXISTS medical_ledger_append_only()`);
    for (const t of ['medical_application', 'medical_member', 'medical_contribution_rate', 'medical_limit_rule', 'medical_category', 'medical_scheme']) await q.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
  }
}
