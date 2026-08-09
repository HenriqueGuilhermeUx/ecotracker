import { pool } from "./db.js";

function livePaymentAcknowledged() {
  return process.env.CORPORATE_BASKET_PAYMENT_ENABLED === "true"
    && process.env.CORPORATE_BASKET_PAYMENT_ACK === "ENABLE_LIVE_BASKET_PAYMENTS";
}

export async function initCorporateBasketPaymentDb(): Promise<void> {
  const enabled = livePaymentAcknowledged();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS corporate_basket_payment_settings (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton=TRUE),
      payment_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      mode VARCHAR(30) NOT NULL DEFAULT 'disabled',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    INSERT INTO corporate_basket_payment_settings(singleton,payment_enabled,mode)
    VALUES(TRUE,$1,$2)
    ON CONFLICT(singleton) DO UPDATE SET payment_enabled=EXCLUDED.payment_enabled,mode=EXCLUDED.mode,updated_at=NOW();

    ALTER TABLE corporate_baskets
      ADD COLUMN IF NOT EXISTS payment_provider VARCHAR(40),
      ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20),
      ADD COLUMN IF NOT EXISTS payment_reference VARCHAR(255),
      ADD COLUMN IF NOT EXISTS payment_url TEXT,
      ADD COLUMN IF NOT EXISTS pix_br_code TEXT,
      ADD COLUMN IF NOT EXISTS pix_qr_code_url TEXT,
      ADD COLUMN IF NOT EXISTS payment_fee_brl NUMERIC(18,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS tax_reserve_brl NUMERIC(18,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS net_profit_brl NUMERIC(18,2),
      ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS corporate_basket_payment_attempts (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      basket_id BIGINT NOT NULL REFERENCES corporate_baskets(id) ON DELETE CASCADE,
      provider VARCHAR(40) NOT NULL,
      method VARCHAR(20) NOT NULL,
      external_reference VARCHAR(255) NOT NULL,
      provider_reference VARCHAR(255),
      status VARCHAR(40) NOT NULL DEFAULT 'creating',
      amount_brl NUMERIC(18,2) NOT NULL CHECK (amount_brl > 0),
      provider_fee_brl NUMERIC(18,2) NOT NULL DEFAULT 0,
      checkout_url TEXT,
      pix_br_code TEXT,
      qr_code_url TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(basket_id,method),
      UNIQUE(provider,provider_reference)
    );

    CREATE TABLE IF NOT EXISTS corporate_basket_events (
      id BIGSERIAL PRIMARY KEY,
      event_key TEXT NOT NULL DEFAULT gen_random_uuid()::text UNIQUE,
      basket_id BIGINT REFERENCES corporate_baskets(id) ON DELETE CASCADE,
      event_type VARCHAR(100) NOT NULL,
      provider VARCHAR(40),
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS corporate_basket_payment_attempts_basket_idx
      ON corporate_basket_payment_attempts(basket_id,status,created_at DESC);
    CREATE INDEX IF NOT EXISTS corporate_basket_payment_attempts_provider_idx
      ON corporate_basket_payment_attempts(provider,provider_reference);
    CREATE INDEX IF NOT EXISTS corporate_basket_events_basket_idx
      ON corporate_basket_events(basket_id,created_at DESC);

    CREATE OR REPLACE FUNCTION ecotracker_guard_basket_checkout_disabled()
    RETURNS TRIGGER AS $$
    DECLARE
      enabled BOOLEAN;
      reconcilable BOOLEAN;
    BEGIN
      SELECT payment_enabled INTO enabled
      FROM corporate_basket_payment_settings WHERE singleton=TRUE;

      IF NEW.checkout_enabled=TRUE OR NEW.payment_status NOT IN ('disabled','not_started') THEN
        IF COALESCE(enabled,FALSE)=FALSE THEN
          SELECT EXISTS(
            SELECT 1 FROM corporate_basket_payment_attempts p
            WHERE p.basket_id=NEW.id
              AND p.status IN ('creating','pending','active','approved','paid','amount_mismatch','review_required')
          ) INTO reconcilable;
          IF COALESCE(reconcilable,FALSE)=FALSE THEN
            RAISE EXCEPTION 'Corporate basket payment rail is not enabled in this deployment';
          END IF;
        END IF;
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
      -- A transição active -> committed acontece somente depois de um pagamento
      -- reconciliado. A capacidade já foi validada antes de abrir o checkout;
      -- nunca rejeitamos a reconciliação de dinheiro capturado por drift posterior.
      IF TG_OP='UPDATE'
         AND OLD.status='active'
         AND NEW.status='committed'
         AND OLD.asset_id=NEW.asset_id
         AND OLD.reserved_kg=NEW.reserved_kg THEN
        RETURN NEW;
      END IF;

      IF NEW.status NOT IN ('active','committed') THEN
        RETURN NEW;
      END IF;
      IF NEW.status='active' AND NEW.expires_at<=NOW() THEN
        RETURN NEW;
      END IF;

      SELECT CASE WHEN available_tons IS NULL THEN NULL ELSE available_tons * 1000 END
        INTO monitored_capacity_kg
      FROM monitored_assets
      WHERE id=NEW.asset_id AND active=TRUE
      FOR UPDATE;

      IF NOT FOUND THEN RAISE EXCEPTION 'Basket reservation asset is not active'; END IF;

      SELECT source_available_kg INTO confirmed_capacity_kg
      FROM corporate_basket_legs WHERE id=NEW.leg_id AND asset_id=NEW.asset_id;

      IF monitored_capacity_kg IS NULL AND confirmed_capacity_kg IS NULL THEN
        RAISE EXCEPTION 'Basket reservation requires known source capacity';
      ELSIF monitored_capacity_kg IS NULL THEN effective_capacity_kg := confirmed_capacity_kg;
      ELSIF confirmed_capacity_kg IS NULL THEN effective_capacity_kg := monitored_capacity_kg;
      ELSE effective_capacity_kg := LEAST(monitored_capacity_kg,confirmed_capacity_kg);
      END IF;

      SELECT COALESCE(SUM(reserved_kg),0) INTO already_reserved_kg
      FROM corporate_basket_reservations
      WHERE asset_id=NEW.asset_id
        AND (
          status='committed'
          OR (status='active' AND expires_at>NOW())
        )
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
  `, [enabled, enabled ? "live_acknowledged" : "disabled"]);
}

export async function corporateBasketPaymentStatus() {
  const { rows } = await pool.query(`SELECT * FROM corporate_basket_payment_settings WHERE singleton=TRUE`);
  return {
    envEnabled: process.env.CORPORATE_BASKET_PAYMENT_ENABLED === "true",
    acknowledgementValid: process.env.CORPORATE_BASKET_PAYMENT_ACK === "ENABLE_LIVE_BASKET_PAYMENTS",
    database: rows[0] || { payment_enabled: false, mode: "disabled" },
    live: Boolean(rows[0]?.payment_enabled) && livePaymentAcknowledged(),
  };
}
