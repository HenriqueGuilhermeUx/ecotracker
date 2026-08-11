import { pool } from "./db.js";

export async function initExecutionReadinessDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS asset_execution_readiness_reviews (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      asset_id BIGINT NOT NULL REFERENCES monitored_assets(id) ON DELETE RESTRICT,
      review_version INTEGER NOT NULL CHECK (review_version > 0),
      status VARCHAR(30) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','approved','rejected','stale')),
      execution_mode VARCHAR(30) NOT NULL DEFAULT 'programmatic'
        CHECK (execution_mode IN ('programmatic','assisted_manual')),
      source_adapter VARCHAR(50) NOT NULL DEFAULT 'external_http_executor',
      retirement_adapter VARCHAR(50) NOT NULL DEFAULT 'external_http_executor',
      supplier_settlement_mode VARCHAR(40) NOT NULL
        CHECK (supplier_settlement_mode IN ('supplier_invoice','prepaid','postpaid','manual_contract')),
      proof_sla_hours INTEGER NOT NULL CHECK (proof_sla_hours BETWEEN 1 AND 720),
      authorization_ttl_hours INTEGER NOT NULL CHECK (authorization_ttl_hours BETWEEN 1 AND 168),
      base_fingerprint VARCHAR(64) NOT NULL,
      config_fingerprint VARCHAR(64) NOT NULL,
      proposed_snapshot JSONB NOT NULL,
      proposed_sha256 VARCHAR(64) NOT NULL,
      source_probe JSONB NOT NULL DEFAULT '{}'::jsonb,
      retirement_probe JSONB NOT NULL DEFAULT '{}'::jsonb,
      preview JSONB NOT NULL DEFAULT '{}'::jsonb,
      review_note TEXT,
      rejection_reason TEXT,
      reviewed_by VARCHAR(255),
      approved_at TIMESTAMPTZ,
      rejected_at TIMESTAMPTZ,
      stale_at TIMESTAMPTZ,
      applied_snapshot JSONB,
      applied_sha256 VARCHAR(64),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(asset_id,review_version),
      CHECK (
        (status='pending' AND approved_at IS NULL AND rejected_at IS NULL AND stale_at IS NULL)
        OR (status='approved' AND reviewed_by IS NOT NULL AND approved_at IS NOT NULL AND applied_snapshot IS NOT NULL AND applied_sha256 IS NOT NULL)
        OR (status='rejected' AND reviewed_by IS NOT NULL AND rejected_at IS NOT NULL AND rejection_reason IS NOT NULL)
        OR (status='stale' AND stale_at IS NOT NULL)
      )
    );

    CREATE UNIQUE INDEX IF NOT EXISTS asset_execution_readiness_one_pending_idx
      ON asset_execution_readiness_reviews(asset_id)
      WHERE status='pending';

    CREATE TABLE IF NOT EXISTS asset_execution_authorizations (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      asset_id BIGINT NOT NULL UNIQUE REFERENCES monitored_assets(id) ON DELETE RESTRICT,
      review_id BIGINT NOT NULL REFERENCES asset_execution_readiness_reviews(id) ON DELETE RESTRICT,
      status VARCHAR(30) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','revoked','expired')),
      execution_mode VARCHAR(30) NOT NULL CHECK (execution_mode='programmatic'),
      source_adapter VARCHAR(50) NOT NULL,
      retirement_adapter VARCHAR(50) NOT NULL,
      supplier_settlement_mode VARCHAR(40) NOT NULL,
      proof_sla_hours INTEGER NOT NULL CHECK (proof_sla_hours BETWEEN 1 AND 720),
      config_fingerprint VARCHAR(64) NOT NULL,
      authorized_by VARCHAR(255) NOT NULL,
      authorized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      valid_until TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      revoke_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS asset_execution_readiness_events (
      id BIGSERIAL PRIMARY KEY,
      event_key UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      asset_id BIGINT NOT NULL REFERENCES monitored_assets(id) ON DELETE RESTRICT,
      review_id BIGINT REFERENCES asset_execution_readiness_reviews(id) ON DELETE SET NULL,
      authorization_id BIGINT REFERENCES asset_execution_authorizations(id) ON DELETE SET NULL,
      event_type VARCHAR(80) NOT NULL,
      actor VARCHAR(255),
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE OR REPLACE FUNCTION ecotracker_guard_decided_execution_review()
    RETURNS TRIGGER AS $$
    BEGIN
      IF OLD.status IN ('approved','rejected','stale') THEN
        RAISE EXCEPTION 'decided_execution_readiness_review_is_immutable';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS guard_decided_execution_review ON asset_execution_readiness_reviews;
    CREATE TRIGGER guard_decided_execution_review
      BEFORE UPDATE ON asset_execution_readiness_reviews
      FOR EACH ROW
      WHEN (OLD.status IN ('approved','rejected','stale'))
      EXECUTE FUNCTION ecotracker_guard_decided_execution_review();

    CREATE OR REPLACE FUNCTION ecotracker_guard_supply_intake_execution_enable()
    RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.sourcing_executable=TRUE
         AND COALESCE(OLD.sourcing_executable,FALSE)=FALSE
         AND NEW.source_reference LIKE 'supply-intake:%' THEN
        IF NOT EXISTS (
          SELECT 1 FROM asset_execution_authorizations x
          WHERE x.asset_id=NEW.id
            AND x.status='active'
            AND x.execution_mode='programmatic'
            AND x.valid_until>NOW()
        ) THEN
          RAISE EXCEPTION 'execution_readiness_authorization_required';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS guard_supply_intake_execution_enable ON monitored_assets;
    CREATE TRIGGER guard_supply_intake_execution_enable
      BEFORE UPDATE OF sourcing_executable ON monitored_assets
      FOR EACH ROW EXECUTE FUNCTION ecotracker_guard_supply_intake_execution_enable();

    CREATE INDEX IF NOT EXISTS asset_execution_readiness_reviews_pipeline_idx
      ON asset_execution_readiness_reviews(status,created_at DESC);
    CREATE INDEX IF NOT EXISTS asset_execution_authorizations_status_idx
      ON asset_execution_authorizations(status,valid_until);
    CREATE INDEX IF NOT EXISTS asset_execution_readiness_events_asset_idx
      ON asset_execution_readiness_events(asset_id,created_at DESC);
  `);
}
