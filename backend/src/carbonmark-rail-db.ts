import { pool } from "./db.js";

export async function initCarbonmarkRailDb():Promise<void>{
  await pool.query(`
    CREATE TABLE IF NOT EXISTS carbonmark_shadow_quotes(
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      monitored_asset_id BIGINT NOT NULL REFERENCES monitored_assets(id) ON DELETE RESTRICT,
      asset_price_source_id VARCHAR(255) NOT NULL,
      requested_kg BIGINT NOT NULL CHECK(requested_kg>0),
      requested_tonnes NUMERIC(18,6) NOT NULL CHECK(requested_tonnes>0),
      quote_uuid VARCHAR(255) NOT NULL UNIQUE,
      cost_usdc NUMERIC(18,6) NOT NULL CHECK(cost_usdc>0),
      cost_usdc_tonne NUMERIC(18,6) NOT NULL CHECK(cost_usdc_tonne>0),
      environment VARCHAR(30) NOT NULL,
      api_version VARCHAR(20) NOT NULL DEFAULT 'v18',
      created_by VARCHAR(255) NOT NULL,
      observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      provider_snapshot JSONB NOT NULL,
      probe_snapshot JSONB NOT NULL,
      probe_sha256 VARCHAR(64) NOT NULL CHECK(char_length(probe_sha256)=64),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS carbonmark_rail_events(
      id BIGSERIAL PRIMARY KEY,
      event_key UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      shadow_quote_id BIGINT REFERENCES carbonmark_shadow_quotes(id) ON DELETE RESTRICT,
      event_type VARCHAR(80) NOT NULL,
      actor VARCHAR(255),
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE OR REPLACE FUNCTION ecotracker_guard_carbonmark_shadow_quote_mutation()
    RETURNS TRIGGER AS $$ BEGIN
      RAISE EXCEPTION 'carbonmark_shadow_quote_is_immutable';
    END; $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS guard_carbonmark_shadow_quote_mutation ON carbonmark_shadow_quotes;
    CREATE TRIGGER guard_carbonmark_shadow_quote_mutation
      BEFORE UPDATE OR DELETE ON carbonmark_shadow_quotes
      FOR EACH ROW EXECUTE FUNCTION ecotracker_guard_carbonmark_shadow_quote_mutation();

    CREATE INDEX IF NOT EXISTS carbonmark_shadow_quotes_asset_idx ON carbonmark_shadow_quotes(monitored_asset_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS carbonmark_shadow_quotes_observed_idx ON carbonmark_shadow_quotes(observed_at DESC);
    CREATE INDEX IF NOT EXISTS carbonmark_rail_events_quote_idx ON carbonmark_rail_events(shadow_quote_id,created_at DESC);
  `);
}
