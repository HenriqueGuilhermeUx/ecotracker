import { pool } from "./db.js";

export async function initCorporateBasketDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS corporate_baskets (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      proposal_id BIGINT NOT NULL REFERENCES demand_proposals(id) ON DELETE CASCADE,
      account_id BIGINT NOT NULL REFERENCES demand_accounts(id) ON DELETE CASCADE,
      status VARCHAR(40) NOT NULL DEFAULT 'awaiting_leg_confirmation',
      target_kg BIGINT NOT NULL CHECK (target_kg > 0),
      covered_kg BIGINT NOT NULL CHECK (covered_kg > 0),
      source_cost_brl NUMERIC(18,2),
      service_revenue_brl NUMERIC(18,2),
      final_total_brl NUMERIC(18,2),
      price_per_tonne_brl NUMERIC(18,2),
      payment_status VARCHAR(30) NOT NULL DEFAULT 'disabled',
      checkout_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      quote_expires_at TIMESTAMPTZ,
      buyer_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      pricing_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(proposal_id)
    );

    CREATE TABLE IF NOT EXISTS corporate_basket_legs (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      basket_id BIGINT NOT NULL REFERENCES corporate_baskets(id) ON DELETE CASCADE,
      proposal_item_id BIGINT NOT NULL REFERENCES demand_proposal_items(id) ON DELETE RESTRICT,
      asset_id BIGINT NOT NULL REFERENCES monitored_assets(id) ON DELETE RESTRICT,
      requested_kg BIGINT NOT NULL CHECK (requested_kg > 0),
      registry VARCHAR(120) NOT NULL,
      project_name VARCHAR(255) NOT NULL,
      vintage VARCHAR(80),
      provider_key VARCHAR(80),
      execution_mode VARCHAR(30) NOT NULL DEFAULT 'assisted',
      status VARCHAR(40) NOT NULL DEFAULT 'awaiting_confirmation',
      source_cost_brl NUMERIC(18,2),
      source_reference VARCHAR(500),
      source_available_kg NUMERIC(18,3),
      source_evidence_url TEXT,
      quote_expires_at TIMESTAMPTZ,
      eligibility_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      source_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      confirmed_at TIMESTAMPTZ,
      confirmed_by VARCHAR(255),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(basket_id,proposal_item_id)
    );

    CREATE INDEX IF NOT EXISTS corporate_baskets_pipeline_idx
      ON corporate_baskets(status,quote_expires_at,created_at DESC);
    CREATE INDEX IF NOT EXISTS corporate_baskets_account_idx
      ON corporate_baskets(account_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS corporate_basket_legs_basket_idx
      ON corporate_basket_legs(basket_id,status,id);
    CREATE INDEX IF NOT EXISTS corporate_basket_legs_asset_idx
      ON corporate_basket_legs(asset_id,status);

    CREATE OR REPLACE FUNCTION ecotracker_guard_basket_checkout_disabled()
    RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.checkout_enabled=TRUE OR NEW.payment_status NOT IN ('disabled','not_started') THEN
        RAISE EXCEPTION 'Corporate basket payment rail is not enabled in this deployment';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS guard_basket_checkout_disabled ON corporate_baskets;
    CREATE TRIGGER guard_basket_checkout_disabled
      BEFORE INSERT OR UPDATE OF checkout_enabled,payment_status ON corporate_baskets
      FOR EACH ROW EXECUTE FUNCTION ecotracker_guard_basket_checkout_disabled();
  `);
}
