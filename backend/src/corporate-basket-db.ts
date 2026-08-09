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

    ALTER TABLE corporate_baskets
      ADD COLUMN IF NOT EXISTS reserved_until TIMESTAMPTZ;

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

    CREATE TABLE IF NOT EXISTS corporate_basket_reservations (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      basket_id BIGINT NOT NULL REFERENCES corporate_baskets(id) ON DELETE CASCADE,
      leg_id BIGINT NOT NULL UNIQUE REFERENCES corporate_basket_legs(id) ON DELETE CASCADE,
      asset_id BIGINT NOT NULL REFERENCES monitored_assets(id) ON DELETE RESTRICT,
      reserved_kg BIGINT NOT NULL CHECK (reserved_kg > 0),
      status VARCHAR(30) NOT NULL DEFAULT 'active',
      expires_at TIMESTAMPTZ NOT NULL,
      released_at TIMESTAMPTZ,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS corporate_baskets_pipeline_idx
      ON corporate_baskets(status,quote_expires_at,created_at DESC);
    CREATE INDEX IF NOT EXISTS corporate_baskets_account_idx
      ON corporate_baskets(account_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS corporate_basket_legs_basket_idx
      ON corporate_basket_legs(basket_id,status,id);
    CREATE INDEX IF NOT EXISTS corporate_basket_legs_asset_idx
      ON corporate_basket_legs(asset_id,status);
    CREATE INDEX IF NOT EXISTS corporate_basket_reservations_asset_idx
      ON corporate_basket_reservations(asset_id,status,expires_at);
    CREATE INDEX IF NOT EXISTS corporate_basket_reservations_basket_idx
      ON corporate_basket_reservations(basket_id,status,expires_at);

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

    CREATE OR REPLACE FUNCTION ecotracker_guard_basket_asset_reservation()
    RETURNS TRIGGER AS $$
    DECLARE
      monitored_capacity_kg NUMERIC;
      confirmed_capacity_kg NUMERIC;
      effective_capacity_kg NUMERIC;
      already_reserved_kg NUMERIC;
    BEGIN
      IF NEW.status <> 'active' OR NEW.expires_at <= NOW() THEN
        RETURN NEW;
      END IF;

      SELECT CASE WHEN available_tons IS NULL THEN NULL ELSE available_tons * 1000 END
        INTO monitored_capacity_kg
      FROM monitored_assets
      WHERE id=NEW.asset_id AND active=TRUE
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Basket reservation asset is not active';
      END IF;

      SELECT source_available_kg INTO confirmed_capacity_kg
      FROM corporate_basket_legs
      WHERE id=NEW.leg_id AND asset_id=NEW.asset_id;

      IF monitored_capacity_kg IS NULL AND confirmed_capacity_kg IS NULL THEN
        RAISE EXCEPTION 'Basket reservation requires known source capacity';
      ELSIF monitored_capacity_kg IS NULL THEN
        effective_capacity_kg := confirmed_capacity_kg;
      ELSIF confirmed_capacity_kg IS NULL THEN
        effective_capacity_kg := monitored_capacity_kg;
      ELSE
        effective_capacity_kg := LEAST(monitored_capacity_kg, confirmed_capacity_kg);
      END IF;

      SELECT COALESCE(SUM(reserved_kg),0) INTO already_reserved_kg
      FROM corporate_basket_reservations
      WHERE asset_id=NEW.asset_id
        AND status='active'
        AND expires_at>NOW()
        AND id<>COALESCE(NEW.id,0);

      IF already_reserved_kg + NEW.reserved_kg > effective_capacity_kg + 0.000001 THEN
        RAISE EXCEPTION 'Insufficient locally reservable capacity for basket asset';
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS guard_basket_asset_reservation ON corporate_basket_reservations;
    CREATE TRIGGER guard_basket_asset_reservation
      BEFORE INSERT OR UPDATE OF status,reserved_kg,expires_at,asset_id ON corporate_basket_reservations
      FOR EACH ROW EXECUTE FUNCTION ecotracker_guard_basket_asset_reservation();
  `);
}
