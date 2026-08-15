import { pool } from "./db.js";

export async function initDemandSupplyRfqDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS market_maker_rfqs (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      opportunity_id BIGINT NOT NULL UNIQUE REFERENCES demand_opportunities(id) ON DELETE CASCADE,
      account_id BIGINT NOT NULL REFERENCES demand_accounts(id) ON DELETE CASCADE,
      status VARCHAR(40) NOT NULL DEFAULT 'open'
        CHECK (status IN ('open','partially_sourced','resolved','cancelled')),
      claim_purpose VARCHAR(60) NOT NULL DEFAULT 'voluntary_offset',
      target_year INTEGER,
      target_tonnes NUMERIC(24,3) NOT NULL CHECK (target_tonnes > 0),
      covered_tonnes NUMERIC(24,3) NOT NULL DEFAULT 0 CHECK (covered_tonnes >= 0),
      gap_tonnes NUMERIC(24,3) NOT NULL CHECK (gap_tonnes >= 0),
      preferred_country VARCHAR(100),
      max_price_usd_tonne NUMERIC(14,4),
      priority_score INTEGER NOT NULL DEFAULT 50 CHECK (priority_score BETWEEN 0 AND 100),
      requirements JSONB NOT NULL DEFAULT '{}'::jsonb,
      source VARCHAR(40) NOT NULL DEFAULT 'demand_autopilot',
      last_match_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ,
      cancelled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (covered_tonnes <= target_tonnes + 0.001),
      CHECK (gap_tonnes <= target_tonnes + 0.001)
    );

    CREATE TABLE IF NOT EXISTS market_maker_rfq_candidates (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      rfq_id BIGINT NOT NULL REFERENCES market_maker_rfqs(id) ON DELETE CASCADE,
      candidate_type VARCHAR(40) NOT NULL,
      candidate_key VARCHAR(255) NOT NULL,
      supply_lead_id BIGINT REFERENCES supply_leads(id) ON DELETE SET NULL,
      supply_inventory_id BIGINT REFERENCES supply_inventory(id) ON DELETE SET NULL,
      monitored_asset_id BIGINT REFERENCES monitored_assets(id) ON DELETE SET NULL,
      registry VARCHAR(80),
      registry_project_id VARCHAR(180),
      project_name VARCHAR(255),
      country VARCHAR(100),
      vintage VARCHAR(80),
      candidate_tonnes NUMERIC(24,3) NOT NULL DEFAULT 0 CHECK (candidate_tonnes >= 0),
      confidence VARCHAR(40) NOT NULL,
      sourcing_score INTEGER NOT NULL DEFAULT 0 CHECK (sourcing_score BETWEEN 0 AND 100),
      status VARCHAR(40) NOT NULL DEFAULT 'identified'
        CHECK (status IN ('identified','contacting','qualified','selected','rejected','stale')),
      auto_close_eligible BOOLEAN NOT NULL DEFAULT FALSE,
      rationale JSONB NOT NULL DEFAULT '{}'::jsonb,
      snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(rfq_id,candidate_type,candidate_key)
    );

    ALTER TABLE market_maker_rfq_candidates
      ADD COLUMN IF NOT EXISTS monitored_asset_id BIGINT REFERENCES monitored_assets(id) ON DELETE SET NULL;

    ALTER TABLE market_maker_rfq_candidates
      DROP CONSTRAINT IF EXISTS market_maker_rfq_candidates_candidate_type_check;
    ALTER TABLE market_maker_rfq_candidates
      ADD CONSTRAINT market_maker_rfq_candidates_candidate_type_check
      CHECK (candidate_type IN ('mandated_inventory','seller_confirmed','registry_estimate','market_signal'));

    CREATE INDEX IF NOT EXISTS market_maker_rfqs_pipeline_idx
      ON market_maker_rfqs(status,priority_score DESC,gap_tonnes DESC,updated_at DESC);
    CREATE INDEX IF NOT EXISTS market_maker_rfq_candidates_rank_idx
      ON market_maker_rfq_candidates(rfq_id,status,sourcing_score DESC,candidate_tonnes DESC);
    CREATE INDEX IF NOT EXISTS market_maker_rfq_candidates_asset_idx
      ON market_maker_rfq_candidates(monitored_asset_id) WHERE monitored_asset_id IS NOT NULL;
  `);
}
