import { pool } from "./db.js";

const MARKET_SEED_SQL = `
  INSERT INTO monitored_assets
    (registry,project_name,source_reference,source_url,asset_type,quality_tier,description,pricing_mode,availability_status,source_status,min_order_kg,active)
  VALUES
    ('Regen Network','Eco-créditos do Regen Marketplace','regen-marketplace','https://app.regen.network/','carbon','screening','Ordens públicas on-chain. Volume, moedas e referências de preço são monitorados; a execução é confirmada antes da cobrança.','quote','monitoring','connected',100,TRUE),
    ('Open Forest Protocol','Projetos de reflorestamento OFP','ofp-projects','https://www.openforestprotocol.org/','carbon-removal','premium','Projetos florestais com monitoramento digital. O EcoTracker solicita lote, preço e prazo diretamente ao canal de originação.','quote','monitoring','manual',1000,TRUE),
    ('Coorest Carbon Standard','Créditos de remoção Coorest','coorest-removals','https://coorest.eu/','carbon-removal','premium','Ativos de remoção monitorados digitalmente. A fonte, o lote e as condições comerciais são validados antes da proposta.','quote','monitoring','manual',100,TRUE)
  ON CONFLICT (registry,source_reference) DO UPDATE SET
    project_name=EXCLUDED.project_name,
    source_url=EXCLUDED.source_url,
    asset_type=EXCLUDED.asset_type,
    quality_tier=EXCLUDED.quality_tier,
    description=EXCLUDED.description,
    min_order_kg=EXCLUDED.min_order_kg,
    active=TRUE,
    updated_at=NOW();
`;

export async function ensureMarketSeedAssets(): Promise<void> {
  await pool.query(MARKET_SEED_SQL);
}

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

  await ensureMarketSeedAssets();
}

// Marketplace localization is intentionally applied at projection time rather than
// mutating registry/provider evidence. `description_original` always preserves the
// source text. The PT-BR summary is deterministic and category-based so no external
// translation service or AI call can alter climate claims at runtime.
export const assetProjection = `a.*,
  a.description AS description_original,
  CASE
    WHEN a.description IS NULL OR BTRIM(a.description)='' THEN a.description
    WHEN a.description ~* '[áàâãéêíóôõúç]' OR a.description ~* '\\m(projeto|crédito|carbono|emissões|florestal|agricultura|conservação|energia|redução|remoção|famílias|comunidades)\\M' THEN a.description
    WHEN a.description ~* 'smallholder farms regenerative agriculture' THEN 'Agricultura regenerativa em pequenas propriedades rurais, com práticas voltadas à saúde do solo, resiliência produtiva e armazenamento de carbono.'
    WHEN a.description ~* 'award winning evas project' AND a.description ~* '(deforestation|environmental conservation)' THEN 'Projeto EVAS premiado que ajuda a evitar o desmatamento e ampliar a conservação ambiental, gerando benefícios climáticos e locais associados.'
    WHEN a.description ~* 'sichuan' AND a.description ~* 'rural' AND a.description ~* 'biogas' THEN 'Programa de desenvolvimento de biogás para famílias rurais de baixa renda em Sichuan, na China, reduzindo emissões por meio do aproveitamento energético de resíduos orgânicos.'
    WHEN a.description ~* 'solar cooking' AND a.description ~* 'refugee' AND a.description ~* 'chad' THEN 'Projeto de cocção solar para famílias refugiadas no Chade, reduzindo o consumo de combustíveis tradicionais, emissões e pressão sobre recursos florestais.'
    WHEN a.description ~* '(regenerative agriculture|regenerative farming|soil carbon|smallholder farm)' THEN 'Projeto de agricultura regenerativa que melhora o manejo do solo, a resiliência das propriedades rurais e o armazenamento de carbono.'
    WHEN a.description ~* '(solar cooking|solar cooker|clean cooking|cookstove|cook stove)' THEN 'Projeto de cocção limpa ou solar que reduz o uso de combustíveis tradicionais, as emissões associadas e a pressão sobre recursos florestais.'
    WHEN a.description ~* '(biogas|biodigester|digester)' THEN 'Projeto de biogás que aproveita resíduos orgânicos para gerar energia mais limpa e reduzir emissões de metano e o uso de combustíveis convencionais.'
    WHEN a.description ~* '(avoided deforestation|prevents deforestation|forest conservation|forest protection|REDD)' THEN 'Projeto de conservação florestal que busca evitar o desmatamento, proteger estoques de carbono e fortalecer benefícios ambientais e sociais locais.'
    WHEN a.description ~* '(reforestation|afforestation|revegetation|forest restoration)' THEN 'Projeto de restauração e recomposição florestal voltado à remoção de CO₂ da atmosfera, recuperação de ecossistemas e aumento dos estoques de carbono.'
    WHEN a.description ~* '(mangrove|blue carbon|seagrass|coastal wetland)' THEN 'Projeto de carbono azul e conservação costeira, com foco na proteção ou restauração de ecossistemas que armazenam carbono e sustentam biodiversidade.'
    WHEN a.description ~* 'biochar' THEN 'Projeto de remoção de carbono por biochar, convertendo biomassa em material estável que pode armazenar carbono por longos períodos e melhorar o solo.'
    WHEN a.description ~* '(direct air capture|carbon capture)' THEN 'Projeto de remoção de CO₂ por captura tecnológica, com armazenamento durável do carbono capturado.'
    WHEN a.description ~* '(methane|landfill|waste gas|manure)' THEN 'Projeto de redução de metano por captura, tratamento ou aproveitamento de gases provenientes de resíduos, aterros ou atividades agropecuárias.'
    WHEN a.description ~* '(wind power|wind farm|wind energy)' THEN 'Projeto de energia eólica que substitui geração mais intensiva em carbono e contribui para a redução de emissões do sistema elétrico.'
    WHEN a.description ~* '(solar power|photovoltaic|solar energy)' THEN 'Projeto de energia solar que amplia a geração renovável e reduz emissões associadas a fontes energéticas mais intensivas em carbono.'
    WHEN a.description ~* '(renewable energy|hydropower|hydroelectric)' THEN 'Projeto de energia renovável voltado à substituição de fontes mais intensivas em carbono e à redução de emissões de gases de efeito estufa.'
    WHEN a.description ~* '(electric vehicle|e-mobility|electromobility)' THEN 'Projeto de mobilidade de baixo carbono que reduz emissões do transporte por meio de tecnologias e operações mais eficientes ou eletrificadas.'
    WHEN a.description ~* '(safe drinking water|water purification)' THEN 'Projeto de acesso e tratamento de água que pode reduzir emissões associadas à fervura ou ao tratamento convencional e gerar benefícios sociais locais.'
    WHEN a.description ~* '(environmental conservation|biodiversity|conservation)' THEN 'Projeto de conservação ambiental que protege ecossistemas, biodiversidade e estoques de carbono, com benefícios climáticos e socioambientais associados.'
    ELSE CONCAT('Projeto de crédito de carbono registrado em ',a.registry,'. ',CASE WHEN a.location IS NOT NULL AND BTRIM(a.location)<>'' THEN CONCAT('Localização: ',a.location,'. ') ELSE '' END,CASE WHEN a.vintage IS NOT NULL AND BTRIM(a.vintage)<>'' THEN CONCAT('Vintage ',a.vintage,'. ') ELSE '' END,'A descrição original do provedor permanece preservada no registro EcoTracker para auditoria.')
  END AS description,
  CASE WHEN a.source_price_usd_ton IS NULL THEN NULL ELSE ROUND((((a.source_price_usd_ton*a.fx_brl_usd)*(1+a.service_margin_pct/100.0))+a.fixed_fee_brl)/1000.0,4) END AS indicative_price_brl_kg,
  CASE WHEN a.source_price_usd_ton IS NULL THEN NULL ELSE ROUND(((a.source_price_usd_ton*a.fx_brl_usd)*(1+a.service_margin_pct/100.0))+a.fixed_fee_brl,2) END AS indicative_price_brl_ton`;