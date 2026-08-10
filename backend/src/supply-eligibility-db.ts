import { pool } from "./db.js";

export async function initSupplyEligibilityDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS supply_eligibility_reviews (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      intake_review_id BIGINT NOT NULL UNIQUE REFERENCES supply_intake_reviews(id) ON DELETE RESTRICT,
      monitored_asset_id BIGINT NOT NULL UNIQUE REFERENCES monitored_assets(id) ON DELETE RESTRICT,
      asset_eligibility_review_id BIGINT UNIQUE REFERENCES asset_eligibility_reviews(id) ON DELETE RESTRICT,
      rfq_id BIGINT NOT NULL REFERENCES market_maker_rfqs(id) ON DELETE RESTRICT,
      opportunity_id BIGINT NOT NULL REFERENCES demand_opportunities(id) ON DELETE RESTRICT,
      status VARCHAR(30) NOT NULL CHECK (status IN ('approved','restricted')),
      eligibility_basis TEXT NOT NULL,
      source_unit_status VARCHAR(30) NOT NULL,
      ccp_status VARCHAR(30) NOT NULL DEFAULT 'not_assessed',
      vintage_policy_override BOOLEAN NOT NULL DEFAULT FALSE,
      vintage_exception_reason TEXT,
      risk_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
      reviewed_by VARCHAR(255) NOT NULL,
      reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      review_snapshot JSONB NOT NULL,
      review_sha256 VARCHAR(64) NOT NULL,
      matching_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT supply_eligibility_sha_len CHECK (char_length(review_sha256)=64),
      CONSTRAINT supply_eligibility_vintage_exception CHECK (
        vintage_policy_override=FALSE OR NULLIF(BTRIM(vintage_exception_reason),'') IS NOT NULL
      )
    );

    ALTER TABLE supply_eligibility_reviews
      ADD COLUMN IF NOT EXISTS asset_eligibility_review_id BIGINT;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname='supply_eligibility_reviews_asset_eligibility_review_fk'
      ) THEN
        ALTER TABLE supply_eligibility_reviews
          ADD CONSTRAINT supply_eligibility_reviews_asset_eligibility_review_fk
          FOREIGN KEY(asset_eligibility_review_id)
          REFERENCES asset_eligibility_reviews(id) ON DELETE RESTRICT;
      END IF;
    END $$;

    CREATE UNIQUE INDEX IF NOT EXISTS supply_eligibility_reviews_asset_review_uidx
      ON supply_eligibility_reviews(asset_eligibility_review_id)
      WHERE asset_eligibility_review_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS supply_eligibility_events (
      id BIGSERIAL PRIMARY KEY,
      event_key UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      review_id BIGINT NOT NULL REFERENCES supply_eligibility_reviews(id) ON DELETE RESTRICT,
      event_type VARCHAR(80) NOT NULL,
      actor VARCHAR(255),
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE OR REPLACE FUNCTION ecotracker_guard_supply_eligibility_review_mutation()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION 'supply_eligibility_review_is_immutable';
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS guard_supply_eligibility_review_mutation ON supply_eligibility_reviews;
    CREATE TRIGGER guard_supply_eligibility_review_mutation
      BEFORE UPDATE OR DELETE ON supply_eligibility_reviews
      FOR EACH ROW EXECUTE FUNCTION ecotracker_guard_supply_eligibility_review_mutation();

    CREATE INDEX IF NOT EXISTS supply_eligibility_reviews_status_idx
      ON supply_eligibility_reviews(status,reviewed_at DESC);
    CREATE INDEX IF NOT EXISTS supply_eligibility_reviews_rfq_idx
      ON supply_eligibility_reviews(rfq_id,reviewed_at DESC);
    CREATE INDEX IF NOT EXISTS supply_eligibility_events_review_idx
      ON supply_eligibility_events(review_id,created_at DESC);
  `);
}
