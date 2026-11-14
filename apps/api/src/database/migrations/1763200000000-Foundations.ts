import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Slice 1: platform, identity, organisation, documents, outbox and webhooks.
 * Written by hand and reviewed; entities mirror it (synchronize is never used).
 */
export class Foundations1763200000000 implements MigrationInterface {
  name = 'Foundations1763200000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await q.query(`CREATE EXTENSION IF NOT EXISTS btree_gist`);
    await q.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);

    // UUID v7 (RFC 9562): 48-bit Unix ms timestamp, version 7, variant 10, random rest.
    await q.query(`
      CREATE OR REPLACE FUNCTION uuid_generate_v7() RETURNS uuid AS $$
      DECLARE
        ts_ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000);
        bytes bytea := gen_random_bytes(16);
      BEGIN
        bytes := overlay(bytes PLACING substring(int8send(ts_ms) FROM 3) FROM 1 FOR 6);
        bytes := set_byte(bytes, 6, (get_byte(bytes, 6) & 15) | 112);
        bytes := set_byte(bytes, 8, (get_byte(bytes, 8) & 63) | 128);
        RETURN encode(bytes, 'hex')::uuid;
      END
      $$ LANGUAGE plpgsql VOLATILE`);

    // Reusable column fragments.
    const base = `
      id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
      created_at timestamptz(3) NOT NULL DEFAULT now(),
      updated_at timestamptz(3) NOT NULL DEFAULT now(),
      created_by uuid,
      updated_by uuid,
      version int NOT NULL DEFAULT 1`;
    const soft = `${base},
      deleted_at timestamptz(3)`;
    const status = `status varchar(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive'))`;

    // ------------------------------------------------------------------ audit
    await q.query(`
      CREATE TABLE audit_log (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        occurred_at timestamptz(3) NOT NULL DEFAULT now(),
        actor_type varchar(10) NOT NULL CHECK (actor_type IN ('user', 'client', 'system')),
        actor_id uuid,
        actor_name varchar(200),
        action varchar(30) NOT NULL,
        entity_type varchar(100) NOT NULL,
        entity_id varchar(100),
        before jsonb,
        after jsonb,
        ip varchar(64),
        user_agent varchar(300),
        correlation_id varchar(100)
      )`);
    await q.query(`CREATE INDEX ix_audit_entity ON audit_log (entity_type, entity_id)`);
    await q.query(`CREATE INDEX ix_audit_occurred ON audit_log (occurred_at)`);
    await q.query(`CREATE INDEX ix_audit_actor ON audit_log (actor_id)`);
    await q.query(`
      CREATE FUNCTION audit_log_immutable() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'audit_log is append-only (% not allowed)', TG_OP USING ERRCODE = 'insufficient_privilege';
      END
      $$ LANGUAGE plpgsql`);
    await q.query(`CREATE TRIGGER audit_log_no_update_delete BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_immutable()`);
    await q.query(`CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable()`);

    // ------------------------------------------------------------------ settings, numbering, idempotency
    await q.query(`
      CREATE TABLE setting (
        key varchar(100) PRIMARY KEY,
        value jsonb NOT NULL,
        updated_at timestamptz(3) NOT NULL DEFAULT now(),
        updated_by uuid
      )`);
    await q.query(`
      CREATE TABLE numbering_scheme (${base},
        document_type varchar(60) NOT NULL,
        name varchar(200) NOT NULL,
        prefix varchar(20) NOT NULL DEFAULT '',
        format varchar(100) NOT NULL CHECK (position('{SEQ}' IN format) > 0),
        padding int NOT NULL DEFAULT 5 CHECK (padding BETWEEN 1 AND 12),
        reset varchar(10) NOT NULL DEFAULT 'never' CHECK (reset IN ('never', 'yearly')),
        is_active boolean NOT NULL DEFAULT true,
        CONSTRAINT ux_numbering_scheme_type UNIQUE (document_type)
      )`);
    await q.query(`
      CREATE TABLE number_sequence (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
        scheme_id uuid NOT NULL REFERENCES numbering_scheme(id) ON DELETE CASCADE,
        period varchar(10) NOT NULL,
        next_value bigint NOT NULL DEFAULT 1 CHECK (next_value >= 1),
        CONSTRAINT ux_number_sequence UNIQUE (scheme_id, period)
      )`);
    await q.query(`
      CREATE TABLE idempotency_key (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
        actor_key varchar(120) NOT NULL,
        key varchar(200) NOT NULL,
        request_hash char(64) NOT NULL,
        state varchar(20) NOT NULL CHECK (state IN ('in_progress', 'completed')),
        response_status int,
        response_body jsonb,
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        expires_at timestamptz(3) NOT NULL,
        CONSTRAINT ux_idempotency UNIQUE (actor_key, key)
      )`);
    await q.query(`CREATE INDEX ix_idempotency_expires ON idempotency_key (expires_at)`);

    // ------------------------------------------------------------------ organisation
    await q.query(`
      CREATE TABLE organisation (${base},
        code varchar(40) NOT NULL UNIQUE,
        name varchar(200) NOT NULL,
        legal_name varchar(200),
        kra_pin varchar(20),
        nssf_employer_no varchar(40),
        sha_employer_no varchar(40),
        address varchar(500),
        phone varchar(40),
        email varchar(200),
        website varchar(200)
      )`);
    await q.query(`
      CREATE TABLE branch (${soft},
        organisation_id uuid NOT NULL REFERENCES organisation(id) ON DELETE RESTRICT,
        code varchar(40) NOT NULL,
        name varchar(200) NOT NULL,
        address varchar(500),
        city varchar(100),
        county varchar(100),
        phone varchar(40),
        email varchar(200),
        timezone varchar(60),
        ${status}
      )`);
    await q.query(`CREATE UNIQUE INDEX ux_branch_code ON branch (organisation_id, lower(code)) WHERE deleted_at IS NULL`);
    await q.query(`
      CREATE TABLE cost_centre (${soft},
        organisation_id uuid NOT NULL REFERENCES organisation(id) ON DELETE RESTRICT,
        code varchar(40) NOT NULL,
        name varchar(200) NOT NULL,
        description varchar(500),
        ${status}
      )`);
    await q.query(`CREATE UNIQUE INDEX ux_cost_centre_code ON cost_centre (organisation_id, lower(code)) WHERE deleted_at IS NULL`);
    await q.query(`
      CREATE TABLE department (${soft},
        organisation_id uuid NOT NULL REFERENCES organisation(id) ON DELETE RESTRICT,
        branch_id uuid NOT NULL REFERENCES branch(id) ON DELETE RESTRICT,
        parent_id uuid REFERENCES department(id) ON DELETE RESTRICT,
        cost_centre_id uuid REFERENCES cost_centre(id) ON DELETE RESTRICT,
        code varchar(40) NOT NULL,
        name varchar(200) NOT NULL,
        description varchar(1000),
        path uuid[] NOT NULL DEFAULT '{}',
        ${status},
        CONSTRAINT ck_department_not_own_parent CHECK (parent_id IS NULL OR parent_id <> id),
        CONSTRAINT ck_department_path CHECK (NOT (id = ANY(path)))
      )`);
    await q.query(`CREATE UNIQUE INDEX ux_department_code ON department (organisation_id, lower(code)) WHERE deleted_at IS NULL`);
    await q.query(`CREATE INDEX ix_department_path ON department USING gin (path)`);
    await q.query(`CREATE INDEX ix_department_branch ON department (branch_id)`);
    await q.query(`CREATE INDEX ix_department_parent ON department (parent_id)`);
    await q.query(`
      CREATE TABLE job_grade (${soft},
        organisation_id uuid NOT NULL REFERENCES organisation(id) ON DELETE RESTRICT,
        code varchar(40) NOT NULL,
        name varchar(200) NOT NULL,
        rank int NOT NULL CHECK (rank >= 0),
        description varchar(500),
        ${status}
      )`);
    await q.query(`CREATE UNIQUE INDEX ux_job_grade_code ON job_grade (organisation_id, lower(code)) WHERE deleted_at IS NULL`);
    await q.query(`
      CREATE TABLE position (${soft},
        organisation_id uuid NOT NULL REFERENCES organisation(id) ON DELETE RESTRICT,
        department_id uuid NOT NULL REFERENCES department(id) ON DELETE RESTRICT,
        job_grade_id uuid REFERENCES job_grade(id) ON DELETE RESTRICT,
        reports_to_position_id uuid REFERENCES position(id) ON DELETE RESTRICT,
        code varchar(40) NOT NULL,
        title varchar(200) NOT NULL,
        description varchar(2000),
        headcount int NOT NULL DEFAULT 1 CHECK (headcount >= 0),
        is_clinical boolean NOT NULL DEFAULT false,
        licence_required varchar(100),
        ${status},
        CONSTRAINT ck_position_not_self CHECK (reports_to_position_id IS NULL OR reports_to_position_id <> id)
      )`);
    await q.query(`CREATE UNIQUE INDEX ux_position_code ON position (organisation_id, lower(code)) WHERE deleted_at IS NULL`);
    await q.query(`CREATE INDEX ix_position_department ON position (department_id)`);

    // ------------------------------------------------------------------ identity
    await q.query(`
      CREATE TABLE user_account (${soft},
        username varchar(60) NOT NULL,
        display_name varchar(200) NOT NULL,
        email varchar(200),
        phone varchar(40),
        password_hash varchar(255),
        status varchar(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'locked')),
        must_change_password boolean NOT NULL DEFAULT false,
        failed_login_count int NOT NULL DEFAULT 0,
        locked_until timestamptz(3),
        last_login_at timestamptz(3),
        password_changed_at timestamptz(3),
        mfa_enabled boolean NOT NULL DEFAULT false,
        mfa_secret_enc varchar(300),
        external_subject varchar(200),
        employee_id uuid,
        CONSTRAINT ck_user_mfa CHECK (NOT mfa_enabled OR mfa_secret_enc IS NOT NULL)
      )`);
    await q.query(`CREATE UNIQUE INDEX ux_user_username ON user_account (lower(username)) WHERE deleted_at IS NULL`);
    await q.query(`CREATE UNIQUE INDEX ux_user_email ON user_account (lower(email)) WHERE deleted_at IS NULL AND email IS NOT NULL`);
    await q.query(`CREATE UNIQUE INDEX ux_user_employee ON user_account (employee_id) WHERE employee_id IS NOT NULL AND deleted_at IS NULL`);
    await q.query(`CREATE UNIQUE INDEX ux_user_external_subject ON user_account (external_subject) WHERE external_subject IS NOT NULL`);
    await q.query(`CREATE TABLE permission (code varchar(80) PRIMARY KEY, description varchar(300) NOT NULL)`);
    await q.query(`
      CREATE TABLE role (${base},
        code varchar(60) NOT NULL UNIQUE,
        name varchar(200) NOT NULL,
        description varchar(500),
        is_system boolean NOT NULL DEFAULT false
      )`);
    await q.query(`
      CREATE TABLE role_permission (
        role_id uuid NOT NULL REFERENCES role(id) ON DELETE CASCADE,
        permission_code varchar(80) NOT NULL REFERENCES permission(code) ON DELETE CASCADE,
        PRIMARY KEY (role_id, permission_code)
      )`);
    await q.query(`
      CREATE TABLE role_assignment (${base},
        user_id uuid NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
        role_id uuid NOT NULL REFERENCES role(id) ON DELETE RESTRICT,
        scope varchar(20) NOT NULL CHECK (scope IN ('own', 'direct_reports', 'department', 'branch', 'organisation')),
        branch_id uuid REFERENCES branch(id) ON DELETE RESTRICT,
        department_id uuid REFERENCES department(id) ON DELETE RESTRICT,
        CONSTRAINT ck_role_assignment_target CHECK (
          (scope = 'branch' AND branch_id IS NOT NULL AND department_id IS NULL) OR
          (scope = 'department' AND department_id IS NOT NULL AND branch_id IS NULL) OR
          (scope IN ('own', 'direct_reports', 'organisation') AND branch_id IS NULL AND department_id IS NULL))
      )`);
    await q.query(`CREATE UNIQUE INDEX ux_role_assignment ON role_assignment (user_id, role_id, scope, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'), coalesce(department_id, '00000000-0000-0000-0000-000000000000'))`);
    await q.query(`
      CREATE TABLE refresh_token (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
        user_id uuid NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
        token_hash char(64) NOT NULL UNIQUE,
        family_id uuid NOT NULL,
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        expires_at timestamptz(3) NOT NULL,
        used_at timestamptz(3),
        revoked_at timestamptz(3),
        ip varchar(64),
        user_agent varchar(300)
      )`);
    await q.query(`CREATE INDEX ix_refresh_token_user ON refresh_token (user_id)`);
    await q.query(`CREATE INDEX ix_refresh_token_family ON refresh_token (family_id)`);
    await q.query(`
      CREATE TABLE login_history (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
        user_id uuid REFERENCES user_account(id) ON DELETE SET NULL,
        username varchar(200) NOT NULL,
        outcome varchar(20) NOT NULL,
        method varchar(20) NOT NULL,
        ip varchar(64),
        user_agent varchar(300),
        occurred_at timestamptz(3) NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX ix_login_history_user ON login_history (user_id, occurred_at)`);
    await q.query(`CREATE INDEX ix_login_history_time ON login_history (occurred_at)`);
    await q.query(`
      CREATE TABLE mfa_recovery_code (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
        user_id uuid NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
        code_hash char(64) NOT NULL,
        used_at timestamptz(3)
      )`);
    await q.query(`CREATE INDEX ix_mfa_recovery_user ON mfa_recovery_code (user_id)`);
    await q.query(`
      CREATE TABLE ip_allow_rule (${base},
        cidr cidr NOT NULL,
        description varchar(200),
        applies_to varchar(10) NOT NULL DEFAULT 'all' CHECK (applies_to IN ('all', 'admin')),
        is_active boolean NOT NULL DEFAULT true
      )`);
    await q.query(`
      CREATE TABLE api_client (${base},
        client_id varchar(60) NOT NULL UNIQUE,
        name varchar(200) NOT NULL,
        description varchar(500),
        scopes text[] NOT NULL DEFAULT '{}',
        is_active boolean NOT NULL DEFAULT true,
        rate_limit_per_minute int NOT NULL DEFAULT 600 CHECK (rate_limit_per_minute > 0),
        last_used_at timestamptz(3)
      )`);
    await q.query(`
      CREATE TABLE api_client_secret (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
        api_client_id uuid NOT NULL REFERENCES api_client(id) ON DELETE CASCADE,
        secret_hash char(64) NOT NULL UNIQUE,
        prefix varchar(12) NOT NULL,
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        expires_at timestamptz(3),
        revoked_at timestamptz(3),
        last_used_at timestamptz(3)
      )`);
    await q.query(`CREATE INDEX ix_api_client_secret_client ON api_client_secret (api_client_id)`);

    // ------------------------------------------------------------------ external refs, documents
    await q.query(`
      CREATE TABLE external_ref (${base},
        entity_type varchar(60) NOT NULL,
        entity_id uuid NOT NULL,
        system varchar(40) NOT NULL,
        external_id varchar(200) NOT NULL,
        CONSTRAINT ux_external_ref_external UNIQUE (system, entity_type, external_id),
        CONSTRAINT ux_external_ref_entity UNIQUE (entity_type, entity_id, system)
      )`);
    await q.query(`
      CREATE TABLE document (${soft},
        owner_type varchar(60) NOT NULL,
        owner_id uuid,
        category varchar(60),
        title varchar(200) NOT NULL,
        is_sensitive boolean NOT NULL DEFAULT false,
        current_version_id uuid
      )`);
    await q.query(`CREATE INDEX ix_document_owner ON document (owner_type, owner_id)`);
    await q.query(`
      CREATE TABLE document_version (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
        document_id uuid NOT NULL REFERENCES document(id) ON DELETE RESTRICT,
        version_no int NOT NULL CHECK (version_no >= 1),
        object_key varchar(300) NOT NULL UNIQUE,
        file_name varchar(255) NOT NULL,
        mime_type varchar(120) NOT NULL,
        size_bytes bigint NOT NULL CHECK (size_bytes > 0),
        sha256 char(64) NOT NULL,
        scan_status varchar(20) NOT NULL CHECK (scan_status IN ('pending', 'clean', 'infected', 'not_scanned')),
        uploaded_at timestamptz(3) NOT NULL DEFAULT now(),
        uploaded_by uuid,
        CONSTRAINT ux_document_version UNIQUE (document_id, version_no)
      )`);
    await q.query(`ALTER TABLE document ADD CONSTRAINT fk_document_current_version FOREIGN KEY (current_version_id) REFERENCES document_version(id) DEFERRABLE INITIALLY DEFERRED`);

    // ------------------------------------------------------------------ events and webhooks
    await q.query(`
      CREATE TABLE outbox_event (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        event_id uuid NOT NULL UNIQUE DEFAULT uuid_generate_v7(),
        type varchar(100) NOT NULL,
        subject varchar(200) NOT NULL,
        occurred_at timestamptz(3) NOT NULL DEFAULT now(),
        correlation_id varchar(100),
        data jsonb NOT NULL,
        only_subscription_id uuid,
        published_at timestamptz(3),
        attempts int NOT NULL DEFAULT 0,
        last_error varchar(1000)
      )`);
    await q.query(`CREATE INDEX ix_outbox_unpublished ON outbox_event (id) WHERE published_at IS NULL`);
    await q.query(`CREATE INDEX ix_outbox_type ON outbox_event (type, id)`);
    await q.query(`
      CREATE TABLE webhook_subscription (${base},
        name varchar(200) NOT NULL,
        url varchar(500) NOT NULL CHECK (url ~ '^https?://'),
        event_types text[] NOT NULL CHECK (cardinality(event_types) > 0),
        secret_enc varchar(400) NOT NULL,
        secret_prefix varchar(16) NOT NULL,
        status varchar(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'disabled')),
        paused_reason varchar(300),
        consecutive_failures int NOT NULL DEFAULT 0,
        last_delivery_at timestamptz(3)
      )`);
    await q.query(`CREATE INDEX ix_webhook_subscription_types ON webhook_subscription USING gin (event_types)`);
    await q.query(`
      CREATE TABLE webhook_delivery (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
        subscription_id uuid NOT NULL REFERENCES webhook_subscription(id) ON DELETE CASCADE,
        outbox_event_id bigint NOT NULL REFERENCES outbox_event(id) ON DELETE RESTRICT,
        event_id uuid NOT NULL,
        event_type varchar(100) NOT NULL,
        payload jsonb NOT NULL,
        status varchar(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'retrying', 'delivered', 'dead_lettered', 'cancelled')),
        attempt_count int NOT NULL DEFAULT 0,
        next_attempt_at timestamptz(3),
        last_status_code int,
        last_error varchar(1000),
        delivered_at timestamptz(3),
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        CONSTRAINT ux_webhook_delivery_event UNIQUE (subscription_id, outbox_event_id)
      )`);
    await q.query(`CREATE INDEX ix_webhook_delivery_sub ON webhook_delivery (subscription_id, created_at)`);
    await q.query(`CREATE INDEX ix_webhook_delivery_due ON webhook_delivery (next_attempt_at) WHERE status IN ('pending', 'retrying')`);
    await q.query(`
      CREATE TABLE webhook_attempt (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
        delivery_id uuid NOT NULL REFERENCES webhook_delivery(id) ON DELETE CASCADE,
        attempt_no int NOT NULL,
        started_at timestamptz(3) NOT NULL DEFAULT now(),
        duration_ms int NOT NULL,
        status_code int,
        error varchar(1000),
        response_excerpt varchar(500)
      )`);
    await q.query(`CREATE INDEX ix_webhook_attempt_delivery ON webhook_attempt (delivery_id, attempt_no)`);

    // ------------------------------------------------------------------ notifications
    await q.query(`
      CREATE TABLE notification_template (${base},
        code varchar(80) NOT NULL UNIQUE,
        subject varchar(200) NOT NULL,
        body text NOT NULL,
        channels text[] NOT NULL DEFAULT '{in_app,email}',
        description varchar(300)
      )`);
    await q.query(`
      CREATE TABLE notification (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
        user_id uuid NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
        title varchar(200) NOT NULL,
        body text NOT NULL,
        link varchar(300),
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        read_at timestamptz(3)
      )`);
    await q.query(`CREATE INDEX ix_notification_user ON notification (user_id, read_at)`);
    await q.query(`
      CREATE TABLE email_outbox (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
        to_address varchar(300) NOT NULL,
        subject varchar(300) NOT NULL,
        body text NOT NULL,
        status varchar(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
        attempts int NOT NULL DEFAULT 0,
        last_error varchar(1000),
        created_at timestamptz(3) NOT NULL DEFAULT now(),
        sent_at timestamptz(3)
      )`);
    await q.query(`CREATE INDEX ix_email_outbox_pending ON email_outbox (id) WHERE status = 'pending'`);
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const t of [
      'email_outbox', 'notification', 'notification_template', 'webhook_attempt', 'webhook_delivery', 'webhook_subscription', 'outbox_event',
      'document_version', 'document', 'external_ref', 'api_client_secret', 'api_client', 'ip_allow_rule', 'mfa_recovery_code', 'login_history',
      'refresh_token', 'role_assignment', 'role_permission', 'role', 'permission', 'user_account', 'position', 'job_grade', 'department',
      'cost_centre', 'branch', 'organisation', 'idempotency_key', 'number_sequence', 'numbering_scheme', 'setting', 'audit_log',
    ]) {
      await q.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
    }
    await q.query(`DROP FUNCTION IF EXISTS audit_log_immutable()`);
    await q.query(`DROP FUNCTION IF EXISTS uuid_generate_v7()`);
  }
}
