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

    -- Existing deployments already have the immutable trigger. Drop it only
    -- during schema reconciliation so legacy approved rows can receive their
    -- canonical ledger link; it is recreated below before init completes.
    DROP TRIGGER IF EXISTS guard_supply_eligibility_review_mutation ON supply_eligibility_reviews;

    CREATE OR REPLACE FUNCTION ecotracker_link_supply_eligibility_ledger()
    RETURNS TRIGGER AS $$
    DECLARE
      ledger_id BIGINT;
      next_version INTEGER;
      ledger_status VARCHAR(30);
      ledger_decision JSONB;
    BEGIN
      IF NEW.asset_eligibility_review_id IS NOT NULL THEN
        RETURN NEW;
      END IF;

      -- Serialize review-version allocation on the asset row.
      PERFORM 1 FROM monitored_assets WHERE id=NEW.monitored_asset_id FOR UPDATE;
      SELECT COALESCE(MAX(review_version),0)+1 INTO next_version
      FROM asset_eligibility_reviews
      WHERE asset_id=NEW.monitored_asset_id;

      ledger_status := CASE WHEN NEW.status='approved' THEN 'approved' ELSE 'rejected' END;
      ledger_decision := jsonb_build_object(
        'source','supply_eligibility',
        'supplyEligibilityStatus',NEW.status,
        'sourceUnitStatus',NEW.source_unit_status,
        'ccpStatus',NEW.ccp_status,
        'reviewSha256',NEW.review_sha256,
        'executionAuthorization',FALSE
      );

      IF ledger_status='approved' THEN
        INSERT INTO asset_eligibility_reviews(
          asset_id,review_version,status,purpose,base_fingerprint,
          proposed_snapshot,proposed_sha256,preview_decision,review_note,
          reviewed_by,approved_at,applied_snapshot,applied_sha256,decision
        ) VALUES(
          NEW.monitored_asset_id,next_version,'approved','voluntary_offset',NEW.review_sha256,
          NEW.review_snapshot,NEW.review_sha256,ledger_decision,NEW.eligibility_basis,
          NEW.reviewed_by,COALESCE(NEW.reviewed_at,NOW()),NEW.review_snapshot,NEW.review_sha256,ledger_decision
        ) RETURNING id INTO ledger_id;
      ELSE
        INSERT INTO asset_eligibility_reviews(
          asset_id,review_version,status,purpose,base_fingerprint,
          proposed_snapshot,proposed_sha256,preview_decision,review_note,
          rejection_reason,reviewed_by,rejected_at,decision
        ) VALUES(
          NEW.monitored_asset_id,next_version,'rejected','voluntary_offset',NEW.review_sha256,
          NEW.review_snapshot,NEW.review_sha256,ledger_decision,NEW.eligibility_basis,
          NEW.eligibility_basis,NEW.reviewed_by,COALESCE(NEW.reviewed_at,NOW()),ledger_decision
        ) RETURNING id INTO ledger_id;
      END IF;

      INSERT INTO asset_eligibility_review_events(review_id,asset_id,event_type,actor,payload)
      VALUES(
        ledger_id,NEW.monitored_asset_id,
        CASE WHEN NEW.status='approved' THEN 'supply_eligibility_mirrored_approved' ELSE 'supply_eligibility_mirrored_restricted' END,
        NEW.reviewed_by,
        jsonb_build_object('supplyReviewSha256',NEW.review_sha256,'executionAuthorization',FALSE)
      );

      NEW.asset_eligibility_review_id := ledger_id;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS link_supply_eligibility_ledger ON supply_eligibility_reviews;
    CREATE TRIGGER link_supply_eligibility_ledger
      BEFORE INSERT OR UPDATE OF asset_eligibility_review_id ON supply_eligibility_reviews
      FOR EACH ROW EXECUTE FUNCTION ecotracker_link_supply_eligibility_ledger();

    -- Backfill rows created before the canonical ledger existed. The link
    -- trigger fills NEW.asset_eligibility_review_id atomically.
    UPDATE supply_eligibility_reviews
      SET asset_eligibility_review_id=NULL
      WHERE asset_eligibility_review_id IS NULL;

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
