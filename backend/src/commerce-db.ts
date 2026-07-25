import { pool } from "./db.js";

export async function initCommerceDb(): Promise<void> {
  await pool.query(`
    ALTER TABLE quote_requests
      ADD COLUMN IF NOT EXISTS source_cost_brl NUMERIC(14,2),
      ADD COLUMN IF NOT EXISTS payment_fee_brl NUMERIC(14,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS tax_reserve_brl NUMERIC(14,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS gross_revenue_brl NUMERIC(14,2),
      ADD COLUMN IF NOT EXISTS gross_profit_brl NUMERIC(14,2),
      ADD COLUMN IF NOT EXISTS net_profit_brl NUMERIC(14,2),
      ADD COLUMN IF NOT EXISTS payment_provider VARCHAR(40),
      ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20),
      ADD COLUMN IF NOT EXISTS payment_status VARCHAR(30) NOT NULL DEFAULT 'not_started',
      ADD COLUMN IF NOT EXISTS payment_reference VARCHAR(255),
      ADD COLUMN IF NOT EXISTS payment_url TEXT,
      ADD COLUMN IF NOT EXISTS pix_br_code TEXT,
      ADD COLUMN IF NOT EXISTS pix_qr_code_url TEXT,
      ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS sourcing_status VARCHAR(30) NOT NULL DEFAULT 'not_started',
      ADD COLUMN IF NOT EXISTS sourcing_provider VARCHAR(80),
      ADD COLUMN IF NOT EXISTS sourcing_reference VARCHAR(255),
      ADD COLUMN IF NOT EXISTS sourcing_tx_hash VARCHAR(255),
      ADD COLUMN IF NOT EXISTS source_order_id VARCHAR(120),
      ADD COLUMN IF NOT EXISTS source_batch_denom VARCHAR(255),
      ADD COLUMN IF NOT EXISTS retirement_status VARCHAR(30) NOT NULL DEFAULT 'not_started',
      ADD COLUMN IF NOT EXISTS retirement_reference VARCHAR(255),
      ADD COLUMN IF NOT EXISTS retirement_tx_hash VARCHAR(255),
      ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS delivery_status VARCHAR(30) NOT NULL DEFAULT 'not_started',
      ADD COLUMN IF NOT EXISTS delivery_reference VARCHAR(255),
      ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS receipt_status VARCHAR(30) NOT NULL DEFAULT 'not_started',
      ADD COLUMN IF NOT EXISTS nfse_status VARCHAR(30) NOT NULL DEFAULT 'not_started',
      ADD COLUMN IF NOT EXISTS automation_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS pricing_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

    CREATE TABLE IF NOT EXISTS payment_attempts (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      quote_id BIGINT NOT NULL REFERENCES quote_requests(id) ON DELETE CASCADE,
      provider VARCHAR(40) NOT NULL,
      method VARCHAR(20) NOT NULL,
      provider_reference VARCHAR(255),
      status VARCHAR(30) NOT NULL DEFAULT 'created',
      amount_brl NUMERIC(14,2) NOT NULL CHECK (amount_brl > 0),
      provider_fee_brl NUMERIC(14,2) NOT NULL DEFAULT 0,
      checkout_url TEXT,
      pix_br_code TEXT,
      qr_code_url TEXT,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at TIMESTAMPTZ,
      UNIQUE(provider, provider_reference)
    );

    CREATE TABLE IF NOT EXISTS commerce_events (
      id BIGSERIAL PRIMARY KEY,
      event_key TEXT NOT NULL DEFAULT gen_random_uuid()::text UNIQUE,
      quote_id BIGINT REFERENCES quote_requests(id) ON DELETE CASCADE,
      event_type VARCHAR(80) NOT NULL,
      provider VARCHAR(40),
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS automation_jobs (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      quote_id BIGINT NOT NULL REFERENCES quote_requests(id) ON DELETE CASCADE,
      job_type VARCHAR(50) NOT NULL,
      idempotency_key VARCHAR(255) NOT NULL UNIQUE,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 8,
      run_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      result JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_error TEXT,
      locked_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ecot_allocations (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      quote_id BIGINT NOT NULL UNIQUE REFERENCES quote_requests(id) ON DELETE CASCADE,
      amount_kg BIGINT NOT NULL CHECK (amount_kg > 0),
      delivery_mode VARCHAR(20) NOT NULL,
      recipient_email VARCHAR(320) NOT NULL,
      wallet_address VARCHAR(100),
      status VARCHAR(30) NOT NULL DEFAULT 'allocated',
      chain VARCHAR(30) NOT NULL DEFAULT 'internal',
      chain_tx_hash VARCHAR(255),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      delivered_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS fiscal_documents (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      quote_id BIGINT NOT NULL REFERENCES quote_requests(id) ON DELETE CASCADE,
      document_type VARCHAR(20) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      provider VARCHAR(60),
      provider_reference VARCHAR(255),
      document_url TEXT,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      issued_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(quote_id, document_type)
    );

    CREATE INDEX IF NOT EXISTS payment_attempts_quote_idx ON payment_attempts(quote_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS payment_attempts_status_idx ON payment_attempts(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS automation_jobs_ready_idx ON automation_jobs(status, run_after, created_at);
    CREATE INDEX IF NOT EXISTS commerce_events_quote_idx ON commerce_events(quote_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS fiscal_documents_quote_idx ON fiscal_documents(quote_id, document_type);
    CREATE INDEX IF NOT EXISTS quote_requests_payment_idx ON quote_requests(payment_status, created_at DESC);
    CREATE INDEX IF NOT EXISTS quote_requests_workflow_idx ON quote_requests(sourcing_status, retirement_status, delivery_status);
  `);
}
