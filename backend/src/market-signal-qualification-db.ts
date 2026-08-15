import { pool } from "./db.js";

export async function initMarketSignalQualificationDb():Promise<void>{
  await pool.query(`
    CREATE TABLE IF NOT EXISTS market_signal_qualifications(
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      monitored_asset_id BIGINT NOT NULL REFERENCES monitored_assets(id) ON DELETE RESTRICT,
      rfq_id BIGINT REFERENCES market_maker_rfqs(id) ON DELETE SET NULL,
      candidate_id BIGINT REFERENCES market_maker_rfq_candidates(id) ON DELETE SET NULL,
      opportunity_id BIGINT REFERENCES demand_opportunities(id) ON DELETE SET NULL,
      provider VARCHAR(80) NOT NULL,
      status VARCHAR(40) NOT NULL CHECK(status IN ('probed','diagnostic_only','probe_failed','eligibility_review','qualified','restricted')),
      requested_kg BIGINT NOT NULL CHECK(requested_kg>0),
      probed_kg BIGINT NOT NULL CHECK(probed_kg>0),
      commercial_volume_proven BOOLEAN NOT NULL DEFAULT FALSE,
      shadow_quote_id BIGINT REFERENCES carbonmark_shadow_quotes(id) ON DELETE RESTRICT,
      provider_quote_uuid VARCHAR(255),
      provider_cost_usdc_tonne NUMERIC(18,6),
      observed_available_tonnes NUMERIC(18,6),
      evidence_url TEXT,
      created_by VARCHAR(255) NOT NULL,
      probe_snapshot JSONB NOT NULL,
      probe_sha256 VARCHAR(64) NOT NULL CHECK(char_length(probe_sha256)=64),
      approval_snapshot JSONB,
      approval_sha256 VARCHAR(64),
      submitted_for_review_at TIMESTAMPTZ,
      qualified_at TIMESTAMPTZ,
      restricted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK((approval_sha256 IS NULL) OR char_length(approval_sha256)=64)
    );

    CREATE TABLE IF NOT EXISTS market_signal_qualification_events(
      id BIGSERIAL PRIMARY KEY,
      event_key UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      qualification_id BIGINT NOT NULL REFERENCES market_signal_qualifications(id) ON DELETE RESTRICT,
      event_type VARCHAR(80) NOT NULL,
      actor VARCHAR(255),
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE OR REPLACE FUNCTION ecotracker_guard_market_signal_qualification_event_mutation()
    RETURNS TRIGGER AS $$ BEGIN
      RAISE EXCEPTION 'market_signal_qualification_event_is_immutable';
    END; $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS guard_market_signal_qualification_event_mutation ON market_signal_qualification_events;
    CREATE TRIGGER guard_market_signal_qualification_event_mutation
      BEFORE UPDATE OR DELETE ON market_signal_qualification_events
      FOR EACH ROW EXECUTE FUNCTION ecotracker_guard_market_signal_qualification_event_mutation();

    CREATE INDEX IF NOT EXISTS market_signal_qualifications_asset_idx ON market_signal_qualifications(monitored_asset_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS market_signal_qualifications_status_idx ON market_signal_qualifications(status,updated_at DESC);
    CREATE INDEX IF NOT EXISTS market_signal_qualifications_rfq_idx ON market_signal_qualifications(rfq_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS market_signal_qualification_events_idx ON market_signal_qualification_events(qualification_id,created_at DESC);
  `);
}
