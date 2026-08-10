import { pool } from "./db.js";

export async function initSupplyIntakeDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS supply_intake_reviews (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      response_id BIGINT NOT NULL UNIQUE REFERENCES market_maker_supply_responses(id) ON DELETE RESTRICT,
      selection_id BIGINT NOT NULL UNIQUE REFERENCES market_maker_supply_selections(id) ON DELETE RESTRICT,
      rfq_id BIGINT NOT NULL REFERENCES market_maker_rfqs(id) ON DELETE RESTRICT,
      lead_id BIGINT NOT NULL REFERENCES supply_leads(id) ON DELETE RESTRICT,
      status VARCHAR(40) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','ready_for_review','approved','rejected','converted')),
      registry VARCHAR(80) NOT NULL,
      registry_project_id VARCHAR(180) NOT NULL,
      project_name VARCHAR(255) NOT NULL,
      supplier_name VARCHAR(255) NOT NULL,
      confirmed_tonnes NUMERIC(24,3) NOT NULL CHECK (confirmed_tonnes > 0),
      authorized_tonnes NUMERIC(24,3) NOT NULL CHECK (authorized_tonnes > 0),
      floor_price_usd_tonne NUMERIC(14,4) CHECK (floor_price_usd_tonne IS NULL OR floor_price_usd_tonne > 0),
      min_order_tonnes NUMERIC(24,3) CHECK (min_order_tonnes IS NULL OR min_order_tonnes >= 0),
      batch_reference VARCHAR(255),
      vintage VARCHAR(80),
      serial_start VARCHAR(255),
      serial_end VARCHAR(255),
      methodology VARCHAR(255),
      country VARCHAR(100),
      region VARCHAR(180),
      registry_evidence_url TEXT,
      source_url TEXT,
      retirement_supported BOOLEAN NOT NULL DEFAULT FALSE,
      beneficiary_retirement_supported BOOLEAN NOT NULL DEFAULT FALSE,
      fractional_retirement_supported BOOLEAN NOT NULL DEFAULT FALSE,
      retirement_granularity_kg INTEGER NOT NULL DEFAULT 1000 CHECK (retirement_granularity_kg > 0),
      commercial_valid_until TIMESTAMPTZ,
      legal_kyc_status VARCHAR(30) NOT NULL DEFAULT 'pending'
        CHECK (legal_kyc_status IN ('pending','approved','rejected')),
      registry_evidence_status VARCHAR(30) NOT NULL DEFAULT 'pending'
        CHECK (registry_evidence_status IN ('pending','verified','rejected')),
      commercial_terms_status VARCHAR(30) NOT NULL DEFAULT 'pending'
        CHECK (commercial_terms_status IN ('pending','approved','rejected')),
      review_note TEXT,
      rejection_reason TEXT,
      approved_by VARCHAR(255),
      approved_at TIMESTAMPTZ,
      approval_snapshot JSONB,
      approval_sha256 VARCHAR(64),
      converted_at TIMESTAMPTZ,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT supply_intake_authorized_cap CHECK (authorized_tonnes <= confirmed_tonnes),
      CONSTRAINT supply_intake_approved_requirements CHECK (
        status NOT IN ('approved','converted') OR (
          legal_kyc_status='approved'
          AND registry_evidence_status='verified'
          AND commercial_terms_status='approved'
          AND batch_reference IS NOT NULL
          AND vintage IS NOT NULL
          AND registry_evidence_url IS NOT NULL
          AND retirement_supported=TRUE
          AND beneficiary_retirement_supported=TRUE
          AND approved_by IS NOT NULL
          AND approved_at IS NOT NULL
          AND approval_snapshot IS NOT NULL
          AND approval_sha256 IS NOT NULL
        )
      )
    );

    CREATE TABLE IF NOT EXISTS supply_intake_conversions (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      review_id BIGINT NOT NULL UNIQUE REFERENCES supply_intake_reviews(id) ON DELETE RESTRICT,
      mandate_id BIGINT NOT NULL UNIQUE REFERENCES supplier_mandates(id) ON DELETE RESTRICT,
      inventory_id BIGINT NOT NULL UNIQUE REFERENCES supply_inventory(id) ON DELETE RESTRICT,
      monitored_asset_id BIGINT NOT NULL UNIQUE REFERENCES monitored_assets(id) ON DELETE RESTRICT,
      converted_by VARCHAR(255) NOT NULL,
      conversion_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS supply_intake_events (
      id BIGSERIAL PRIMARY KEY,
      event_key UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      review_id BIGINT NOT NULL REFERENCES supply_intake_reviews(id) ON DELETE CASCADE,
      event_type VARCHAR(80) NOT NULL,
      actor VARCHAR(255),
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE OR REPLACE FUNCTION ecotracker_guard_approved_supply_intake_mutation()
    RETURNS TRIGGER AS $$
    BEGIN
      IF OLD.status='approved' THEN
        IF NEW.status='converted'
           AND NEW.converted_at IS NOT NULL
           AND NEW.response_id IS NOT DISTINCT FROM OLD.response_id
           AND NEW.selection_id IS NOT DISTINCT FROM OLD.selection_id
           AND NEW.rfq_id IS NOT DISTINCT FROM OLD.rfq_id
           AND NEW.lead_id IS NOT DISTINCT FROM OLD.lead_id
           AND NEW.registry IS NOT DISTINCT FROM OLD.registry
           AND NEW.registry_project_id IS NOT DISTINCT FROM OLD.registry_project_id
           AND NEW.project_name IS NOT DISTINCT FROM OLD.project_name
           AND NEW.supplier_name IS NOT DISTINCT FROM OLD.supplier_name
           AND NEW.confirmed_tonnes IS NOT DISTINCT FROM OLD.confirmed_tonnes
           AND NEW.authorized_tonnes IS NOT DISTINCT FROM OLD.authorized_tonnes
           AND NEW.floor_price_usd_tonne IS NOT DISTINCT FROM OLD.floor_price_usd_tonne
           AND NEW.min_order_tonnes IS NOT DISTINCT FROM OLD.min_order_tonnes
           AND NEW.batch_reference IS NOT DISTINCT FROM OLD.batch_reference
           AND NEW.vintage IS NOT DISTINCT FROM OLD.vintage
           AND NEW.serial_start IS NOT DISTINCT FROM OLD.serial_start
           AND NEW.serial_end IS NOT DISTINCT FROM OLD.serial_end
           AND NEW.methodology IS NOT DISTINCT FROM OLD.methodology
           AND NEW.country IS NOT DISTINCT FROM OLD.country
           AND NEW.region IS NOT DISTINCT FROM OLD.region
           AND NEW.registry_evidence_url IS NOT DISTINCT FROM OLD.registry_evidence_url
           AND NEW.source_url IS NOT DISTINCT FROM OLD.source_url
           AND NEW.retirement_supported IS NOT DISTINCT FROM OLD.retirement_supported
           AND NEW.beneficiary_retirement_supported IS NOT DISTINCT FROM OLD.beneficiary_retirement_supported
           AND NEW.fractional_retirement_supported IS NOT DISTINCT FROM OLD.fractional_retirement_supported
           AND NEW.retirement_granularity_kg IS NOT DISTINCT FROM OLD.retirement_granularity_kg
           AND NEW.commercial_valid_until IS NOT DISTINCT FROM OLD.commercial_valid_until
           AND NEW.legal_kyc_status IS NOT DISTINCT FROM OLD.legal_kyc_status
           AND NEW.registry_evidence_status IS NOT DISTINCT FROM OLD.registry_evidence_status
           AND NEW.commercial_terms_status IS NOT DISTINCT FROM OLD.commercial_terms_status
           AND NEW.review_note IS NOT DISTINCT FROM OLD.review_note
           AND NEW.rejection_reason IS NOT DISTINCT FROM OLD.rejection_reason
           AND NEW.approved_by IS NOT DISTINCT FROM OLD.approved_by
           AND NEW.approved_at IS NOT DISTINCT FROM OLD.approved_at
           AND NEW.approval_snapshot IS NOT DISTINCT FROM OLD.approval_snapshot
           AND NEW.approval_sha256 IS NOT DISTINCT FROM OLD.approval_sha256
           AND NEW.metadata IS NOT DISTINCT FROM OLD.metadata THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'approved_supply_intake_is_immutable';
      ELSIF OLD.status='converted' THEN
        RAISE EXCEPTION 'converted_supply_intake_is_immutable';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS guard_approved_supply_intake_mutation ON supply_intake_reviews;
    CREATE TRIGGER guard_approved_supply_intake_mutation
      BEFORE UPDATE ON supply_intake_reviews
      FOR EACH ROW EXECUTE FUNCTION ecotracker_guard_approved_supply_intake_mutation();

    CREATE INDEX IF NOT EXISTS supply_intake_reviews_pipeline_idx
      ON supply_intake_reviews(status,updated_at DESC);
    CREATE INDEX IF NOT EXISTS supply_intake_events_review_idx
      ON supply_intake_events(review_id,created_at DESC);
  `);
}
