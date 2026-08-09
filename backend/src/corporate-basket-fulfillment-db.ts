import { pool } from "./db.js";

export async function initCorporateBasketFulfillmentDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS corporate_basket_fulfillments (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      basket_id BIGINT NOT NULL UNIQUE REFERENCES corporate_baskets(id) ON DELETE CASCADE,
      status VARCHAR(40) NOT NULL DEFAULT 'pending',
      total_requested_kg BIGINT NOT NULL CHECK (total_requested_kg > 0),
      total_acquired_kg BIGINT NOT NULL DEFAULT 0 CHECK (total_acquired_kg >= 0),
      total_retired_kg BIGINT NOT NULL DEFAULT 0 CHECK (total_retired_kg >= 0),
      beneficiary_name VARCHAR(255),
      beneficiary_tax_id VARCHAR(40),
      beneficiary_email VARCHAR(320),
      evidence_bundle JSONB NOT NULL DEFAULT '{}'::jsonb,
      bundle_sha256 VARCHAR(64),
      review_reason TEXT,
      started_at TIMESTAMPTZ,
      retired_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS corporate_basket_fulfillment_legs (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      fulfillment_id BIGINT NOT NULL REFERENCES corporate_basket_fulfillments(id) ON DELETE CASCADE,
      basket_leg_id BIGINT NOT NULL UNIQUE REFERENCES corporate_basket_legs(id) ON DELETE RESTRICT,
      asset_id BIGINT NOT NULL REFERENCES monitored_assets(id) ON DELETE RESTRICT,
      requested_kg BIGINT NOT NULL CHECK (requested_kg > 0),
      status VARCHAR(40) NOT NULL DEFAULT 'pending_acquisition',
      provider_key VARCHAR(80),
      registry VARCHAR(120) NOT NULL,
      project_name VARCHAR(255) NOT NULL,
      vintage VARCHAR(80),
      source_reference VARCHAR(1000),
      source_tx_hash VARCHAR(255),
      source_evidence_url TEXT,
      acquired_kg BIGINT NOT NULL DEFAULT 0 CHECK (acquired_kg >= 0),
      acquired_at TIMESTAMPTZ,
      retirement_reference VARCHAR(1000),
      retirement_tx_hash VARCHAR(255),
      retirement_evidence_url TEXT,
      certificate_url TEXT,
      retired_kg BIGINT NOT NULL DEFAULT 0 CHECK (retired_kg >= 0),
      beneficiary_name VARCHAR(255),
      beneficiary_tax_id VARCHAR(40),
      retirement_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
      retired_at TIMESTAMPTZ,
      review_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (acquired_kg <= requested_kg),
      CHECK (retired_kg <= requested_kg)
    );

    CREATE TABLE IF NOT EXISTS corporate_basket_ecot_allocations (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      basket_id BIGINT NOT NULL UNIQUE REFERENCES corporate_baskets(id) ON DELETE CASCADE,
      fulfillment_id BIGINT NOT NULL UNIQUE REFERENCES corporate_basket_fulfillments(id) ON DELETE CASCADE,
      amount_kg BIGINT NOT NULL CHECK (amount_kg > 0),
      recipient_name VARCHAR(255),
      recipient_email VARCHAR(320),
      status VARCHAR(30) NOT NULL DEFAULT 'allocated',
      evidence_bundle_sha256 VARCHAR(64) NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      allocated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      delivered_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS corporate_basket_documents (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      basket_id BIGINT NOT NULL REFERENCES corporate_baskets(id) ON DELETE CASCADE,
      document_type VARCHAR(30) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      provider VARCHAR(60),
      provider_reference VARCHAR(255),
      document_url TEXT,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      issued_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(basket_id,document_type)
    );

    CREATE INDEX IF NOT EXISTS corporate_basket_fulfillments_status_idx
      ON corporate_basket_fulfillments(status,updated_at DESC);
    CREATE INDEX IF NOT EXISTS corporate_basket_fulfillment_legs_status_idx
      ON corporate_basket_fulfillment_legs(fulfillment_id,status,id);
    CREATE INDEX IF NOT EXISTS corporate_basket_documents_basket_idx
      ON corporate_basket_documents(basket_id,document_type,status);

    CREATE OR REPLACE FUNCTION ecotracker_guard_fulfillment_leg_volume()
    RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.acquired_kg > NEW.requested_kg OR NEW.retired_kg > NEW.requested_kg THEN
        RAISE EXCEPTION 'Fulfillment leg volume exceeds requested volume';
      END IF;
      IF NEW.status='retired' AND NEW.retired_kg<>NEW.requested_kg THEN
        RAISE EXCEPTION 'Retired fulfillment leg must retire exactly requested volume';
      END IF;
      IF NEW.status='retired' AND (NEW.retirement_reference IS NULL OR NEW.retirement_reference='') THEN
        RAISE EXCEPTION 'Retired fulfillment leg requires retirement reference';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS guard_fulfillment_leg_volume ON corporate_basket_fulfillment_legs;
    CREATE TRIGGER guard_fulfillment_leg_volume
      BEFORE INSERT OR UPDATE ON corporate_basket_fulfillment_legs
      FOR EACH ROW EXECUTE FUNCTION ecotracker_guard_fulfillment_leg_volume();
  `);
}
