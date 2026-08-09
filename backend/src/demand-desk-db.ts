import { pool } from "./db.js";

export async function initDemandDeskDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS demand_accounts (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      source VARCHAR(80) NOT NULL DEFAULT 'manual',
      source_reference VARCHAR(180) NOT NULL,
      company_name VARCHAR(255) NOT NULL,
      legal_name VARCHAR(255),
      tax_id VARCHAR(40),
      sector VARCHAR(180),
      sub_sector VARCHAR(180),
      city VARCHAR(120),
      state VARCHAR(120),
      country VARCHAR(100) NOT NULL DEFAULT 'Brasil',
      participant_url TEXT,
      website_url TEXT,
      contact_name VARCHAR(255),
      contact_email VARCHAR(320),
      contact_phone VARCHAR(80),
      contact_status VARCHAR(30) NOT NULL DEFAULT 'not_contacted',
      status VARCHAR(30) NOT NULL DEFAULT 'scouted',
      lead_score INTEGER NOT NULL DEFAULT 0 CHECK (lead_score BETWEEN 0 AND 100),
      notes TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_checked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(source,source_reference)
    );

    CREATE TABLE IF NOT EXISTS demand_inventories (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      account_id BIGINT NOT NULL REFERENCES demand_accounts(id) ON DELETE CASCADE,
      inventory_year INTEGER NOT NULL CHECK (inventory_year BETWEEN 1990 AND 2200),
      scope1_tonnes NUMERIC(18,3),
      scope2_location_tonnes NUMERIC(18,3),
      scope2_market_tonnes NUMERIC(18,3),
      scope3_tonnes NUMERIC(18,3),
      biogenic_tonnes NUMERIC(18,3),
      removals_tonnes NUMERIC(18,3),
      reported_total_tonnes NUMERIC(18,3),
      verification_level VARCHAR(30) NOT NULL DEFAULT 'unknown',
      verification_provider VARCHAR(255),
      inventory_url TEXT,
      source_url TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(account_id,inventory_year)
    );

    CREATE TABLE IF NOT EXISTS demand_opportunities (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      account_id BIGINT NOT NULL REFERENCES demand_accounts(id) ON DELETE CASCADE,
      inventory_id BIGINT REFERENCES demand_inventories(id) ON DELETE SET NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'identified',
      target_tonnes NUMERIC(18,3) NOT NULL CHECK (target_tonnes > 0),
      target_basis VARCHAR(50) NOT NULL DEFAULT 'custom',
      claim_purpose VARCHAR(50) NOT NULL DEFAULT 'voluntary_offset',
      target_year INTEGER,
      budget_usd NUMERIC(18,2),
      max_price_usd_tonne NUMERIC(14,4),
      preferred_country VARCHAR(100),
      preferred_registry VARCHAR(120),
      preferred_project_type VARCHAR(180),
      priority_score INTEGER NOT NULL DEFAULT 0 CHECK (priority_score BETWEEN 0 AND 100),
      constraints JSONB NOT NULL DEFAULT '{}'::jsonb,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS demand_matches (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      opportunity_id BIGINT NOT NULL REFERENCES demand_opportunities(id) ON DELETE CASCADE,
      source_kind VARCHAR(30) NOT NULL,
      source_id BIGINT NOT NULL,
      matched_tonnes NUMERIC(18,3) NOT NULL CHECK (matched_tonnes > 0),
      score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
      claim_ready BOOLEAN NOT NULL DEFAULT FALSE,
      execution_mode VARCHAR(30) NOT NULL DEFAULT 'assisted',
      registry VARCHAR(120),
      project_name VARCHAR(255),
      vintage VARCHAR(80),
      indicative_price_usd_tonne NUMERIC(14,4),
      evidence_url TEXT,
      rationale JSONB NOT NULL DEFAULT '{}'::jsonb,
      status VARCHAR(30) NOT NULL DEFAULT 'proposed',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(opportunity_id,source_kind,source_id)
    );

    CREATE INDEX IF NOT EXISTS demand_accounts_pipeline_idx
      ON demand_accounts(status,contact_status,lead_score DESC,updated_at DESC);
    CREATE INDEX IF NOT EXISTS demand_accounts_source_idx
      ON demand_accounts(source,country,updated_at DESC);
    CREATE INDEX IF NOT EXISTS demand_inventories_account_idx
      ON demand_inventories(account_id,inventory_year DESC);
    CREATE INDEX IF NOT EXISTS demand_opportunities_pipeline_idx
      ON demand_opportunities(status,priority_score DESC,created_at DESC);
    CREATE INDEX IF NOT EXISTS demand_matches_opportunity_idx
      ON demand_matches(opportunity_id,claim_ready DESC,score DESC);
  `);
}
