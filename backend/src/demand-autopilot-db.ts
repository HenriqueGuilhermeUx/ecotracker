import { pool } from "./db.js";

export async function initDemandAutopilotDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS demand_autopilot_settings (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton=TRUE),
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      min_lead_score INTEGER NOT NULL DEFAULT 50 CHECK (min_lead_score BETWEEN 0 AND 100),
      min_operational_tonnes NUMERIC(18,3) NOT NULL DEFAULT 100 CHECK (min_operational_tonnes >= 0),
      target_percent NUMERIC(6,2) NOT NULL DEFAULT 100 CHECK (target_percent > 0 AND target_percent <= 100),
      max_accounts_per_run INTEGER NOT NULL DEFAULT 100 CHECK (max_accounts_per_run BETWEEN 1 AND 1000),
      interval_minutes INTEGER NOT NULL DEFAULT 360 CHECK (interval_minutes BETWEEN 15 AND 10080),
      last_run_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    INSERT INTO demand_autopilot_settings(singleton)
    VALUES(TRUE)
    ON CONFLICT(singleton) DO NOTHING;

    CREATE TABLE IF NOT EXISTS demand_autopilot_runs (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      status VARCHAR(30) NOT NULL DEFAULT 'running',
      trigger_mode VARCHAR(30) NOT NULL DEFAULT 'manual',
      settings_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      accounts_scanned INTEGER NOT NULL DEFAULT 0,
      accounts_qualified INTEGER NOT NULL DEFAULT 0,
      opportunities_created INTEGER NOT NULL DEFAULT 0,
      opportunities_reused INTEGER NOT NULL DEFAULT 0,
      proposals_created INTEGER NOT NULL DEFAULT 0,
      fully_covered INTEGER NOT NULL DEFAULT 0,
      sourcing_required INTEGER NOT NULL DEFAULT 0,
      target_tonnes NUMERIC(24,3) NOT NULL DEFAULT 0,
      covered_tonnes NUMERIC(24,3) NOT NULL DEFAULT 0,
      uncovered_tonnes NUMERIC(24,3) NOT NULL DEFAULT 0,
      errors JSONB NOT NULL DEFAULT '[]'::jsonb,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE demand_opportunities
      ADD COLUMN IF NOT EXISTS autopilot_key TEXT,
      ADD COLUMN IF NOT EXISTS autopilot_run_id BIGINT REFERENCES demand_autopilot_runs(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS autopilot_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

    CREATE UNIQUE INDEX IF NOT EXISTS demand_opportunities_autopilot_key_uidx
      ON demand_opportunities(autopilot_key)
      WHERE autopilot_key IS NOT NULL;

    CREATE INDEX IF NOT EXISTS demand_autopilot_runs_created_idx
      ON demand_autopilot_runs(created_at DESC);
    CREATE INDEX IF NOT EXISTS demand_opportunities_autopilot_idx
      ON demand_opportunities(account_id,inventory_id,autopilot_key,status)
      WHERE autopilot_key IS NOT NULL;
  `);
}
