import { pool } from "./db.js";

export async function initCarbonmarkSandboxCertificationDb():Promise<void>{
  await pool.query(`
    CREATE TABLE IF NOT EXISTS carbonmark_sandbox_certifications(
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      monitored_asset_id BIGINT NOT NULL REFERENCES monitored_assets(id) ON DELETE RESTRICT,
      asset_price_source_id VARCHAR(255) NOT NULL,
      requested_kg BIGINT NOT NULL CHECK(requested_kg>0),
      quote_uuid VARCHAR(255) NOT NULL UNIQUE,
      cost_usdc NUMERIC(18,6) NOT NULL CHECK(cost_usdc>0),
      beneficiary_name VARCHAR(255) NOT NULL,
      retirement_message VARCHAR(500) NOT NULL,
      status VARCHAR(40) NOT NULL CHECK(status IN ('processing','completed','failed')),
      provider_reference TEXT,
      retirement_id TEXT,
      retirement_tx_hash TEXT,
      retirement_url TEXT,
      certificate_url TEXT,
      provenance_url TEXT,
      api_version VARCHAR(20) NOT NULL DEFAULT 'v18',
      environment VARCHAR(30) NOT NULL DEFAULT 'sandbox',
      executed_by VARCHAR(255) NOT NULL,
      execution_snapshot JSONB NOT NULL,
      provider_snapshot JSONB NOT NULL,
      certification_sha256 VARCHAR(64) NOT NULL CHECK(char_length(certification_sha256)=64),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS carbonmark_sandbox_certification_events(
      id BIGSERIAL PRIMARY KEY,
      certification_id BIGINT NOT NULL REFERENCES carbonmark_sandbox_certifications(id) ON DELETE RESTRICT,
      event_type VARCHAR(80) NOT NULL,
      actor VARCHAR(255),
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE OR REPLACE FUNCTION ecotracker_guard_carbonmark_sandbox_certification_mutation()
    RETURNS TRIGGER AS $$ BEGIN
      IF OLD.status='completed' THEN RAISE EXCEPTION 'completed_carbonmark_sandbox_certification_is_immutable'; END IF;
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'carbonmark_sandbox_certification_delete_forbidden'; END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS guard_carbonmark_sandbox_certification_mutation ON carbonmark_sandbox_certifications;
    CREATE TRIGGER guard_carbonmark_sandbox_certification_mutation
      BEFORE UPDATE OR DELETE ON carbonmark_sandbox_certifications
      FOR EACH ROW EXECUTE FUNCTION ecotracker_guard_carbonmark_sandbox_certification_mutation();

    CREATE INDEX IF NOT EXISTS carbonmark_sandbox_cert_asset_idx ON carbonmark_sandbox_certifications(monitored_asset_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS carbonmark_sandbox_cert_status_idx ON carbonmark_sandbox_certifications(status,created_at DESC);
  `);
}
