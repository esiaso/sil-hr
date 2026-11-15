import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Slice 2: employees (with encrypted personal data and blind indexes), effective-dated
 * position assignments, status history, contacts, dependants, qualifications, payment
 * details, professional licences, the document checklist, self-service contact changes
 * and bulk import/export jobs.
 */
export class Employees1763300000000 implements MigrationInterface {
  name = 'Employees1763300000000';

  public async up(q: QueryRunner): Promise<void> {
    const base = `
      id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
      created_at timestamptz(3) NOT NULL DEFAULT now(),
      updated_at timestamptz(3) NOT NULL DEFAULT now(),
      created_by uuid,
      updated_by uuid,
      version int NOT NULL DEFAULT 1`;
    const soft = `${base},
      deleted_at timestamptz(3)`;
    const relationship = `relationship varchar(20) NOT NULL CHECK (relationship IN ('spouse', 'child', 'parent', 'sibling', 'guardian', 'relative', 'friend', 'other'))`;

    await q.query(`
      CREATE TABLE employee (${soft},
        organisation_id uuid NOT NULL REFERENCES organisation(id) ON DELETE RESTRICT,
        staff_number varchar(30) NOT NULL,
        first_name varchar(100) NOT NULL,
        middle_name varchar(100),
        last_name varchar(100) NOT NULL,
        gender varchar(12) CHECK (gender IN ('female', 'male', 'other', 'undisclosed')),
        date_of_birth date CHECK (date_of_birth > '1900-01-01'),
        marital_status varchar(12) CHECK (marital_status IN ('single', 'married', 'divorced', 'widowed', 'separated', 'undisclosed')),
        nationality varchar(60),
        national_id_enc varchar(300),
        national_id_bidx char(64),
        passport_enc varchar(300),
        passport_bidx char(64),
        kra_pin_enc varchar(300),
        kra_pin_bidx char(64),
        nssf_number varchar(30),
        sha_number varchar(30),
        personal_email varchar(200),
        personal_phone varchar(30),
        work_email varchar(200),
        work_phone varchar(30),
        postal_address varchar(300),
        residential_address varchar(300),
        employment_type varchar(12) NOT NULL CHECK (employment_type IN ('permanent', 'contract', 'casual', 'locum', 'intern')),
        status varchar(12) NOT NULL CHECK (status IN ('onboarding', 'probation', 'active', 'on_notice', 'suspended', 'exited')),
        hire_date date NOT NULL,
        probation_end_date date,
        exit_date date,
        exit_reason varchar(500),
        branch_id uuid REFERENCES branch(id) ON DELETE RESTRICT,
        department_id uuid REFERENCES department(id) ON DELETE RESTRICT,
        position_id uuid REFERENCES position(id) ON DELETE RESTRICT,
        cost_centre_id uuid REFERENCES cost_centre(id) ON DELETE RESTRICT,
        manager_id uuid REFERENCES employee(id) ON DELETE RESTRICT,
        licence_status varchar(12) CHECK (licence_status IN ('valid', 'expiring', 'expired', 'suspended', 'not_verified')),
        CONSTRAINT ck_employee_not_own_manager CHECK (manager_id IS NULL OR manager_id <> id),
        CONSTRAINT ck_employee_exit CHECK ((status = 'exited') = (exit_date IS NOT NULL)),
        CONSTRAINT ck_employee_dates CHECK (exit_date IS NULL OR exit_date >= hire_date),
        CONSTRAINT ck_employee_probation CHECK (probation_end_date IS NULL OR probation_end_date >= hire_date)
      )`);
    await q.query(`CREATE UNIQUE INDEX ux_employee_staff_number ON employee (organisation_id, lower(staff_number)) WHERE deleted_at IS NULL`);
    await q.query(`CREATE UNIQUE INDEX ux_employee_national_id ON employee (national_id_bidx) WHERE national_id_bidx IS NOT NULL AND deleted_at IS NULL`);
    await q.query(`CREATE UNIQUE INDEX ux_employee_passport ON employee (passport_bidx) WHERE passport_bidx IS NOT NULL AND deleted_at IS NULL`);
    await q.query(`CREATE UNIQUE INDEX ux_employee_kra_pin ON employee (kra_pin_bidx) WHERE kra_pin_bidx IS NOT NULL AND deleted_at IS NULL`);
    await q.query(`CREATE UNIQUE INDEX ux_employee_work_email ON employee (lower(work_email)) WHERE work_email IS NOT NULL AND deleted_at IS NULL`);
    await q.query(`CREATE INDEX ix_employee_department ON employee (department_id)`);
    await q.query(`CREATE INDEX ix_employee_branch ON employee (branch_id)`);
    await q.query(`CREATE INDEX ix_employee_manager ON employee (manager_id)`);
    await q.query(`CREATE INDEX ix_employee_status ON employee (status)`);
    await q.query(`CREATE INDEX ix_employee_updated ON employee (updated_at, id)`);
    await q.query(`CREATE INDEX ix_employee_name_trgm ON employee USING gin ((first_name || ' ' || coalesce(middle_name, '') || ' ' || last_name) gin_trgm_ops)`);

    await q.query(`ALTER TABLE user_account ADD CONSTRAINT fk_user_employee FOREIGN KEY (employee_id) REFERENCES employee(id) ON DELETE RESTRICT`);

    // Position history: no two assignments of one employee may overlap (inclusive dates).
    await q.query(`
      CREATE TABLE employee_position_assignment (${base},
        employee_id uuid NOT NULL REFERENCES employee(id) ON DELETE RESTRICT,
        position_id uuid NOT NULL REFERENCES position(id) ON DELETE RESTRICT,
        department_id uuid NOT NULL REFERENCES department(id) ON DELETE RESTRICT,
        branch_id uuid NOT NULL REFERENCES branch(id) ON DELETE RESTRICT,
        cost_centre_id uuid REFERENCES cost_centre(id) ON DELETE RESTRICT,
        manager_id uuid REFERENCES employee(id) ON DELETE RESTRICT,
        effective_from date NOT NULL,
        effective_to date,
        reason varchar(500),
        CONSTRAINT ck_assignment_dates CHECK (effective_to IS NULL OR effective_to >= effective_from),
        CONSTRAINT ex_assignment_overlap EXCLUDE USING gist (employee_id WITH =, daterange(effective_from, effective_to, '[]') WITH &&)
      )`);
    await q.query(`CREATE INDEX ix_assignment_employee ON employee_position_assignment (employee_id, effective_from)`);
    await q.query(`CREATE INDEX ix_assignment_position ON employee_position_assignment (position_id)`);

    await q.query(`
      CREATE TABLE employee_status_history (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
        employee_id uuid NOT NULL REFERENCES employee(id) ON DELETE RESTRICT,
        from_status varchar(12),
        to_status varchar(12) NOT NULL,
        effective_date date NOT NULL,
        reason varchar(500),
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        created_by uuid
      )`);
    await q.query(`CREATE INDEX ix_status_history_employee ON employee_status_history (employee_id, created_at)`);

    await q.query(`
      CREATE TABLE employee_contact (${base},
        employee_id uuid NOT NULL REFERENCES employee(id) ON DELETE RESTRICT,
        kind varchar(12) NOT NULL CHECK (kind IN ('next_of_kin', 'emergency')),
        name varchar(200) NOT NULL,
        ${relationship},
        phone varchar(30),
        email varchar(200),
        address varchar(300),
        is_primary boolean NOT NULL DEFAULT false
      )`);
    await q.query(`CREATE INDEX ix_employee_contact ON employee_contact (employee_id)`);
    await q.query(`
      CREATE TABLE employee_dependant (${base},
        employee_id uuid NOT NULL REFERENCES employee(id) ON DELETE RESTRICT,
        name varchar(200) NOT NULL,
        ${relationship},
        date_of_birth date,
        gender varchar(12) CHECK (gender IN ('female', 'male', 'other', 'undisclosed')),
        is_beneficiary boolean NOT NULL DEFAULT false
      )`);
    await q.query(`CREATE INDEX ix_employee_dependant ON employee_dependant (employee_id)`);
    await q.query(`
      CREATE TABLE employee_qualification (${base},
        employee_id uuid NOT NULL REFERENCES employee(id) ON DELETE RESTRICT,
        level varchar(20) NOT NULL CHECK (level IN ('certificate', 'diploma', 'higher_diploma', 'degree', 'masters', 'doctorate', 'professional', 'other')),
        title varchar(200) NOT NULL,
        institution varchar(200),
        year_awarded int CHECK (year_awarded BETWEEN 1950 AND 2100),
        document_id uuid REFERENCES document(id) ON DELETE RESTRICT
      )`);
    await q.query(`CREATE INDEX ix_employee_qualification ON employee_qualification (employee_id)`);
    await q.query(`
      CREATE TABLE employee_bank_account (${base},
        employee_id uuid NOT NULL REFERENCES employee(id) ON DELETE RESTRICT,
        kind varchar(12) NOT NULL CHECK (kind IN ('bank', 'mobile_money')),
        bank_name varchar(100),
        bank_code varchar(10),
        branch_name varchar(100),
        branch_code varchar(10),
        account_name varchar(200) NOT NULL,
        account_number_enc varchar(300) NOT NULL,
        account_last4 varchar(4) NOT NULL,
        is_primary boolean NOT NULL DEFAULT false
      )`);
    await q.query(`CREATE UNIQUE INDEX ux_bank_account_primary ON employee_bank_account (employee_id) WHERE is_primary`);

    await q.query(`
      CREATE TABLE professional_licence (${soft},
        employee_id uuid NOT NULL REFERENCES employee(id) ON DELETE RESTRICT,
        licensing_body varchar(100) NOT NULL,
        licence_number varchar(60) NOT NULL,
        category varchar(100),
        issue_date date,
        expiry_date date NOT NULL,
        verified_at timestamptz(3),
        verified_by uuid,
        suspended boolean NOT NULL DEFAULT false,
        document_id uuid REFERENCES document(id) ON DELETE RESTRICT,
        notes varchar(1000),
        expiring_notified_for date,
        expired_notified_for date,
        CONSTRAINT ck_licence_dates CHECK (issue_date IS NULL OR issue_date <= expiry_date)
      )`);
    await q.query(`CREATE UNIQUE INDEX ux_licence_number ON professional_licence (lower(licensing_body), lower(licence_number)) WHERE deleted_at IS NULL`);
    await q.query(`CREATE INDEX ix_licence_employee ON professional_licence (employee_id)`);
    await q.query(`CREATE INDEX ix_licence_expiry ON professional_licence (expiry_date) WHERE deleted_at IS NULL`);

    await q.query(`
      CREATE TABLE document_type (${base},
        code varchar(40) NOT NULL UNIQUE,
        name varchar(200) NOT NULL,
        description varchar(500),
        required_for text[] NOT NULL DEFAULT '{}',
        has_expiry boolean NOT NULL DEFAULT false,
        is_sensitive boolean NOT NULL DEFAULT false,
        status varchar(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive'))
      )`);
    await q.query(`
      CREATE TABLE employee_document (${base},
        employee_id uuid NOT NULL REFERENCES employee(id) ON DELETE RESTRICT,
        document_type_id uuid NOT NULL REFERENCES document_type(id) ON DELETE RESTRICT,
        document_id uuid NOT NULL REFERENCES document(id) ON DELETE RESTRICT,
        expiry_date date,
        verification varchar(10) NOT NULL DEFAULT 'pending' CHECK (verification IN ('pending', 'verified', 'rejected')),
        verified_by uuid,
        verified_at timestamptz(3),
        notes varchar(500)
      )`);
    await q.query(`CREATE INDEX ix_employee_document ON employee_document (employee_id, document_type_id)`);

    await q.query(`
      CREATE TABLE contact_change_request (${base},
        employee_id uuid NOT NULL REFERENCES employee(id) ON DELETE RESTRICT,
        changes jsonb NOT NULL,
        status varchar(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
        decided_at timestamptz(3),
        decided_by uuid,
        decision_note varchar(500)
      )`);
    await q.query(`CREATE UNIQUE INDEX ux_contact_change_pending ON contact_change_request (employee_id) WHERE status = 'pending'`);

    await q.query(`
      CREATE TABLE bulk_job (${base},
        kind varchar(40) NOT NULL,
        status varchar(10) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
        dry_run boolean NOT NULL DEFAULT false,
        input_document_id uuid REFERENCES document(id) ON DELETE RESTRICT,
        result_document_id uuid REFERENCES document(id) ON DELETE RESTRICT,
        params jsonb NOT NULL DEFAULT '{}',
        total_rows int,
        processed_rows int NOT NULL DEFAULT 0,
        created_count int NOT NULL DEFAULT 0,
        updated_count int NOT NULL DEFAULT 0,
        error_count int NOT NULL DEFAULT 0,
        errors jsonb NOT NULL DEFAULT '[]',
        started_at timestamptz(3),
        finished_at timestamptz(3),
        requested_by uuid
      )`);
    await q.query(`CREATE INDEX ix_bulk_job_queued ON bulk_job (created_at) WHERE status = 'queued'`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE user_account DROP CONSTRAINT IF EXISTS fk_user_employee`);
    for (const t of [
      'bulk_job', 'contact_change_request', 'employee_document', 'document_type', 'professional_licence', 'employee_bank_account',
      'employee_qualification', 'employee_dependant', 'employee_contact', 'employee_status_history', 'employee_position_assignment', 'employee',
    ]) {
      await q.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
    }
  }
}
