import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Slice 9: announcements, policy documents with read acknowledgements, meeting rooms and
 * meetings (attendees, minutes, action items), calendar feed tokens, the SMS outbox, and
 * travel requests with expense claims.
 */
export class Workplace1764100000000 implements MigrationInterface {
  name = 'Workplace1764100000000';

  public async up(q: QueryRunner): Promise<void> {
    const base = `
      id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
      created_at timestamptz(3) NOT NULL DEFAULT now(),
      updated_at timestamptz(3) NOT NULL DEFAULT now(),
      created_by uuid,
      updated_by uuid,
      version int NOT NULL DEFAULT 1`;
    const money = 'numeric(14,2)';

    // ------------------------------------------------------------------ announcements
    await q.query(`
      CREATE TABLE announcement (${base},
        title varchar(200) NOT NULL,
        body text NOT NULL,
        branch_ids uuid[] NOT NULL DEFAULT '{}',
        department_ids uuid[] NOT NULL DEFAULT '{}',
        publish_at timestamptz(3) NOT NULL DEFAULT now(),
        expires_at timestamptz(3),
        pinned boolean NOT NULL DEFAULT false,
        status varchar(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'withdrawn')),
        notified_at timestamptz(3),
        CONSTRAINT ck_announcement_dates CHECK (expires_at IS NULL OR expires_at > publish_at)
      )`);
    await q.query(`CREATE INDEX ix_announcement_live ON announcement (status, publish_at)`);

    // ------------------------------------------------------------------ policies
    await q.query(`
      CREATE TABLE policy_document (${base},
        code varchar(30) NOT NULL UNIQUE,
        title varchar(200) NOT NULL,
        category varchar(20) NOT NULL CHECK (category IN ('hr', 'clinical', 'safety', 'ict', 'finance', 'code_of_conduct', 'other')),
        description varchar(2000),
        department_ids uuid[] NOT NULL DEFAULT '{}',
        requires_ack boolean NOT NULL DEFAULT true,
        status varchar(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
        current_version_id uuid
      )`);
    await q.query(`
      CREATE TABLE policy_version (${base},
        policy_id uuid NOT NULL REFERENCES policy_document(id) ON DELETE CASCADE,
        version_no int NOT NULL,
        document_id uuid NOT NULL REFERENCES document(id) ON DELETE RESTRICT,
        effective_from date NOT NULL,
        changes varchar(2000),
        UNIQUE (policy_id, version_no)
      )`);
    await q.query(`ALTER TABLE policy_document ADD CONSTRAINT fk_policy_current FOREIGN KEY (current_version_id) REFERENCES policy_version(id) ON DELETE RESTRICT`);
    await q.query(`
      CREATE TABLE policy_acknowledgement (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
        version_id uuid NOT NULL REFERENCES policy_version(id) ON DELETE CASCADE,
        employee_id uuid NOT NULL REFERENCES employee(id) ON DELETE RESTRICT,
        acknowledged_at timestamptz(3) NOT NULL DEFAULT now(),
        UNIQUE (version_id, employee_id)
      )`);

    // ------------------------------------------------------------------ meetings
    await q.query(`
      CREATE TABLE meeting_room (${base},
        name varchar(120) NOT NULL UNIQUE,
        location varchar(200),
        capacity int CHECK (capacity > 0),
        facilities varchar(500),
        status varchar(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive'))
      )`);
    await q.query(`
      CREATE TABLE meeting (${base},
        title varchar(200) NOT NULL,
        room_id uuid REFERENCES meeting_room(id) ON DELETE RESTRICT,
        location varchar(200),
        online_link varchar(500),
        starts_at timestamptz(3) NOT NULL,
        ends_at timestamptz(3) NOT NULL,
        organiser_user_id uuid NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
        agenda text,
        status varchar(10) NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'held', 'cancelled')),
        minutes text,
        minutes_at timestamptz(3),
        CONSTRAINT ck_meeting_time CHECK (ends_at > starts_at),
        CONSTRAINT ex_room_double_booked EXCLUDE USING gist (room_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE (room_id IS NOT NULL AND status <> 'cancelled')
      )`);
    await q.query(`CREATE INDEX ix_meeting_start ON meeting (starts_at)`);
    await q.query(`
      CREATE TABLE meeting_attendee (
        meeting_id uuid NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
        response varchar(10) NOT NULL DEFAULT 'pending' CHECK (response IN ('pending', 'accepted', 'tentative', 'declined')),
        attended boolean,
        PRIMARY KEY (meeting_id, user_id)
      )`);
    await q.query(`CREATE INDEX ix_attendee_user ON meeting_attendee (user_id)`);
    await q.query(`
      CREATE TABLE meeting_action (${base},
        meeting_id uuid NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
        description varchar(1000) NOT NULL,
        owner_user_id uuid REFERENCES user_account(id) ON DELETE SET NULL,
        due_date date,
        status varchar(6) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
        done_at timestamptz(3)
      )`);
    await q.query(`CREATE INDEX ix_action_owner ON meeting_action (owner_user_id, status)`);

    // ------------------------------------------------------------------ calendar feeds and SMS
    await q.query(`
      CREATE TABLE calendar_feed_token (
        user_id uuid PRIMARY KEY REFERENCES user_account(id) ON DELETE CASCADE,
        token_hash char(64) NOT NULL UNIQUE,
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        last_used_at timestamptz(3)
      )`);
    await q.query(`
      CREATE TABLE sms_outbox (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
        user_id uuid REFERENCES user_account(id) ON DELETE SET NULL,
        phone varchar(30) NOT NULL,
        body varchar(640) NOT NULL,
        status varchar(8) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
        attempts int NOT NULL DEFAULT 0,
        next_attempt_at timestamptz(3) NOT NULL DEFAULT now(),
        provider_message_id varchar(100),
        last_error varchar(500),
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        sent_at timestamptz(3)
      )`);
    await q.query(`CREATE INDEX ix_sms_due ON sms_outbox (next_attempt_at) WHERE status = 'pending'`);

    // ------------------------------------------------------------------ travel and expenses
    await q.query(`
      CREATE TABLE travel_request (${base},
        number varchar(40) NOT NULL UNIQUE,
        employee_id uuid NOT NULL REFERENCES employee(id) ON DELETE RESTRICT,
        purpose varchar(1000) NOT NULL,
        destination varchar(200) NOT NULL,
        depart_on date NOT NULL,
        return_on date NOT NULL,
        estimated_cost ${money} NOT NULL DEFAULT 0 CHECK (estimated_cost >= 0),
        advance ${money} NOT NULL DEFAULT 0 CHECK (advance >= 0),
        advance_period char(7),
        status varchar(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'returned', 'cancelled')),
        decision_comment varchar(1000),
        workflow_instance_id uuid REFERENCES workflow_instance(id) ON DELETE RESTRICT,
        CONSTRAINT ck_trip_dates CHECK (return_on >= depart_on),
        CONSTRAINT ck_trip_advance CHECK (advance <= estimated_cost)
      )`);
    await q.query(`
      CREATE TABLE expense_claim (${base},
        number varchar(40) NOT NULL UNIQUE,
        employee_id uuid NOT NULL REFERENCES employee(id) ON DELETE RESTRICT,
        travel_request_id uuid REFERENCES travel_request(id) ON DELETE RESTRICT,
        title varchar(200) NOT NULL,
        total ${money} NOT NULL DEFAULT 0,
        advance_offset ${money} NOT NULL DEFAULT 0,
        status varchar(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'approved', 'rejected', 'returned', 'cancelled')),
        paid_period char(7),
        decision_comment varchar(1000),
        workflow_instance_id uuid REFERENCES workflow_instance(id) ON DELETE RESTRICT
      )`);
    await q.query(`CREATE UNIQUE INDEX ux_claim_per_trip ON expense_claim (travel_request_id) WHERE travel_request_id IS NOT NULL AND status NOT IN ('rejected', 'cancelled')`);
    await q.query(`
      CREATE TABLE expense_item (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
        claim_id uuid NOT NULL REFERENCES expense_claim(id) ON DELETE CASCADE,
        spent_on date NOT NULL,
        category varchar(14) NOT NULL CHECK (category IN ('transport', 'accommodation', 'meals', 'per_diem', 'fuel', 'registration', 'supplies', 'other')),
        description varchar(300) NOT NULL,
        amount ${money} NOT NULL CHECK (amount > 0),
        receipt_document_id uuid REFERENCES document(id) ON DELETE RESTRICT
      )`);
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const t of ['expense_item', 'expense_claim', 'travel_request', 'sms_outbox', 'calendar_feed_token', 'meeting_action', 'meeting_attendee', 'meeting', 'meeting_room', 'policy_acknowledgement']) await q.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
    await q.query(`ALTER TABLE IF EXISTS policy_document DROP CONSTRAINT IF EXISTS fk_policy_current`);
    for (const t of ['policy_version', 'policy_document', 'announcement']) await q.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
  }
}
