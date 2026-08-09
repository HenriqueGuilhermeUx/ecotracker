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
  `);
}
