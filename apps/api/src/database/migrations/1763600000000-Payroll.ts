import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Slice 5: pay components, effective-dated salaries and pay items, loans, one-off items,
 * effective-dated statutory rate tables, payroll runs and payslips, payment file formats,
 * and the chart-of-accounts mapping for the journal.
 */
export class Payroll1763600000000 implements MigrationInterface {
  name = 'Payroll1763600000000';

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
      CREATE TABLE pay_component (${base},
        code varchar(30) NOT NULL UNIQUE,
        name varchar(200) NOT NULL,
        kind varchar(25) NOT NULL CHECK (kind IN ('earning', 'deduction', 'benefit', 'employer_contribution')),
        method varchar(15) NOT NULL DEFAULT 'fixed' CHECK (method IN ('fixed', 'percent_basic', 'percent_gross', 'formula')),
        default_value numeric(14,4),
        formula varchar(500),
        taxable boolean NOT NULL DEFAULT true,
        pensionable boolean NOT NULL DEFAULT false,
        prorate boolean NOT NULL DEFAULT true,
        tax_treatment varchar(25) NOT NULL DEFAULT 'none' CHECK (tax_treatment IN ('none', 'pension', 'insurance', 'mortgage_interest', 'post_retirement_medical')),
        is_system boolean NOT NULL DEFAULT false,
        sort_order int NOT NULL DEFAULT 100,
        status varchar(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
        CONSTRAINT ck_component_formula CHECK (method <> 'formula' OR formula IS NOT NULL)
      )`);

    await q.query(`
      CREATE TABLE statutory_rate (${base},
        code varchar(20) NOT NULL CHECK (code IN ('PAYE', 'NSSF', 'SHIF', 'HOUSING_LEVY', 'NITA', 'ALLOWABLE')),
        effective_from date NOT NULL,
        effective_to date,
        params jsonb NOT NULL,
        source varchar(300),
        CONSTRAINT ck_statutory_dates CHECK (effective_to IS NULL OR effective_to >= effective_from),
        CONSTRAINT ex_statutory_overlap EXCLUDE USING gist (code WITH =, daterange(effective_from, effective_to, '[]') WITH &&)
      )`);

    await q.query(`
      CREATE TABLE employee_salary (${base},
        employee_id uuid NOT NULL REFERENCES employee(id) ON DELETE RESTRICT,
        basic ${money} NOT NULL CHECK (basic >= 0),
        effective_from date NOT NULL,
        effective_to date,
        reason varchar(300),
        CONSTRAINT ck_salary_dates CHECK (effective_to IS NULL OR effective_to >= effective_from),
        CONSTRAINT ex_salary_overlap EXCLUDE USING gist (employee_id WITH =, daterange(effective_from, effective_to, '[]') WITH &&)
      )`);

    await q.query(`
      CREATE TABLE employee_pay_item (${base},
        employee_id uuid NOT NULL REFERENCES employee(id) ON DELETE RESTRICT,
        component_id uuid NOT NULL REFERENCES pay_component(id) ON DELETE RESTRICT,
        value numeric(14,4),
        formula varchar(500),
        effective_from date NOT NULL,
        effective_to date,
        note varchar(300),
        CONSTRAINT ck_item_dates CHECK (effective_to IS NULL OR effective_to >= effective_from),
        CONSTRAINT ex_item_overlap EXCLUDE USING gist (employee_id WITH =, component_id WITH =, daterange(effective_from, effective_to, '[]') WITH &&)
      )`);

    await q.query(`
      CREATE TABLE employee_loan (${base},
        employee_id uuid NOT NULL REFERENCES employee(id) ON DELETE RESTRICT,
        component_id uuid NOT NULL REFERENCES pay_component(id) ON DELETE RESTRICT,
        reference varchar(60),
        principal ${money} NOT NULL CHECK (principal > 0),
        installment ${money} NOT NULL CHECK (installment > 0),
        start_period char(7) NOT NULL CHECK (start_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
        status varchar(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'settled', 'cancelled')),
        note varchar(300)
      )`);
    await q.query(`CREATE INDEX ix_loan_employee ON employee_loan (employee_id)`);

    await q.query(`
      CREATE TABLE payroll_one_off (${base},
        employee_id uuid NOT NULL REFERENCES employee(id) ON DELETE RESTRICT,
        component_id uuid NOT NULL REFERENCES pay_component(id) ON DELETE RESTRICT,
        period char(7) NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
        amount ${money} NOT NULL CHECK (amount > 0),
        note varchar(300)
      )`);
    await q.query(`CREATE INDEX ix_one_off_period ON payroll_one_off (period)`);

    await q.query(`
      CREATE TABLE payroll_run (${base},
        number varchar(30) NOT NULL UNIQUE,
        period char(7) NOT NULL UNIQUE CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
        period_start date NOT NULL,
        period_end date NOT NULL,
        pay_date date NOT NULL,
        status varchar(15) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'calculated', 'under_review', 'approved', 'paid', 'closed')),
        employees int NOT NULL DEFAULT 0,
        gross ${money} NOT NULL DEFAULT 0,
        total_deductions ${money} NOT NULL DEFAULT 0,
        net ${money} NOT NULL DEFAULT 0,
        paye ${money} NOT NULL DEFAULT 0,
        employer_cost ${money} NOT NULL DEFAULT 0,
        warnings jsonb NOT NULL DEFAULT '[]',
        calculated_at timestamptz(3),
        calculated_by uuid,
        submitted_at timestamptz(3),
        approved_at timestamptz(3),
        paid_at timestamptz(3),
        closed_at timestamptz(3),
        decision_comment varchar(1000),
        workflow_instance_id uuid
      )`);

    await q.query(`
      CREATE TABLE payslip (${base},
        run_id uuid NOT NULL REFERENCES payroll_run(id) ON DELETE CASCADE,
        employee_id uuid NOT NULL REFERENCES employee(id) ON DELETE RESTRICT,
        number varchar(40) UNIQUE,
        employee_name varchar(300) NOT NULL,
        staff_number varchar(30) NOT NULL,
        department_id uuid,
        department_name varchar(200),
        cost_centre_id uuid,
        cost_centre_code varchar(30),
        basic ${money} NOT NULL,
        gross ${money} NOT NULL,
        taxable_pay ${money} NOT NULL,
        paye ${money} NOT NULL,
        nssf ${money} NOT NULL,
        shif ${money} NOT NULL,
        housing_levy ${money} NOT NULL,
        total_deductions ${money} NOT NULL,
        net ${money} NOT NULL,
        employer_cost ${money} NOT NULL,
        tax jsonb NOT NULL,
        inputs jsonb NOT NULL,
        warnings jsonb NOT NULL DEFAULT '[]',
        payment_method varchar(15),
        payment_account_id uuid,
        UNIQUE (run_id, employee_id)
      )`);
    await q.query(`CREATE INDEX ix_payslip_employee ON payslip (employee_id)`);

    await q.query(`
      CREATE TABLE payslip_line (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
        payslip_id uuid NOT NULL REFERENCES payslip(id) ON DELETE CASCADE,
        seq int NOT NULL,
        code varchar(40) NOT NULL,
        name varchar(200) NOT NULL,
        kind varchar(25) NOT NULL,
        amount ${money} NOT NULL,
        taxable boolean,
        detail varchar(200),
        loan_id uuid REFERENCES employee_loan(id) ON DELETE RESTRICT
      )`);
    await q.query(`CREATE INDEX ix_payslip_line_payslip ON payslip_line (payslip_id)`);
    await q.query(`CREATE INDEX ix_payslip_line_loan ON payslip_line (loan_id) WHERE loan_id IS NOT NULL`);

    // Approved payslips are the record: refuse changes once the run has left review.
    await q.query(`
      CREATE FUNCTION payslip_locked() RETURNS trigger AS $$
      BEGIN
        IF (SELECT status FROM payroll_run WHERE id = OLD.run_id) IN ('approved', 'paid', 'closed') THEN
          RAISE EXCEPTION 'payslips of an approved run cannot be changed' USING ERRCODE = 'check_violation';
        END IF;
        RETURN COALESCE(NEW, OLD);
      END $$ LANGUAGE plpgsql`);
    await q.query(`
      CREATE FUNCTION payslip_line_locked() RETURNS trigger AS $$
      BEGIN
        IF (SELECT r.status FROM payroll_run r JOIN payslip p ON p.run_id = r.id WHERE p.id = OLD.payslip_id) IN ('approved', 'paid', 'closed') THEN
          RAISE EXCEPTION 'payslips of an approved run cannot be changed' USING ERRCODE = 'check_violation';
        END IF;
        RETURN COALESCE(NEW, OLD);
      END $$ LANGUAGE plpgsql`);
    await q.query(`CREATE TRIGGER tr_payslip_locked BEFORE UPDATE OR DELETE ON payslip FOR EACH ROW EXECUTE FUNCTION payslip_locked()`);
    await q.query(`CREATE TRIGGER tr_payslip_line_locked BEFORE UPDATE OR DELETE ON payslip_line FOR EACH ROW EXECUTE FUNCTION payslip_line_locked()`);

    await q.query(`
      CREATE TABLE payment_file_format (${base},
        code varchar(30) NOT NULL UNIQUE,
        name varchar(200) NOT NULL,
        channel varchar(15) NOT NULL CHECK (channel IN ('bank', 'mobile_money')),
        file_type varchar(5) NOT NULL CHECK (file_type IN ('xlsx', 'csv')),
        columns jsonb NOT NULL,
        is_default boolean NOT NULL DEFAULT false,
        note varchar(500)
      )`);

    await q.query(`
      CREATE TABLE gl_account_map (${base},
        key varchar(40) NOT NULL UNIQUE,
        description varchar(200),
        debit_account varchar(40),
        credit_account varchar(40)
      )`);
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const t of ['gl_account_map', 'payment_file_format', 'payslip_line', 'payslip', 'payroll_run', 'payroll_one_off', 'employee_loan', 'employee_pay_item', 'employee_salary', 'statutory_rate', 'pay_component']) {
      await q.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
    }
    await q.query(`DROP FUNCTION IF EXISTS payslip_locked()`);
    await q.query(`DROP FUNCTION IF EXISTS payslip_line_locked()`);
  }
}
