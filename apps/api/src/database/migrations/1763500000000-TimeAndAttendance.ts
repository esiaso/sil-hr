import { MigrationInterface, QueryRunner } from 'typeorm';

/** Slice 4: shifts per department, rosters, immutable clock events, derived daily attendance, overtime rules, regularisations, device connectors. */
export class TimeAndAttendance1763500000000 implements MigrationInterface {
  name = 'TimeAndAttendance1763500000000';

  public async up(q: QueryRunner): Promise<void> {
    const base = `
      id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
      created_at timestamptz(3) NOT NULL DEFAULT now(),
      updated_at timestamptz(3) NOT NULL DEFAULT now(),
      created_by uuid,
      updated_by uuid,
      version int NOT NULL DEFAULT 1`;

    await q.query(`
      CREATE TABLE shift (${base},
        code varchar(20) NOT NULL UNIQUE,
        name varchar(200) NOT NULL,
        start_time time NOT NULL,
        end_time time NOT NULL,
        break_minutes int NOT NULL DEFAULT 0 CHECK (break_minutes >= 0),
        late_grace_minutes int CHECK (late_grace_minutes >= 0),
        early_leave_grace_minutes int CHECK (early_leave_grace_minutes >= 0),
        colour varchar(7),
        status varchar(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
        CONSTRAINT ck_shift_times CHECK (start_time <> end_time)
      )`);
    await q.query(`
      CREATE TABLE department_shift_setting (${base},
        department_id uuid NOT NULL UNIQUE REFERENCES department(id) ON DELETE CASCADE,
        mode varchar(10) NOT NULL CHECK (mode IN ('standing', 'rostered')),
        standing_shift_id uuid REFERENCES shift(id) ON DELETE RESTRICT,
        shift_ids uuid[] NOT NULL DEFAULT '{}',
        CONSTRAINT ck_standing_shift CHECK (mode <> 'standing' OR standing_shift_id IS NOT NULL)
      )`);
    await q.query(`
      CREATE TABLE roster_entry (${base},
        employee_id uuid NOT NULL REFERENCES employee(id) ON DELETE RESTRICT,
        work_date date NOT NULL,
        shift_id uuid REFERENCES shift(id) ON DELETE RESTRICT,
        kind varchar(5) NOT NULL DEFAULT 'shift' CHECK (kind IN ('shift', 'off')),
        note varchar(200),
        CONSTRAINT ck_roster_kind CHECK ((kind = 'shift') = (shift_id IS NOT NULL))
      )`);
    await q.query(`CREATE UNIQUE INDEX ux_roster_entry ON roster_entry (employee_id, work_date, coalesce(shift_id, '00000000-0000-0000-0000-000000000000'::uuid))`);
    await q.query(`CREATE INDEX ix_roster_date ON roster_entry (work_date)`);

    await q.query(`
      CREATE TABLE connector (${base},
        code varchar(40) NOT NULL UNIQUE,
        name varchar(200) NOT NULL,
        type varchar(30) NOT NULL CHECK (type IN ('zkteco_biotime', 'zkteco_push', 'hikvision_isapi', 'hikvision_push')),
        config jsonb NOT NULL DEFAULT '{}',
        credentials_enc varchar(2000),
        match_by varchar(15) NOT NULL DEFAULT 'staff_number' CHECK (match_by IN ('staff_number', 'mapping')),
        schedule_minutes int CHECK (schedule_minutes > 0),
        is_active boolean NOT NULL DEFAULT true,
        cursor_at timestamptz(3),
        last_run_at timestamptz(3),
        last_success_at timestamptz(3),
        health varchar(10) NOT NULL DEFAULT 'unknown' CHECK (health IN ('unknown', 'ok', 'degraded', 'failing')),
        health_message varchar(500)
      )`);
    await q.query(`
      CREATE TABLE connector_run (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
        connector_id uuid NOT NULL REFERENCES connector(id) ON DELETE CASCADE,
        trigger varchar(10) NOT NULL CHECK (trigger IN ('schedule', 'manual', 'push', 'test')),
        status varchar(10) NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
        started_at timestamptz(3) NOT NULL DEFAULT now(),
        finished_at timestamptz(3),
        window_from timestamptz(3),
        window_to timestamptz(3),
        received int NOT NULL DEFAULT 0,
        accepted int NOT NULL DEFAULT 0,
        duplicates int NOT NULL DEFAULT 0,
        unmatched int NOT NULL DEFAULT 0,
        error varchar(2000)
      )`);
    await q.query(`CREATE INDEX ix_connector_run ON connector_run (connector_id, started_at DESC)`);
    await q.query(`
      CREATE TABLE device_user_mapping (${base},
        connector_id uuid NOT NULL REFERENCES connector(id) ON DELETE CASCADE,
        device_user_id varchar(60) NOT NULL,
        employee_id uuid NOT NULL REFERENCES employee(id) ON DELETE RESTRICT,
        CONSTRAINT ux_device_user UNIQUE (connector_id, device_user_id)
      )`);

    // Immutable raw punches, whatever their source.
    await q.query(`
      CREATE TABLE clock_event (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
        employee_id uuid REFERENCES employee(id) ON DELETE RESTRICT,
        occurred_at timestamptz(3) NOT NULL,
        direction varchar(8) NOT NULL DEFAULT 'unknown' CHECK (direction IN ('in', 'out', 'unknown')),
        source varchar(15) NOT NULL CHECK (source IN ('web', 'mobile', 'device', 'import', 'api', 'regularisation')),
        connector_id uuid REFERENCES connector(id) ON DELETE RESTRICT,
        device_id varchar(60),
        device_user_id varchar(60),
        dedup_key varchar(200) NOT NULL UNIQUE,
        raw jsonb,
        received_at timestamptz(3) NOT NULL DEFAULT now(),
        recorded_by uuid
      )`);
    await q.query(`CREATE INDEX ix_clock_event_employee ON clock_event (employee_id, occurred_at)`);
    await q.query(`CREATE INDEX ix_clock_event_unmatched ON clock_event (connector_id, device_user_id) WHERE employee_id IS NULL`);
    await q.query(`
      CREATE FUNCTION clock_event_immutable() RETURNS trigger AS $$
      BEGIN
        -- Only matching an unmatched punch to an employee is allowed later.
        IF TG_OP = 'UPDATE' AND OLD.employee_id IS NULL AND NEW.employee_id IS NOT NULL
           AND NEW.occurred_at = OLD.occurred_at AND NEW.direction = OLD.direction AND NEW.source = OLD.source THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'clock_event is immutable (% not allowed)', TG_OP USING ERRCODE = 'insufficient_privilege';
      END
      $$ LANGUAGE plpgsql`);
    await q.query(`CREATE TRIGGER clock_event_immutable BEFORE UPDATE OR DELETE ON clock_event FOR EACH ROW EXECUTE FUNCTION clock_event_immutable()`);

    await q.query(`
      CREATE TABLE attendance_day (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
        employee_id uuid NOT NULL REFERENCES employee(id) ON DELETE RESTRICT,
        work_date date NOT NULL,
        shift_id uuid REFERENCES shift(id) ON DELETE RESTRICT,
        scheduled_start timestamptz(3),
        scheduled_end timestamptz(3),
        first_in timestamptz(3),
        last_out timestamptz(3),
        worked_minutes int NOT NULL DEFAULT 0,
        late_minutes int NOT NULL DEFAULT 0,
        early_leave_minutes int NOT NULL DEFAULT 0,
        overtime_minutes int NOT NULL DEFAULT 0,
        day_type varchar(15) NOT NULL DEFAULT 'normal' CHECK (day_type IN ('normal', 'rest_day', 'public_holiday')),
        status varchar(15) NOT NULL CHECK (status IN ('present', 'late', 'half_day', 'absent', 'on_leave', 'rest_day', 'holiday', 'incomplete', 'not_scheduled')),
        leave_request_id uuid REFERENCES leave_request(id) ON DELETE SET NULL,
        regularised boolean NOT NULL DEFAULT false,
        computed_at timestamptz(3) NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE UNIQUE INDEX ux_attendance_day ON attendance_day (employee_id, work_date, coalesce(shift_id, '00000000-0000-0000-0000-000000000000'::uuid))`);
    await q.query(`CREATE INDEX ix_attendance_date ON attendance_day (work_date)`);

    await q.query(`
      CREATE TABLE overtime_rule (${base},
        day_type varchar(15) NOT NULL CHECK (day_type IN ('normal', 'rest_day', 'public_holiday')),
        multiplier numeric(4,2) CHECK (multiplier >= 1),
        min_minutes int NOT NULL DEFAULT 30 CHECK (min_minutes >= 0),
        requires_approval boolean NOT NULL DEFAULT false,
        effective_from date NOT NULL,
        effective_to date,
        CONSTRAINT ex_overtime_rule_overlap EXCLUDE USING gist (day_type WITH =, daterange(effective_from, effective_to, '[]') WITH &&)
      )`);

    await q.query(`
      CREATE TABLE attendance_regularisation (${base},
        employee_id uuid NOT NULL REFERENCES employee(id) ON DELETE RESTRICT,
        work_date date NOT NULL,
        clock_in timestamptz(3),
        clock_out timestamptz(3),
        reason varchar(500) NOT NULL,
        status varchar(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'returned', 'cancelled')),
        decision_comment varchar(1000),
        CONSTRAINT ck_regularisation_times CHECK (clock_in IS NOT NULL OR clock_out IS NOT NULL)
      )`);
    await q.query(`CREATE INDEX ix_regularisation_employee ON attendance_regularisation (employee_id, work_date)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS clock_event CASCADE`);
    await q.query(`DROP FUNCTION IF EXISTS clock_event_immutable()`);
    for (const t of ['attendance_regularisation', 'overtime_rule', 'attendance_day', 'device_user_mapping', 'connector_run', 'connector', 'roster_entry', 'department_shift_setting', 'shift']) {
      await q.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
    }
  }
}
