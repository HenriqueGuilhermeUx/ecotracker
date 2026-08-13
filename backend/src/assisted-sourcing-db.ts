import { pool } from "./db.js";

export async function initAssistedSourcingDb(): Promise<void> {
  await pool.query(`
    ALTER TABLE quote_requests
      ADD COLUMN IF NOT EXISTS sourcing_completed_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS retirement_proofs (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      quote_id BIGINT NOT NULL UNIQUE REFERENCES quote_requests(id) ON DELETE CASCADE,
      registry VARCHAR(120) NOT NULL,
      retirement_reference VARCHAR(1000) NOT NULL,
      transaction_hash VARCHAR(255),
      beneficiary VARCHAR(255),
      amount_kg NUMERIC(16,3) NOT NULL CHECK (amount_kg > 0),
      evidence_url TEXT,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS assisted_quote_reviews (
      id BIGSERIAL PRIMARY KEY,
      quote_id BIGINT NOT NULL UNIQUE REFERENCES quote_requests(id) ON DELETE CASCADE,
      status VARCHAR(20) NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','rejected')),
      reviewed_by VARCHAR(255) NOT NULL,
      review_note TEXT,
      snapshot JSONB NOT NULL,
      snapshot_sha256 VARCHAR(64) NOT NULL,
      approved_at TIMESTAMPTZ,
      rejected_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS client_agreements (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      quote_id BIGINT NOT NULL REFERENCES quote_requests(id) ON DELETE CASCADE,
      version INTEGER NOT NULL CHECK (version > 0),
      status VARCHAR(30) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','awaiting_signature','accepted','rejected','superseded')),
      language VARCHAR(10) NOT NULL DEFAULT 'pt-BR',
      agreement_type VARCHAR(80) NOT NULL DEFAULT 'carbon_credit_purchase_retirement',
      template_version VARCHAR(80) NOT NULL,
      commercial_review_sha256 VARCHAR(64) NOT NULL,
      quote_snapshot_sha256 VARCHAR(64) NOT NULL,
      snapshot JSONB NOT NULL,
      snapshot_sha256 VARCHAR(64) NOT NULL,
      document_html TEXT NOT NULL,
      document_sha256 VARCHAR(64) NOT NULL,
      provider_identity JSONB NOT NULL,
      generated_by VARCHAR(255),
      accepted_by_name VARCHAR(255),
      accepted_by_email VARCHAR(320),
      accepted_by_title VARCHAR(255),
      acceptance_ip TEXT,
      acceptance_user_agent TEXT,
      acceptance_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
      acceptance_sha256 VARCHAR(64),
      accepted_at TIMESTAMPTZ,
      rejected_at TIMESTAMPTZ,
      superseded_at TIMESTAMPTZ,
      superseded_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(quote_id,version)
    );

    CREATE OR REPLACE FUNCTION ecotracker_guard_assisted_source_jobs()
    RETURNS TRIGGER AS $$
    DECLARE
      enabled BOOLEAN;
    BEGIN
      SELECT COALESCE(automation_enabled,FALSE) INTO enabled
      FROM quote_requests
      WHERE id=NEW.quote_id;

      IF enabled=FALSE AND NEW.job_type IN ('source_asset','retire_asset') THEN
        NEW.status := 'blocked';
        NEW.completed_at := NOW();
        NEW.last_error := 'quote_automation_disabled_assisted';
        NEW.result := COALESCE(NEW.result,'{}'::jsonb) || jsonb_build_object(
          'blockedBy','assisted_sourcing_guard',
          'reason','quote_automation_disabled'
        );

        INSERT INTO commerce_events(event_key,quote_id,event_type,provider,payload)
        VALUES(
          CONCAT('assisted-guard:',NEW.quote_id,':',NEW.job_type),
          NEW.quote_id,
          'automation.blocked_assisted_source_job',
          'ecotracker',
          jsonb_build_object('jobType',NEW.job_type,'reason','quote_automation_disabled')
        )
        ON CONFLICT(event_key) DO NOTHING;
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS guard_assisted_source_jobs_before_insert ON automation_jobs;
    CREATE TRIGGER guard_assisted_source_jobs_before_insert
      BEFORE INSERT ON automation_jobs
      FOR EACH ROW EXECUTE FUNCTION ecotracker_guard_assisted_source_jobs();

    CREATE INDEX IF NOT EXISTS quote_requests_assisted_ops_idx
      ON quote_requests(automation_enabled,payment_status,status,created_at DESC);
    CREATE INDEX IF NOT EXISTS retirement_proofs_registry_idx
      ON retirement_proofs(registry,created_at DESC);
    CREATE INDEX IF NOT EXISTS assisted_quote_reviews_status_idx
      ON assisted_quote_reviews(status,created_at DESC);
    CREATE INDEX IF NOT EXISTS client_agreements_quote_idx
      ON client_agreements(quote_id,version DESC);
    CREATE INDEX IF NOT EXISTS client_agreements_status_idx
      ON client_agreements(status,created_at DESC);
  `);
}
