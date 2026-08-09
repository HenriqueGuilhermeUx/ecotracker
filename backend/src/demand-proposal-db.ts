import { pool } from "./db.js";

export async function initDemandProposalDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS demand_proposals (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      opportunity_id BIGINT NOT NULL REFERENCES demand_opportunities(id) ON DELETE CASCADE,
      account_id BIGINT NOT NULL REFERENCES demand_accounts(id) ON DELETE CASCADE,
      status VARCHAR(30) NOT NULL DEFAULT 'draft',
      target_tonnes NUMERIC(18,3) NOT NULL CHECK (target_tonnes > 0),
      covered_tonnes NUMERIC(18,3) NOT NULL DEFAULT 0 CHECK (covered_tonnes >= 0),
      uncovered_tonnes NUMERIC(18,3) NOT NULL DEFAULT 0 CHECK (uncovered_tonnes >= 0),
      coverage_pct NUMERIC(8,2) NOT NULL DEFAULT 0,
      source_cost_brl NUMERIC(18,2),
      service_revenue_brl NUMERIC(18,2),
      final_total_brl NUMERIC(18,2),
      price_per_tonne_brl NUMERIC(18,2),
      checkout_mode VARCHAR(40) NOT NULL DEFAULT 'basket_quote_required',
      execution_mode VARCHAR(30) NOT NULL DEFAULT 'assisted',
      validity_minutes INTEGER NOT NULL DEFAULT 60 CHECK (validity_minutes BETWEEN 5 AND 10080),
      expires_at TIMESTAMPTZ,
      proposal_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE demand_proposals
      ADD COLUMN IF NOT EXISTS converted_quote_id BIGINT REFERENCES quote_requests(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS converted_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS demand_proposal_items (
      id BIGSERIAL PRIMARY KEY,
      proposal_id BIGINT NOT NULL REFERENCES demand_proposals(id) ON DELETE CASCADE,
      match_id BIGINT REFERENCES demand_matches(id) ON DELETE SET NULL,
      asset_id BIGINT REFERENCES monitored_assets(id) ON DELETE SET NULL,
      registry VARCHAR(120) NOT NULL,
      project_name VARCHAR(255) NOT NULL,
      vintage VARCHAR(80),
      amount_tonnes NUMERIC(18,3) NOT NULL CHECK (amount_tonnes > 0),
      source_price_usd_tonne NUMERIC(14,4),
      fx_brl_usd NUMERIC(12,4),
      source_cost_brl NUMERIC(18,2),
      indicative_sale_brl NUMERIC(18,2),
      execution_mode VARCHAR(30) NOT NULL DEFAULT 'assisted',
      retirement_supported BOOLEAN NOT NULL DEFAULT FALSE,
      evidence_url TEXT,
      item_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS demand_proposals_pipeline_idx
      ON demand_proposals(status,expires_at,created_at DESC);
    CREATE INDEX IF NOT EXISTS demand_proposals_opportunity_idx
      ON demand_proposals(opportunity_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS demand_proposals_converted_quote_idx
      ON demand_proposals(converted_quote_id);
    CREATE INDEX IF NOT EXISTS demand_proposal_items_proposal_idx
      ON demand_proposal_items(proposal_id,id);
  `);
}
