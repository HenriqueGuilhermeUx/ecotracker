import { pool } from "./db.js";

export async function initEligibilityDb(): Promise<void> {
  await pool.query(`
    ALTER TABLE monitored_assets
      ADD COLUMN IF NOT EXISTS claim_category VARCHAR(40) NOT NULL DEFAULT 'climate_contribution',
      ADD COLUMN IF NOT EXISTS eligibility_status VARCHAR(30) NOT NULL DEFAULT 'under_review',
      ADD COLUMN IF NOT EXISTS eligibility_basis TEXT,
      ADD COLUMN IF NOT EXISTS source_unit_status VARCHAR(30) NOT NULL DEFAULT 'unknown',
      ADD COLUMN IF NOT EXISTS vintage_start DATE,
      ADD COLUMN IF NOT EXISTS vintage_end DATE,
      ADD COLUMN IF NOT EXISTS issuance_date DATE,
      ADD COLUMN IF NOT EXISTS commercial_valid_until DATE,
      ADD COLUMN IF NOT EXISTS offer_expires_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS registry_project_id VARCHAR(180),
      ADD COLUMN IF NOT EXISTS registry_batch_id VARCHAR(255),
      ADD COLUMN IF NOT EXISTS registry_evidence_url TEXT,
      ADD COLUMN IF NOT EXISTS retirement_supported BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS fractional_retirement_supported BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS retirement_granularity_kg INTEGER NOT NULL DEFAULT 1000,
      ADD COLUMN IF NOT EXISTS beneficiary_retirement_supported BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS ccp_status VARCHAR(30) NOT NULL DEFAULT 'not_assessed',
      ADD COLUMN IF NOT EXISTS corsia_status VARCHAR(30) NOT NULL DEFAULT 'not_assessed',
      ADD COLUMN IF NOT EXISTS article6_status VARCHAR(30) NOT NULL DEFAULT 'not_assessed',
      ADD COLUMN IF NOT EXISTS vintage_policy_override BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS vintage_exception_reason TEXT,
      ADD COLUMN IF NOT EXISTS eligibility_checked_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS eligibility_risk_flags JSONB NOT NULL DEFAULT '[]'::jsonb;

    ALTER TABLE quote_requests
      ADD COLUMN IF NOT EXISTS claim_category VARCHAR(40),
      ADD COLUMN IF NOT EXISTS eligibility_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

    CREATE TABLE IF NOT EXISTS offset_source_channels (
      id BIGSERIAL PRIMARY KEY,
      provider_key VARCHAR(60) NOT NULL UNIQUE,
      provider_name VARCHAR(180) NOT NULL,
      sourcing_mode VARCHAR(50) NOT NULL,
      min_order_kg INTEGER NOT NULL DEFAULT 1000,
      fractional_supported BOOLEAN NOT NULL DEFAULT FALSE,
      retirement_supported BOOLEAN NOT NULL DEFAULT FALSE,
      beneficiary_retirement_supported BOOLEAN NOT NULL DEFAULT FALSE,
      status VARCHAR(40) NOT NULL DEFAULT 'awaiting_configuration',
      registry_scope TEXT,
      source_url TEXT,
      notes TEXT,
      last_checked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    INSERT INTO offset_source_channels
      (provider_key,provider_name,sourcing_mode,min_order_kg,fractional_supported,retirement_supported,beneficiary_retirement_supported,status,registry_scope,source_url,notes)
    VALUES
      ('carbonmark','Carbonmark API','api_retirement',1,TRUE,TRUE,TRUE,'awaiting_production_key','Listings compatíveis com a API Carbonmark','https://www.carbonmark.com/api-and-integrations','API com cotação e aposentadoria programática; produção depende de onboarding e chave própria.'),
      ('gold-standard','Gold Standard Marketplace','direct_marketplace',1000,FALSE,TRUE,TRUE,'manual_available','Gold Standard Impact Registry','https://marketplace.goldstandard.org/','Canal direto para créditos certificados e aposentadoria; automação comercial depende de integração/parceria.'),
      ('verra-partner','Verra / parceiro de registry','registry_partner',1000,FALSE,TRUE,TRUE,'partner_required','Verified Carbon Standard (VCS)','https://verra.org/programs/verified-carbon-standard/','VCUs devem permanecer no registry e ser aposentados conforme os termos da Verra. Tokenização/related instruments exigem cuidado e eventual consentimento.')
    ON CONFLICT (provider_key) DO UPDATE SET
      provider_name=EXCLUDED.provider_name,
      sourcing_mode=EXCLUDED.sourcing_mode,
      min_order_kg=EXCLUDED.min_order_kg,
      fractional_supported=EXCLUDED.fractional_supported,
      retirement_supported=EXCLUDED.retirement_supported,
      beneficiary_retirement_supported=EXCLUDED.beneficiary_retirement_supported,
      registry_scope=EXCLUDED.registry_scope,
      source_url=EXCLUDED.source_url,
      notes=EXCLUDED.notes,
      updated_at=NOW();

    CREATE INDEX IF NOT EXISTS monitored_assets_claim_idx
      ON monitored_assets(active,claim_category,eligibility_status,commercial_valid_until);
    CREATE INDEX IF NOT EXISTS monitored_assets_registry_status_idx
      ON monitored_assets(source_unit_status,eligibility_checked_at DESC);

    UPDATE monitored_assets
      SET claim_category='climate_contribution',
          eligibility_status=CASE WHEN eligibility_status='eligible' THEN eligibility_status ELSE 'restricted' END,
          eligibility_basis=COALESCE(eligibility_basis,'Ativo ecológico monitorado; não é promovido automaticamente como crédito apto a compensação até a metodologia, o registry, o status da unidade e o claim permitido serem verificados.'),
          eligibility_risk_flags=CASE
            WHEN eligibility_risk_flags='[]'::jsonb THEN '["offset-eligibility-not-verified"]'::jsonb
            ELSE eligibility_risk_flags
          END
      WHERE registry IN ('Regen Network','Open Forest Protocol','Coorest Carbon Standard')
        AND claim_category <> 'voluntary_offset';

    CREATE OR REPLACE FUNCTION ecotracker_quote_eligibility_snapshot()
    RETURNS TRIGGER AS $$
    DECLARE
      a monitored_assets%ROWTYPE;
    BEGIN
      SELECT * INTO a FROM monitored_assets WHERE id=NEW.asset_id;
      IF FOUND THEN
        NEW.claim_category := a.claim_category;
        NEW.eligibility_snapshot := jsonb_build_object(
          'assetId', a.id,
          'registry', a.registry,
          'sourceReference', a.source_reference,
          'claimCategory', a.claim_category,
          'eligibilityStatus', a.eligibility_status,
          'eligibilityBasis', a.eligibility_basis,
          'sourceUnitStatus', a.source_unit_status,
          'vintage', a.vintage,
          'vintageStart', a.vintage_start,
          'vintageEnd', a.vintage_end,
          'commercialValidUntil', a.commercial_valid_until,
          'offerExpiresAt', a.offer_expires_at,
          'registryProjectId', a.registry_project_id,
          'registryBatchId', a.registry_batch_id,
          'registryEvidenceUrl', a.registry_evidence_url,
          'retirementSupported', a.retirement_supported,
          'fractionalRetirementSupported', a.fractional_retirement_supported,
          'retirementGranularityKg', a.retirement_granularity_kg,
          'beneficiaryRetirementSupported', a.beneficiary_retirement_supported,
          'ccpStatus', a.ccp_status,
          'corsiaStatus', a.corsia_status,
          'article6Status', a.article6_status,
          'checkedAt', a.eligibility_checked_at,
          'riskFlags', a.eligibility_risk_flags
        );
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS quote_eligibility_snapshot_before_insert ON quote_requests;
    CREATE TRIGGER quote_eligibility_snapshot_before_insert
      BEFORE INSERT ON quote_requests
      FOR EACH ROW EXECUTE FUNCTION ecotracker_quote_eligibility_snapshot();
  `);
}
