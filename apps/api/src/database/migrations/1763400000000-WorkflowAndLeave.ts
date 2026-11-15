import { MigrationInterface, QueryRunner } from 'typeorm';

/** Slice 3: the generic approval engine, and leave on top of it. */
export class WorkflowAndLeave1763400000000 implements MigrationInterface {
  name = 'WorkflowAndLeave1763400000000';

  public async up(q: QueryRunner): Promise<void> {
    const base = `
      id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
      created_at timestamptz(3) NOT NULL DEFAULT now(),
      updated_at timestamptz(3) NOT NULL DEFAULT now(),
      created_by uuid,
      updated_by uuid,
      version int NOT NULL DEFAULT 1`;

    // ------------------------------------------------------------------ workflow
    await q.query(`
      CREATE TABLE workflow_definition (${base},
        code varchar(40) NOT NULL UNIQUE,
        name varchar(200) NOT NULL,
        request_type varchar(40) NOT NULL,
        description varchar(500),
        conditions jsonb NOT NULL DEFAULT '{}',
        priority int NOT NULL DEFAULT 100,
        is_active boolean NOT NULL DEFAULT true
      )`);
    await q.query(`CREATE INDEX ix_workflow_definition_type ON workflow_definition (request_type) WHERE is_active`);
    await q.query(`
      CREATE TABLE workflow_step (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
        definition_id uuid NOT NULL REFERENCES workflow_definition(id) ON DELETE CASCADE,
        step_no int NOT NULL CHECK (step_no >= 1),
        name varchar(100) NOT NULL,
        approver_rule varchar(20) NOT NULL CHECK (approver_rule IN ('line_manager', 'manager_level', 'department_head', 'role', 'user')),
        level int,
        role_id uuid REFERENCES role(id) ON DELETE RESTRICT,
        user_id uuid REFERENCES user_account(id) ON DELETE RESTRICT,
        min_value numeric(10,2),
        escalate_after_hours int,
        escalate_to varchar(20) CHECK (escalate_to IN ('next_manager', 'role')),
        escalate_role_id uuid REFERENCES role(id) ON DELETE RESTRICT,
        CONSTRAINT ux_workflow_step UNIQUE (definition_id, step_no),
        CONSTRAINT ck_step_role CHECK (approver_rule <> 'role' OR role_id IS NOT NULL),
        CONSTRAINT ck_step_user CHECK (approver_rule <> 'user' OR user_id IS NOT NULL)
      )`);
    await q.query(`
      CREATE TABLE workflow_instance (${base},
        definition_id uuid NOT NULL REFERENCES workflow_definition(id) ON DELETE RESTRICT,
        definition_code varchar(40) NOT NULL,
        request_type varchar(40) NOT NULL,
        subject_id uuid NOT NULL,
        subject_employee_id uuid REFERENCES employee(id) ON DELETE RESTRICT,
        requester_user_id uuid REFERENCES user_account(id) ON DELETE RESTRICT,
        status varchar(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'returned', 'cancelled')),
        current_step_no int,
        summary varchar(300) NOT NULL,
        value numeric(10,2),
        context jsonb NOT NULL DEFAULT '{}',
        completed_at timestamptz(3)
      )`);
    await q.query(`CREATE INDEX ix_workflow_instance_subject ON workflow_instance (request_type, subject_id)`);
    await q.query(`CREATE UNIQUE INDEX ux_workflow_instance_open ON workflow_instance (request_type, subject_id) WHERE status = 'pending'`);
    await q.query(`
      CREATE TABLE workflow_task (${base},
        instance_id uuid NOT NULL REFERENCES workflow_instance(id) ON DELETE CASCADE,
        step_no int NOT NULL,
        step_name varchar(100) NOT NULL,
        assignee_user_id uuid REFERENCES user_account(id) ON DELETE RESTRICT,
        -- A pool: any holder of this role may act (assignee_user_id is then null).
        candidate_role_id uuid REFERENCES role(id) ON DELETE RESTRICT,
        on_behalf_of_user_id uuid REFERENCES user_account(id) ON DELETE RESTRICT,
        status varchar(12) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'rejected', 'returned', 'escalated', 'skipped', 'cancelled')),
        due_at timestamptz(3),
        acted_at timestamptz(3),
        acted_by uuid,
        comment varchar(1000)
      )`);
    await q.query(`CREATE INDEX ix_workflow_task_inbox ON workflow_task (assignee_user_id) WHERE status = 'open'`);
    await q.query(`CREATE INDEX ix_workflow_task_due ON workflow_task (due_at) WHERE status = 'open'`);
    await q.query(`CREATE INDEX ix_workflow_task_instance ON workflow_task (instance_id, step_no)`);
    await q.query(`
      CREATE TABLE workflow_delegation (${base},
        from_user_id uuid NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
        to_user_id uuid NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
        starts_on date NOT NULL,
        ends_on date NOT NULL,
        request_types text[] NOT NULL DEFAULT '{}',
        reason varchar(300),
        CONSTRAINT ck_delegation_dates CHECK (ends_on >= starts_on),
        CONSTRAINT ck_delegation_self CHECK (from_user_id <> to_user_id)
      )`);
    await q.query(`CREATE INDEX ix_delegation_from ON workflow_delegation (from_user_id, starts_on, ends_on)`);

    // ------------------------------------------------------------------ leave setup
    await q.query(`
      CREATE TABLE leave_type (${base},
        code varchar(30) NOT NULL UNIQUE,
        name varchar(200) NOT NULL,
        description varchar(500),
        is_paid boolean NOT NULL DEFAULT true,
        pay_rate numeric(3,2) NOT NULL DEFAULT 1 CHECK (pay_rate BETWEEN 0 AND 1),
        counting varchar(14) NOT NULL DEFAULT 'working_days' CHECK (counting IN ('working_days', 'calendar_days')),
        accrual varchar(8) NOT NULL DEFAULT 'annual' CHECK (accrual IN ('monthly', 'annual', 'none')),
        default_entitlement_days numeric(5,1) NOT NULL DEFAULT 0 CHECK (default_entitlement_days >= 0),
        allow_half_day boolean NOT NULL DEFAULT true,
        allow_negative_balance boolean NOT NULL DEFAULT false,
        gender varchar(6) CHECK (gender IN ('female', 'male')),
        min_service_months int NOT NULL DEFAULT 0,
        min_notice_days int NOT NULL DEFAULT 0,
        max_consecutive_days numeric(5,1),
        requires_document_over_days numeric(5,1),
        carry_forward_max_days numeric(5,1) NOT NULL DEFAULT 0,
        carry_forward_expiry_months int,
        encashable boolean NOT NULL DEFAULT false,
        colour varchar(7),
        status varchar(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive'))
      )`);
    await q.query(`
      CREATE TABLE leave_policy (${base},
        leave_type_id uuid NOT NULL REFERENCES leave_type(id) ON DELETE RESTRICT,
        job_grade_id uuid REFERENCES job_grade(id) ON DELETE RESTRICT,
        employment_type varchar(12),
        entitlement_days numeric(5,1) NOT NULL CHECK (entitlement_days >= 0),
        effective_from date NOT NULL,
        effective_to date,
        CONSTRAINT ck_leave_policy_dates CHECK (effective_to IS NULL OR effective_to >= effective_from),
        CONSTRAINT ex_leave_policy_overlap EXCLUDE USING gist (
          leave_type_id WITH =,
          (coalesce(job_grade_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
          (coalesce(employment_type, '')) WITH =,
          daterange(effective_from, effective_to, '[]') WITH &&)
      )`);
    await q.query(`
      CREATE TABLE public_holiday (${base},
        date date NOT NULL,
        name varchar(200) NOT NULL,
        branch_id uuid REFERENCES branch(id) ON DELETE CASCADE
      )`);
    await q.query(`CREATE UNIQUE INDEX ux_public_holiday ON public_holiday (date, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid))`);

    // ------------------------------------------------------------------ requests and the ledger
    await q.query(`
      CREATE TABLE leave_request (${base},
        number varchar(40) NOT NULL UNIQUE,
        employee_id uuid NOT NULL REFERENCES employee(id) ON DELETE RESTRICT,
        leave_type_id uuid NOT NULL REFERENCES leave_type(id) ON DELETE RESTRICT,
        start_date date NOT NULL,
        end_date date NOT NULL,
        start_half_day boolean NOT NULL DEFAULT false,
        end_half_day boolean NOT NULL DEFAULT false,
        days numeric(5,1) NOT NULL CHECK (days > 0),
        leave_year int NOT NULL,
        reason varchar(1000),
        status varchar(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'returned', 'approved', 'rejected', 'cancelled')),
        document_id uuid REFERENCES document(id) ON DELETE RESTRICT,
        workflow_instance_id uuid REFERENCES workflow_instance(id) ON DELETE RESTRICT,
        submitted_at timestamptz(3),
        decided_at timestamptz(3),
        decision_comment varchar(1000),
        CONSTRAINT ck_leave_dates CHECK (end_date >= start_date)
      )`);
    await q.query(`CREATE INDEX ix_leave_request_employee ON leave_request (employee_id, start_date)`);
    await q.query(`CREATE INDEX ix_leave_request_status ON leave_request (status)`);
    // One person cannot hold overlapping pending or approved leave.
    await q.query(`ALTER TABLE leave_request ADD CONSTRAINT ex_leave_overlap EXCLUDE USING gist (employee_id WITH =, daterange(start_date, end_date, '[]') WITH &&) WHERE (status IN ('pending', 'approved'))`);

    // Append-only: the balance is the sum, never an editable number.
    await q.query(`
      CREATE TABLE leave_ledger (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
        employee_id uuid NOT NULL REFERENCES employee(id) ON DELETE RESTRICT,
        leave_type_id uuid NOT NULL REFERENCES leave_type(id) ON DELETE RESTRICT,
        leave_year int NOT NULL,
        entry_type varchar(14) NOT NULL CHECK (entry_type IN ('accrual', 'carry_forward', 'adjustment', 'reserved', 'release', 'taken', 'expiry', 'encashment')),
        days numeric(6,2) NOT NULL,
        effective_date date NOT NULL,
        leave_request_id uuid REFERENCES leave_request(id) ON DELETE RESTRICT,
        -- Makes scheduled entries idempotent, e.g. accrual:2026-03
        period_key varchar(40),
        note varchar(300),
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        created_by uuid
      )`);
    await q.query(`CREATE INDEX ix_leave_ledger_balance ON leave_ledger (employee_id, leave_type_id, leave_year)`);
    await q.query(`CREATE UNIQUE INDEX ux_leave_ledger_period ON leave_ledger (employee_id, leave_type_id, leave_year, period_key) WHERE period_key IS NOT NULL`);
    await q.query(`
      CREATE FUNCTION leave_ledger_immutable() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'leave_ledger is append-only (% not allowed); post a correcting entry', TG_OP USING ERRCODE = 'insufficient_privilege';
      END
      $$ LANGUAGE plpgsql`);
    await q.query(`CREATE TRIGGER leave_ledger_no_update_delete BEFORE UPDATE OR DELETE ON leave_ledger FOR EACH ROW EXECUTE FUNCTION leave_ledger_immutable()`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS leave_ledger CASCADE`);
    await q.query(`DROP FUNCTION IF EXISTS leave_ledger_immutable()`);
    for (const t of ['leave_request', 'public_holiday', 'leave_policy', 'leave_type', 'workflow_delegation', 'workflow_task', 'workflow_instance', 'workflow_step', 'workflow_definition']) {
      await q.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
    }
  }
}
