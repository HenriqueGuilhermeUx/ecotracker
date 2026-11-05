import { pool } from "./db.js";

export async function initPartnerOtcDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS partner_otc_requests (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      opportunity_id BIGINT NOT NULL REFERENCES demand_opportunities(id) ON DELETE CASCADE,
      market_maker_rfq_id BIGINT REFERENCES market_maker_rfqs(id) ON DELETE SET NULL,
      partner_key VARCHAR(60) NOT NULL DEFAULT 'carbonmark',
      status VARCHAR(40) NOT NULL DEFAULT 'ready_to_send'
        CHECK (status IN ('draft','ready_to_send','sent','options_received','erpa_pending','erpa_signed','funding_pending','paid','delivered','retired','cancelled')),
      requested_tonnes NUMERIC(24,3) NOT NULL CHECK (requested_tonnes > 0),
      claim_purpose VARCHAR(60) NOT NULL DEFAULT 'voluntary_offset',
      target_year INTEGER,
      preferred_registry VARCHAR(120),
      preferred_country VARCHAR(120),
      preferred_project_type VARCHAR(180),
      max_price_usd_tonne NUMERIC(14,4),
      request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      partner_reference VARCHAR(255),
      erpa_reference VARCHAR(255),
      notes TEXT,
      requested_at TIMESTAMPTZ,
      response_received_at TIMESTAMPTZ,
      retired_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(opportunity_id,partner_key)
    );

    CREATE TABLE IF NOT EXISTS partner_otc_options (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      request_id BIGINT NOT NULL REFERENCES partner_otc_requests(id) ON DELETE CASCADE,
      status VARCHAR(40) NOT NULL DEFAULT 'received'
        CHECK (status IN ('received','shortlisted','selected','rejected','expired')),
      project_name VARCHAR(255) NOT NULL,
      registry VARCHAR(120),
      registry_project_id VARCHAR(180),
      country VARCHAR(120),
      methodology VARCHAR(255),
      vintage VARCHAR(100),
      available_tonnes NUMERIC(24,3) NOT NULL CHECK (available_tonnes > 0),
      source_price_usd_tonne NUMERIC(14,4) NOT NULL CHECK (source_price_usd_tonne >= 0),
      fx_brl_usd NUMERIC(14,6),
      sell_price_brl_tonne NUMERIC(14,4),
      validity_until TIMESTAMPTZ,
      retirement_supported BOOLEAN NOT NULL DEFAULT TRUE,
      beneficiary_supported BOOLEAN NOT NULL DEFAULT TRUE,
      evidence_url TEXT,
      notes TEXT,
      snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS partner_otc_requests_pipeline_idx
      ON partner_otc_requests(status,updated_at DESC);
    CREATE INDEX IF NOT EXISTS partner_otc_options_request_idx
      ON partner_otc_options(request_id,status,created_at DESC);
  `);
}
