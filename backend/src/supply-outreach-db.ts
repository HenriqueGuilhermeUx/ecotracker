import { pool } from "./db.js";

export async function initSupplyOutreachDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS market_maker_supply_selections (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      rfq_id BIGINT NOT NULL REFERENCES market_maker_rfqs(id) ON DELETE CASCADE,
      candidate_id BIGINT NOT NULL REFERENCES market_maker_rfq_candidates(id) ON DELETE CASCADE,
      supply_lead_id BIGINT REFERENCES supply_leads(id) ON DELETE SET NULL,
      supply_inventory_id BIGINT REFERENCES supply_inventory(id) ON DELETE SET NULL,
      requested_tonnes NUMERIC(24,3) NOT NULL CHECK (requested_tonnes > 0),
      status VARCHAR(40) NOT NULL DEFAULT 'selected'
        CHECK (status IN ('selected','outbox_ready','contacting','responded','declined','expired','cancelled')),
      response_due_at TIMESTAMPTZ,
      selected_by VARCHAR(255) NOT NULL,
      selected_note TEXT,
      snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(rfq_id,candidate_id)
    );

    CREATE TABLE IF NOT EXISTS market_maker_supply_outbox (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      selection_id BIGINT NOT NULL UNIQUE REFERENCES market_maker_supply_selections(id) ON DELETE CASCADE,
      recipient_email VARCHAR(320) NOT NULL,
      recipient_name VARCHAR(255),
      supplier_name VARCHAR(255),
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

    CREATE TABLE IF NOT EXISTS market_maker_supply_responses (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      selection_id BIGINT NOT NULL UNIQUE REFERENCES market_maker_supply_selections(id) ON DELETE CASCADE,
      status VARCHAR(30) NOT NULL CHECK (status IN ('confirmed','declined')),
      confirmed_available_tonnes NUMERIC(24,3) NOT NULL CHECK (confirmed_available_tonnes >= 0),
      firm_price_usd_tonne NUMERIC(14,4) CHECK (firm_price_usd_tonne IS NULL OR firm_price_usd_tonne > 0),
      min_order_tonnes NUMERIC(24,3) CHECK (min_order_tonnes IS NULL OR min_order_tonnes >= 0),
      retirement_supported BOOLEAN NOT NULL DEFAULT FALSE,
      beneficiary_retirement_supported BOOLEAN NOT NULL DEFAULT FALSE,
      registry_evidence_url TEXT,
      valid_until TIMESTAMPTZ,
      response_note TEXT,
      responded_by VARCHAR(255) NOT NULL,
      response_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (confirmed_available_tonnes = 0 OR min_order_tonnes IS NULL OR min_order_tonnes <= confirmed_available_tonnes)
    );

    CREATE TABLE IF NOT EXISTS market_maker_supply_events (
      id BIGSERIAL PRIMARY KEY,
      event_key UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      rfq_id BIGINT NOT NULL REFERENCES market_maker_rfqs(id) ON DELETE CASCADE,
      selection_id BIGINT REFERENCES market_maker_supply_selections(id) ON DELETE SET NULL,
      outbox_id BIGINT REFERENCES market_maker_supply_outbox(id) ON DELETE SET NULL,
      response_id BIGINT REFERENCES market_maker_supply_responses(id) ON DELETE SET NULL,
      event_type VARCHAR(80) NOT NULL,
      actor VARCHAR(255),
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE OR REPLACE FUNCTION ecotracker_guard_supply_selection_volume()
    RETURNS TRIGGER AS $$
    DECLARE
      rfq_gap NUMERIC;
      rfq_status VARCHAR;
      candidate_volume NUMERIC;
      candidate_rfq BIGINT;
      candidate_status VARCHAR;
    BEGIN
      SELECT gap_tonnes,status INTO rfq_gap,rfq_status
      FROM market_maker_rfqs WHERE id=NEW.rfq_id FOR UPDATE;

      SELECT candidate_tonnes,rfq_id,status INTO candidate_volume,candidate_rfq,candidate_status
      FROM market_maker_rfq_candidates WHERE id=NEW.candidate_id FOR UPDATE;

      IF rfq_gap IS NULL OR candidate_volume IS NULL THEN
        RAISE EXCEPTION 'market_maker_supply_selection_reference_not_found';
      END IF;
      IF candidate_rfq <> NEW.rfq_id THEN
        RAISE EXCEPTION 'market_maker_supply_candidate_wrong_rfq';
      END IF;
      IF rfq_status NOT IN ('open','partially_sourced') THEN
        RAISE EXCEPTION 'market_maker_rfq_not_open';
      END IF;
      IF candidate_status IN ('rejected','stale') THEN
        RAISE EXCEPTION 'market_maker_supply_candidate_not_selectable';
      END IF;
      IF NEW.requested_tonnes > LEAST(rfq_gap,candidate_volume) + 0.001 THEN
        RAISE EXCEPTION 'market_maker_supply_selection_overallocated';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS guard_market_maker_supply_selection_volume ON market_maker_supply_selections;
    CREATE TRIGGER guard_market_maker_supply_selection_volume
      BEFORE INSERT OR UPDATE OF rfq_id,candidate_id,requested_tonnes
      ON market_maker_supply_selections
      FOR EACH ROW EXECUTE FUNCTION ecotracker_guard_supply_selection_volume();

    CREATE INDEX IF NOT EXISTS market_maker_supply_selections_pipeline_idx
      ON market_maker_supply_selections(status,response_due_at,updated_at DESC);
    CREATE INDEX IF NOT EXISTS market_maker_supply_outbox_status_idx
      ON market_maker_supply_outbox(status,created_at DESC);
    CREATE INDEX IF NOT EXISTS market_maker_supply_events_rfq_idx
      ON market_maker_supply_events(rfq_id,created_at DESC);
  `);
}
