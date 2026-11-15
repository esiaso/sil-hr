import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Slice 6: contracts, lifecycle requests (promotion, transfer, confirmation, renewal,
 * resignation, termination, final dues) through the approval engine, onboarding and
 * offboarding checklists, exit clearance, employee relations and letter templates.
 */
export class Lifecycle1763800000000 implements MigrationInterface {
  name = 'Lifecycle1763800000000';

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
      CREATE TABLE employee_contract (${base},
        number varchar(40) NOT NULL UNIQUE,
        employee_id uuid NOT NULL REFERENCES employee(id) ON DELETE RESTRICT,
        contract_type varchar(15) NOT NULL CHECK (contract_type IN ('permanent', 'fixed_term', 'probation', 'locum', 'internship', 'casual')),
        position_id uuid REFERENCES position(id) ON DELETE RESTRICT,
        start_date date NOT NULL,
        end_date date,
        probation_months int CHECK (probation_months BETWEEN 0 AND 12),
        notice_days int NOT NULL DEFAULT 30 CHECK (notice_days >= 0),
        basic ${money},
        terms varchar(4000),
        document_id uuid REFERENCES document(id) ON DELETE RESTRICT,
        status varchar(12) NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'ended', 'renewed', 'terminated')),
        renewed_from_id uuid REFERENCES employee_contract(id) ON DELETE RESTRICT,
        reminded_at timestamptz(3),
        CONSTRAINT ck_contract_dates CHECK (end_date IS NULL OR end_date >= start_date)
      )`);
    await q.query(`CREATE INDEX ix_contract_employee ON employee_contract (employee_id, start_date DESC)`);
    await q.query(`CREATE INDEX ix_contract_end ON employee_contract (end_date) WHERE status = 'active'`);

    await q.query(`
      CREATE TABLE lifecycle_request (${base},
        number varchar(40) NOT NULL UNIQUE,
        kind varchar(20) NOT NULL CHECK (kind IN ('promotion', 'transfer', 'confirmation', 'contract_renewal', 'resignation', 'termination', 'final_dues')),
        employee_id uuid NOT NULL REFERENCES employee(id) ON DELETE RESTRICT,
        effective_date date NOT NULL,
        details jsonb NOT NULL DEFAULT '{}',
        reason varchar(2000),
        status varchar(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'returned', 'cancelled')),
        decision_comment varchar(1000),
        workflow_instance_id uuid REFERENCES workflow_instance(id) ON DELETE RESTRICT,
        result jsonb
      )`);
    await q.query(`CREATE INDEX ix_lifecycle_employee ON lifecycle_request (employee_id, created_at DESC)`);

    await q.query(`
      CREATE TABLE checklist_template (${base},
        code varchar(30) NOT NULL UNIQUE,
        name varchar(200) NOT NULL,
        kind varchar(12) NOT NULL CHECK (kind IN ('onboarding', 'offboarding')),
        employment_types varchar(12)[] NOT NULL DEFAULT '{}',
        is_default boolean NOT NULL DEFAULT false,
        status varchar(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive'))
      )`);
    await q.query(`
      CREATE TABLE checklist_template_task (${base},
        template_id uuid NOT NULL REFERENCES checklist_template(id) ON DELETE CASCADE,
        seq int NOT NULL,
        title varchar(200) NOT NULL,
        description varchar(1000),
        assignee varchar(15) NOT NULL CHECK (assignee IN ('hr', 'it', 'facilities', 'finance', 'line_manager', 'employee')),
        due_offset_days int NOT NULL DEFAULT 0,
        blocks_exit boolean NOT NULL DEFAULT false
      )`);
    await q.query(`
      CREATE TABLE checklist (${base},
        employee_id uuid NOT NULL REFERENCES employee(id) ON DELETE RESTRICT,
        kind varchar(12) NOT NULL CHECK (kind IN ('onboarding', 'offboarding')),
        template_id uuid REFERENCES checklist_template(id) ON DELETE SET NULL,
        anchor_date date NOT NULL,
        status varchar(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'cancelled')),
        lifecycle_request_id uuid REFERENCES lifecycle_request(id) ON DELETE RESTRICT,
        completed_at timestamptz(3)
      )`);
    await q.query(`CREATE UNIQUE INDEX ux_checklist_open ON checklist (employee_id, kind) WHERE status = 'open'`);
    await q.query(`
      CREATE TABLE checklist_task (${base},
        checklist_id uuid NOT NULL REFERENCES checklist(id) ON DELETE CASCADE,
        seq int NOT NULL,
        title varchar(200) NOT NULL,
        description varchar(1000),
        assignee varchar(15) NOT NULL,
        due_date date NOT NULL,
        blocks_exit boolean NOT NULL DEFAULT false,
        status varchar(16) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'not_applicable')),
        done_by uuid,
        done_at timestamptz(3),
        note varchar(1000)
      )`);
    await q.query(`CREATE INDEX ix_checklist_task_open ON checklist_task (assignee, due_date) WHERE status = 'open'`);

    await q.query(`
      CREATE TABLE exit_clearance (${base},
        employee_id uuid NOT NULL UNIQUE REFERENCES employee(id) ON DELETE RESTRICT,
        exit_date date NOT NULL,
        exit_kind varchar(12) NOT NULL CHECK (exit_kind IN ('resignation', 'termination', 'contract_end', 'retirement', 'death', 'other')),
        notice_days int NOT NULL DEFAULT 0,
        notice_served_days int NOT NULL DEFAULT 0,
        procurement jsonb,
        procurement_checked_at timestamptz(3),
        procurement_cleared boolean,
        loans_outstanding ${money} NOT NULL DEFAULT 0,
        leave_days numeric(6,2) NOT NULL DEFAULT 0,
        leave_pay ${money} NOT NULL DEFAULT 0,
        notice_pay ${money} NOT NULL DEFAULT 0,
        final_dues_status varchar(10) NOT NULL DEFAULT 'draft' CHECK (final_dues_status IN ('draft', 'submitted', 'approved', 'posted')),
        final_dues_request_id uuid REFERENCES lifecycle_request(id) ON DELETE RESTRICT,
        completed_at timestamptz(3)
      )`);

    await q.query(`
      CREATE TABLE relations_case (${base},
        number varchar(40) NOT NULL UNIQUE,
        kind varchar(20) NOT NULL CHECK (kind IN ('warning', 'improvement_plan', 'complaint', 'award', 'disciplinary')),
        employee_id uuid REFERENCES employee(id) ON DELETE RESTRICT,
        subject varchar(300) NOT NULL,
        details varchar(8000),
        severity varchar(10) CHECK (severity IN ('verbal', 'first', 'final')),
        opened_on date NOT NULL,
        review_date date,
        expires_on date,
        status varchar(12) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'withdrawn')),
        outcome varchar(4000),
        restricted boolean NOT NULL DEFAULT false,
        complainant_employee_id uuid REFERENCES employee(id) ON DELETE RESTRICT,
        acknowledged_at timestamptz(3),
        document_ids uuid[] NOT NULL DEFAULT '{}'
      )`);
    await q.query(`CREATE INDEX ix_relations_employee ON relations_case (employee_id)`);
    // Who may see a restricted case (complaints): named people only, plus the complainant.
    await q.query(`
      CREATE TABLE relations_case_access (
        case_id uuid NOT NULL REFERENCES relations_case(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
        role varchar(12) NOT NULL DEFAULT 'investigator' CHECK (role IN ('owner', 'investigator')),
        PRIMARY KEY (case_id, user_id)
      )`);
    await q.query(`
      CREATE TABLE relations_note (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
        case_id uuid NOT NULL REFERENCES relations_case(id) ON DELETE CASCADE,
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        created_by uuid,
        author_name varchar(200),
        body varchar(4000) NOT NULL,
        visible_to_employee boolean NOT NULL DEFAULT false
      )`);
    await q.query(`
      CREATE TABLE improvement_objective (${base},
        case_id uuid NOT NULL REFERENCES relations_case(id) ON DELETE CASCADE,
        seq int NOT NULL,
        objective varchar(1000) NOT NULL,
        measure varchar(1000),
        due_date date,
        status varchar(12) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'met', 'not_met')),
        comment varchar(1000)
      )`);

    await q.query(`
      CREATE TABLE letter_template (${base},
        code varchar(30) NOT NULL UNIQUE,
        name varchar(200) NOT NULL,
        body text NOT NULL,
        status varchar(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive'))
      )`);
    await q.query(`
      CREATE TABLE issued_letter (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        created_by uuid,
        number varchar(40) NOT NULL UNIQUE,
        template_id uuid NOT NULL REFERENCES letter_template(id) ON DELETE RESTRICT,
        employee_id uuid NOT NULL REFERENCES employee(id) ON DELETE RESTRICT,
        format varchar(4) NOT NULL CHECK (format IN ('pdf', 'docx')),
        document_id uuid NOT NULL REFERENCES document(id) ON DELETE RESTRICT,
        fields jsonb NOT NULL
      )`);
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const t of ['issued_letter', 'letter_template', 'improvement_objective', 'relations_note', 'relations_case_access', 'relations_case', 'exit_clearance', 'checklist_task', 'checklist', 'checklist_template_task', 'checklist_template', 'lifecycle_request', 'employee_contract']) {
      await q.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
    }
  }
}
