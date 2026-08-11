import { pool } from "./db.js";

export async function initEligibilityReviewDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS asset_eligibility_reviews (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      asset_id BIGINT NOT NULL REFERENCES monitored_assets(id) ON DELETE RESTRICT,
      review_version INTEGER NOT NULL CHECK (review_version > 0),
      status VARCHAR(30) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','approved','rejected','stale')),
      purpose VARCHAR(40) NOT NULL DEFAULT 'voluntary_offset',
      base_fingerprint VARCHAR(64) NOT NULL,
      proposed_snapshot JSONB NOT NULL,
      proposed_sha256 VARCHAR(64) NOT NULL,
      preview_decision JSONB NOT NULL DEFAULT '{}'::jsonb,
      review_note TEXT,
      rejection_reason TEXT,
      reviewed_by VARCHAR(255),
      approved_at TIMESTAMPTZ,
      rejected_at TIMESTAMPTZ,
      stale_at TIMESTAMPTZ,
      applied_snapshot JSONB,
      applied_sha256 VARCHAR(64),
      decision JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(asset_id,review_version),
      CHECK (char_length(base_fingerprint)=64),
      CHECK (char_length(proposed_sha256)=64),
      CHECK (applied_sha256 IS NULL OR char_length(applied_sha256)=64),
      CHECK (
        (status='pending' AND approved_at IS NULL AND rejected_at IS NULL AND stale_at IS NULL)
        OR (status='approved' AND reviewed_by IS NOT NULL AND approved_at IS NOT NULL AND applied_snapshot IS NOT NULL AND applied_sha256 IS NOT NULL AND decision IS NOT NULL)
        OR (status='rejected' AND reviewed_by IS NOT NULL AND rejected_at IS NOT NULL AND rejection_reason IS NOT NULL)
        OR (status='stale' AND stale_at IS NOT NULL)
      )
    );

    CREATE UNIQUE INDEX IF NOT EXISTS asset_eligibility_one_pending_review_idx
      ON asset_eligibility_reviews(asset_id)
      WHERE status='pending';

    CREATE TABLE IF NOT EXISTS asset_eligibility_review_events (
      id BIGSERIAL PRIMARY KEY,
      event_key UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      review_id BIGINT NOT NULL REFERENCES asset_eligibility_reviews(id) ON DELETE CASCADE,
      asset_id BIGINT NOT NULL REFERENCES monitored_assets(id) ON DELETE RESTRICT,
      event_type VARCHAR(80) NOT NULL,
      actor VARCHAR(255),
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE OR REPLACE FUNCTION ecotracker_guard_decided_eligibility_review()
    RETURNS TRIGGER AS $$
    BEGIN
      IF OLD.status IN ('approved','rejected','stale') THEN
        RAISE EXCEPTION 'decided_eligibility_review_is_immutable';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS guard_decided_eligibility_review ON asset_eligibility_reviews;
    CREATE TRIGGER guard_decided_eligibility_review
      BEFORE UPDATE OR DELETE ON asset_eligibility_reviews
      FOR EACH ROW
      WHEN (OLD.status IN ('approved','rejected','stale'))
      EXECUTE FUNCTION ecotracker_guard_decided_eligibility_review();

    CREATE INDEX IF NOT EXISTS asset_eligibility_reviews_pipeline_idx
      ON asset_eligibility_reviews(status,created_at DESC);
    CREATE INDEX IF NOT EXISTS asset_eligibility_review_events_review_idx
      ON asset_eligibility_review_events(review_id,created_at DESC);
  `);
}
