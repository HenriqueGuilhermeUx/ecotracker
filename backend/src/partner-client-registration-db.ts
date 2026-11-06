import { pool } from "./db.js";

export async function initPartnerClientRegistrationDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS partner_client_registrations (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      account_id BIGINT NOT NULL REFERENCES demand_accounts(id) ON DELETE CASCADE,
      source_opportunity_id BIGINT REFERENCES demand_opportunities(id) ON DELETE SET NULL,
      partner_key VARCHAR(60) NOT NULL DEFAULT 'carbonmark',
      agreement_date DATE NOT NULL DEFAULT DATE '2026-11-06',
      status VARCHAR(40) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','ready_to_send','sent','confirmed','declined','deemed_confirmed','cancelled')),
      client_legal_name VARCHAR(255) NOT NULL,
      client_country VARCHAR(120) NOT NULL,
      covered_affiliates JSONB NOT NULL DEFAULT '[]'::jsonb,
      nature_of_engagement TEXT NOT NULL,
      strategic_account BOOLEAN NOT NULL DEFAULT FALSE,
      expected_credit_type VARCHAR(255),
      expected_volume_tonnes NUMERIC(24,3),
      expected_timing VARCHAR(180),
      partner_contact VARCHAR(320) NOT NULL,
      sent_at TIMESTAMPTZ,
      response_due_at TIMESTAMPTZ,
      confirmation_date DATE,
      decline_ground VARCHAR(20)
        CHECK (decline_ground IS NULL OR decline_ground IN ('3.2(a)','3.2(b)','3.2(c)','other')),
      partner_response TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(account_id,partner_key)
    );

    CREATE INDEX IF NOT EXISTS partner_client_registrations_status_idx
      ON partner_client_registrations(status,response_due_at,updated_at DESC);

    CREATE INDEX IF NOT EXISTS partner_client_registrations_opportunity_idx
      ON partner_client_registrations(source_opportunity_id,updated_at DESC);
  `);
}
