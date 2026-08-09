import { pool } from "./db.js";

export async function initSupplyOutreachDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS supply_outreach_selections (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      rfq_id BIGINT NOT NULL REFERENCES market_maker_rfqs(id) ON DELETE CASCADE,
      candidate_id BIGINT NOT NULL REFERENCES market_maker_rfq_candidates(id) ON DELETE CASCADE,
      status VARCHAR(30) NOT NULL DEFAULT 'approved'
        CHECK (status IN ('approved','cancelled')),
      selected_by VARCHAR(255) NOT NULL,
      review_note TEXT,
      requested_tonnes NUMERIC(24,3) NOT NULL CHECK (requested_tonnes > 0),
      max_price_usd_tonne NUMERIC(14,4),
      response_due_at TIMESTAMPTZ,
      snapshot JSONB NOT NULL,
      snapshot_sha256 VARCHAR(64) NOT NULL,
      approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      cancelled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS supply_outreach_one_active_selection_per_candidate
      ON supply_outreach_selections(candidate_id)
      WHERE status='approved';

    CREATE TABLE IF NOT EXISTS supply_outbox (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      selection_id BIGINT NOT NULL UNIQUE REFERENCES supply_outreach_selections(id) ON DELETE CASCADE,
      rfq_id BIGINT NOT NULL REFERENCES market_maker_rfqs(id) ON DELETE CASCADE,
      candidate_id BIGINT NOT NULL REFERENCES market_maker_rfq_candidates(id) ON DELETE CASCADE,
      supply_lead_id BIGINT REFERENCES supply_leads(id) ON DELETE SET NULL,
      recipient_email VARCHAR(320) NOT NULL,
      recipient_name VARCHAR(255),
      subject VARCHAR(500) NOT NULL,
      text_body TEXT NOT NULL,
      html_body TEXT NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'ready'
        CHECK (status IN ('ready','sending','sent','failed','cancelled')),
      provider VARCHAR(40) NOT NULL DEFAULT 'resend',
      provider_reference VARCHAR(255),
      idempotency_key VARCHAR(256) NOT NULL UNIQUE,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      last_error TEXT,
      sent_at TIMESTAMPTZ,
      cancelled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS supply_outreach_responses (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      selection_id BIGINT NOT NULL UNIQUE REFERENCES supply_outreach_selections(id) ON DELETE CASCADE,
      outbox_id BIGINT REFERENCES supply_outbox(id) ON DELETE SET NULL,
      rfq_id BIGINT NOT NULL REFERENCES market_maker_rfqs(id) ON DELETE CASCADE,
      candidate_id BIGINT NOT NULL REFERENCES market_maker_rfq_candidates(id) ON DELETE CASCADE,
      supply_lead_id BIGINT REFERENCES supply_leads(id) ON DELETE SET NULL,
      confirmed_available_tonnes NUMERIC(24,3) NOT NULL CHECK (confirmed_available_tonnes >= 0),
      firm_price_usd_tonne NUMERIC(14,4) CHECK (firm_price_usd_tonne IS NULL OR firm_price_usd_tonne >= 0),
      min_order_tonnes NUMERIC(24,3) CHECK (min_order_tonnes IS NULL OR min_order_tonnes >= 0),
      retirement_supported BOOLEAN,
      beneficiary_retirement_supported BOOLEAN,
      registry_evidence_url TEXT,
      offer_valid_until TIMESTAMPTZ,
      response_note TEXT,
      recorded_by VARCHAR(255) NOT NULL,
      raw_response JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS supply_outreach_events (
      id BIGSERIAL PRIMARY KEY,
      event_key TEXT NOT NULL DEFAULT gen_random_uuid()::text UNIQUE,
      rfq_id BIGINT NOT NULL REFERENCES market_maker_rfqs(id) ON DELETE CASCADE,
      candidate_id BIGINT REFERENCES market_maker_rfq_candidates(id) ON DELETE SET NULL,
      selection_id BIGINT REFERENCES supply_outreach_selections(id) ON DELETE SET NULL,
      outbox_id BIGINT REFERENCES supply_outbox(id) ON DELETE SET NULL,
      response_id BIGINT REFERENCES supply_outreach_responses(id) ON DELETE SET NULL,
      event_type VARCHAR(80) NOT NULL,
      actor VARCHAR(255),
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS supply_outreach_selections_rfq_idx
      ON supply_outreach_selections(rfq_id,status,created_at DESC);
    CREATE INDEX IF NOT EXISTS supply_outbox_status_idx
      ON supply_outbox(status,created_at DESC);
    CREATE INDEX IF NOT EXISTS supply_outreach_events_rfq_idx
      ON supply_outreach_events(rfq_id,created_at DESC);
  `);
}
