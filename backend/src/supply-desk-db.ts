import { pool } from "./db.js";

export async function initSupplyDeskDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS supply_leads (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      registry VARCHAR(80) NOT NULL,
      registry_project_id VARCHAR(180) NOT NULL,
      project_name VARCHAR(255) NOT NULL,
      country VARCHAR(100),
      region VARCHAR(180),
      supplier_name VARCHAR(255),
      supplier_contact_name VARCHAR(255),
      supplier_email VARCHAR(320),
      supplier_phone VARCHAR(80),
      methodology VARCHAR(255),
      vintage VARCHAR(80),
      issued_tonnes NUMERIC(18,3),
      retired_tonnes NUMERIC(18,3),
      withdrawn_tonnes NUMERIC(18,3) NOT NULL DEFAULT 0,
      estimated_unretired_tonnes NUMERIC(18,3),
      confirmed_free_tonnes NUMERIC(18,3),
      evidence_url TEXT,
      source_url TEXT,
      data_source VARCHAR(80) NOT NULL DEFAULT 'manual',
      availability_confidence VARCHAR(30) NOT NULL DEFAULT 'registry_estimate',
      contact_status VARCHAR(30) NOT NULL DEFAULT 'not_contacted',
      status VARCHAR(30) NOT NULL DEFAULT 'scouted',
      notes TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_checked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(registry, registry_project_id)
    );

    CREATE TABLE IF NOT EXISTS supplier_mandates (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      lead_id BIGINT NOT NULL REFERENCES supply_leads(id) ON DELETE CASCADE,
      supplier_name VARCHAR(255) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'draft',
      confirmed_free_tonnes NUMERIC(18,3) NOT NULL CHECK (confirmed_free_tonnes > 0),
      authorized_tonnes NUMERIC(18,3) NOT NULL CHECK (authorized_tonnes > 0),
      floor_price_usd_tonne NUMERIC(14,4),
      currency VARCHAR(12) NOT NULL DEFAULT 'USD',
      non_exclusive BOOLEAN NOT NULL DEFAULT TRUE,
      allowed_channels JSONB NOT NULL DEFAULT '[]'::jsonb,
      serial_ranges JSONB NOT NULL DEFAULT '[]'::jsonb,
      evidence_url TEXT,
      signed_at TIMESTAMPTZ,
      valid_from TIMESTAMPTZ,
      valid_until TIMESTAMPTZ,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT supplier_mandate_authorized_cap CHECK (authorized_tonnes <= confirmed_free_tonnes)
    );

    CREATE TABLE IF NOT EXISTS supply_inventory (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      mandate_id BIGINT NOT NULL REFERENCES supplier_mandates(id) ON DELETE CASCADE,
      registry VARCHAR(80) NOT NULL,
      registry_project_id VARCHAR(180) NOT NULL,
      batch_reference VARCHAR(255) NOT NULL,
      vintage VARCHAR(80),
      serial_start VARCHAR(255),
      serial_end VARCHAR(255),
      authorized_tonnes NUMERIC(18,3) NOT NULL CHECK (authorized_tonnes > 0),
      sold_tonnes NUMERIC(18,3) NOT NULL DEFAULT 0 CHECK (sold_tonnes >= 0),
      status VARCHAR(30) NOT NULL DEFAULT 'available',
      registry_evidence_url TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(mandate_id, batch_reference),
      CONSTRAINT supply_inventory_sold_cap CHECK (sold_tonnes <= authorized_tonnes)
    );

    CREATE TABLE IF NOT EXISTS supply_channel_listings (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      inventory_id BIGINT NOT NULL REFERENCES supply_inventory(id) ON DELETE CASCADE,
      channel VARCHAR(40) NOT NULL,
      advertised_tonnes NUMERIC(18,3) NOT NULL CHECK (advertised_tonnes > 0),
      ask_price_usd_tonne NUMERIC(14,4),
      external_listing_id VARCHAR(255),
      external_url TEXT,
      status VARCHAR(30) NOT NULL DEFAULT 'planned',
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(inventory_id, channel)
    );

    CREATE TABLE IF NOT EXISTS supply_reservations (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      inventory_id BIGINT NOT NULL REFERENCES supply_inventory(id) ON DELETE CASCADE,
      channel VARCHAR(40) NOT NULL,
      external_order_id VARCHAR(255),
      reserved_tonnes NUMERIC(18,3) NOT NULL CHECK (reserved_tonnes > 0),
      status VARCHAR(30) NOT NULL DEFAULT 'active',
      reserved_until TIMESTAMPTZ,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE OR REPLACE FUNCTION ecotracker_guard_supply_reservation()
    RETURNS TRIGGER AS $$
    DECLARE
      cap NUMERIC;
      sold NUMERIC;
      active_reserved NUMERIC;
    BEGIN
      IF NEW.status NOT IN ('active','pending') THEN
        RETURN NEW;
      END IF;

      SELECT authorized_tonnes,sold_tonnes INTO cap,sold
      FROM supply_inventory WHERE id=NEW.inventory_id FOR UPDATE;

      IF cap IS NULL THEN
        RAISE EXCEPTION 'supply_inventory_not_found';
      END IF;

      SELECT COALESCE(SUM(reserved_tonnes),0) INTO active_reserved
      FROM supply_reservations
      WHERE inventory_id=NEW.inventory_id
        AND status IN ('active','pending')
        AND (TG_OP='INSERT' OR id<>NEW.id);

      IF sold + active_reserved + NEW.reserved_tonnes > cap THEN
        RAISE EXCEPTION 'supply_inventory_overallocated';
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS guard_supply_reservation_before_write ON supply_reservations;
    CREATE TRIGGER guard_supply_reservation_before_write
      BEFORE INSERT OR UPDATE OF inventory_id,reserved_tonnes,status ON supply_reservations
      FOR EACH ROW EXECUTE FUNCTION ecotracker_guard_supply_reservation();

    CREATE OR REPLACE FUNCTION ecotracker_guard_supply_inventory_against_mandate()
    RETURNS TRIGGER AS $$
    DECLARE
      mandate_cap NUMERIC;
      existing_allocated NUMERIC;
    BEGIN
      SELECT authorized_tonnes INTO mandate_cap
      FROM supplier_mandates WHERE id=NEW.mandate_id FOR UPDATE;

      SELECT COALESCE(SUM(authorized_tonnes),0) INTO existing_allocated
      FROM supply_inventory
      WHERE mandate_id=NEW.mandate_id
        AND (TG_OP='INSERT' OR id<>NEW.id)
        AND status<>'cancelled';

      IF mandate_cap IS NULL OR existing_allocated + NEW.authorized_tonnes > mandate_cap THEN
        RAISE EXCEPTION 'supplier_mandate_overallocated';
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS guard_supply_inventory_against_mandate ON supply_inventory;
    CREATE TRIGGER guard_supply_inventory_against_mandate
      BEFORE INSERT OR UPDATE OF mandate_id,authorized_tonnes,status ON supply_inventory
      FOR EACH ROW EXECUTE FUNCTION ecotracker_guard_supply_inventory_against_mandate();

    CREATE INDEX IF NOT EXISTS supply_leads_pipeline_idx ON supply_leads(status,contact_status,updated_at DESC);
    CREATE INDEX IF NOT EXISTS supply_leads_country_idx ON supply_leads(country,registry,estimated_unretired_tonnes DESC);
    CREATE INDEX IF NOT EXISTS supplier_mandates_lead_idx ON supplier_mandates(lead_id,status,updated_at DESC);
    CREATE INDEX IF NOT EXISTS supply_inventory_available_idx ON supply_inventory(status,registry,updated_at DESC);
    CREATE INDEX IF NOT EXISTS supply_channel_listings_channel_idx ON supply_channel_listings(channel,status,updated_at DESC);
    CREATE INDEX IF NOT EXISTS supply_reservations_inventory_idx ON supply_reservations(inventory_id,status,reserved_until);
  `);
}
