import { pool } from "./db.js";

export async function initMarketDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS monitored_assets (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      registry VARCHAR(120) NOT NULL,
      project_name VARCHAR(255) NOT NULL,
      source_reference VARCHAR(180) NOT NULL,
      source_url TEXT,
      methodology VARCHAR(255),
      location VARCHAR(255),
      vintage VARCHAR(40),
      asset_type VARCHAR(40) NOT NULL DEFAULT 'carbon',
      quality_tier VARCHAR(40) NOT NULL DEFAULT 'screening',
      description TEXT,
      source_price_usd_ton NUMERIC(14,4),
      fx_brl_usd NUMERIC(12,4) NOT NULL DEFAULT 5.50,
      service_margin_pct NUMERIC(8,2) NOT NULL DEFAULT 25,
      fixed_fee_brl NUMERIC(12,2) NOT NULL DEFAULT 0,
      available_tons NUMERIC(16,6),
      min_order_kg INTEGER NOT NULL DEFAULT 100 CHECK (min_order_kg > 0),
      pricing_mode VARCHAR(20) NOT NULL DEFAULT 'quote',
      availability_status VARCHAR(30) NOT NULL DEFAULT 'monitoring',
      source_status VARCHAR(30) NOT NULL DEFAULT 'manual',
      monitor_details JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_checked_at TIMESTAMPTZ,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(registry, source_reference)
    );
    CREATE TABLE IF NOT EXISTS quote_requests (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      asset_id BIGINT NOT NULL REFERENCES monitored_assets(id),
      buyer_name VARCHAR(255) NOT NULL,
      buyer_email VARCHAR(320) NOT NULL,
      buyer_phone VARCHAR(40),
      company_name VARCHAR(255),
      tax_id VARCHAR(40),
      requested_kg INTEGER NOT NULL CHECK (requested_kg > 0),
      delivery_mode VARCHAR(20) NOT NULL DEFAULT 'email',
      wallet_address VARCHAR(100),
      purpose VARCHAR(120) NOT NULL DEFAULT 'neutralization',
      indicative_price_per_kg NUMERIC(14,4),
      indicative_total NUMERIC(14,2),
      final_total NUMERIC(14,2),
      status VARCHAR(30) NOT NULL DEFAULT 'requested',
      quote_expires_at TIMESTAMPTZ,
      admin_notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS quote_requests_status_idx ON quote_requests(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS monitored_assets_active_idx ON monitored_assets(active, updated_at DESC);
  `);
  await pool.query(`
    INSERT INTO monitored_assets
      (registry,project_name,source_reference,source_url,asset_type,quality_tier,description,pricing_mode,availability_status,source_status,min_order_kg)
    VALUES
      ('Regen Network','Eco-créditos do Regen Marketplace','regen-marketplace','https://app.regen.network/','carbon','screening','Ordens públicas do marketplace on-chain. Disponibilidade e preço final são confirmados antes da cobrança.','quote','monitoring','connected',100),
      ('Open Forest Protocol','Projetos de reflorestamento OFP','ofp-projects','https://www.openforestprotocol.org/','carbon-removal','premium','Projetos florestais com monitoramento digital. Operação depende de cotação e confirmação do desenvolvedor.','quote','monitoring','manual',1000),
      ('Coorest Carbon Standard','Créditos de remoção Coorest','coorest-removals','https://coorest.eu/','carbon-removal','premium','Ativos de remoção monitorados digitalmente. A fonte e o lote são validados antes da proposta.','quote','monitoring','manual',100)
    ON CONFLICT (registry,source_reference) DO NOTHING;
  `);
}

export const assetProjection = `a.*,
  CASE WHEN a.source_price_usd_ton IS NULL THEN NULL ELSE ROUND((((a.source_price_usd_ton*a.fx_brl_usd)*(1+a.service_margin_pct/100.0))+a.fixed_fee_brl)/1000.0,4) END AS indicative_price_brl_kg,
  CASE WHEN a.source_price_usd_ton IS NULL THEN NULL ELSE ROUND(((a.source_price_usd_ton*a.fx_brl_usd)*(1+a.service_margin_pct/100.0))+a.fixed_fee_brl,2) END AS indicative_price_brl_ton`;
