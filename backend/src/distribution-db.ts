import { pool } from "./db.js";

export async function initDistributionDb():Promise<void>{
  await pool.query(`
    CREATE TABLE IF NOT EXISTS distribution_mandate_amendments(
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      mandate_id BIGINT NOT NULL REFERENCES supplier_mandates(id) ON DELETE RESTRICT,
      before_channels JSONB NOT NULL,
      after_channels JSONB NOT NULL,
      evidence_url TEXT NOT NULL,
      note TEXT NOT NULL,
      amended_by VARCHAR(255) NOT NULL,
      amended_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      amendment_snapshot JSONB NOT NULL,
      amendment_sha256 VARCHAR(64) NOT NULL CHECK(char_length(amendment_sha256)=64)
    );

    CREATE TABLE IF NOT EXISTS distribution_deployments(
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      inventory_id BIGINT NOT NULL REFERENCES supply_inventory(id) ON DELETE RESTRICT,
      mandate_id BIGINT NOT NULL REFERENCES supplier_mandates(id) ON DELETE RESTRICT,
      monitored_asset_id BIGINT NOT NULL REFERENCES monitored_assets(id) ON DELETE RESTRICT,
      eligibility_review_id BIGINT NOT NULL REFERENCES supply_eligibility_reviews(id) ON DELETE RESTRICT,
      revision INTEGER NOT NULL CHECK(revision>0),
      requested_channels JSONB NOT NULL,
      advertised_tonnes NUMERIC(18,3) NOT NULL CHECK(advertised_tonnes>0),
      floor_price_usd_tonne NUMERIC(14,4),
      markup_pct NUMERIC(8,3) NOT NULL DEFAULT 15 CHECK(markup_pct>=0 AND markup_pct<=500),
      ask_price_usd_tonne NUMERIC(14,4) NOT NULL CHECK(ask_price_usd_tonne>0),
      prepared_by VARCHAR(255) NOT NULL,
      prepared_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deployment_snapshot JSONB NOT NULL,
      deployment_sha256 VARCHAR(64) NOT NULL CHECK(char_length(deployment_sha256)=64),
      UNIQUE(inventory_id,revision)
    );

    CREATE TABLE IF NOT EXISTS distribution_events(
      id BIGSERIAL PRIMARY KEY,
      event_key UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      inventory_id BIGINT NOT NULL REFERENCES supply_inventory(id) ON DELETE RESTRICT,
      deployment_id BIGINT REFERENCES distribution_deployments(id) ON DELETE RESTRICT,
      channel VARCHAR(40),
      event_type VARCHAR(80) NOT NULL,
      actor VARCHAR(255),
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE OR REPLACE FUNCTION ecotracker_guard_distribution_audit_mutation()
    RETURNS TRIGGER AS $$ BEGIN
      RAISE EXCEPTION 'distribution_audit_record_is_immutable';
    END; $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS guard_distribution_deployment_mutation ON distribution_deployments;
    CREATE TRIGGER guard_distribution_deployment_mutation
      BEFORE UPDATE OR DELETE ON distribution_deployments
      FOR EACH ROW EXECUTE FUNCTION ecotracker_guard_distribution_audit_mutation();

    DROP TRIGGER IF EXISTS guard_distribution_amendment_mutation ON distribution_mandate_amendments;
    CREATE TRIGGER guard_distribution_amendment_mutation
      BEFORE UPDATE OR DELETE ON distribution_mandate_amendments
      FOR EACH ROW EXECUTE FUNCTION ecotracker_guard_distribution_audit_mutation();

    CREATE INDEX IF NOT EXISTS distribution_deployments_inventory_idx ON distribution_deployments(inventory_id,revision DESC);
    CREATE INDEX IF NOT EXISTS distribution_events_inventory_idx ON distribution_events(inventory_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS distribution_amendments_mandate_idx ON distribution_mandate_amendments(mandate_id,amended_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS supply_reservation_external_order_uniq
      ON supply_reservations(inventory_id,channel,external_order_id)
      WHERE external_order_id IS NOT NULL;
  `);
}
