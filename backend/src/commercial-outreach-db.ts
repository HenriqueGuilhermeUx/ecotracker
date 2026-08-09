import { pool } from "./db.js";

export async function initCommercialOutreachDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS demand_proposal_reviews (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      proposal_id BIGINT NOT NULL UNIQUE REFERENCES demand_proposals(id) ON DELETE CASCADE,
      status VARCHAR(30) NOT NULL CHECK (status IN ('approved','rejected','revoked')),
      reviewed_by VARCHAR(255) NOT NULL,
      review_note TEXT,
      rejection_reason TEXT,
      snapshot JSONB,
      snapshot_sha256 VARCHAR(64),
      approved_at TIMESTAMPTZ,
      rejected_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (
        (status='approved' AND snapshot IS NOT NULL AND snapshot_sha256 IS NOT NULL AND approved_at IS NOT NULL)
        OR (status='rejected' AND rejection_reason IS NOT NULL AND rejected_at IS NOT NULL)
        OR (status='revoked' AND revoked_at IS NOT NULL)
      )
    );

    CREATE TABLE IF NOT EXISTS demand_outbox (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      proposal_id BIGINT NOT NULL UNIQUE REFERENCES demand_proposals(id) ON DELETE CASCADE,
      review_id BIGINT NOT NULL REFERENCES demand_proposal_reviews(id) ON DELETE RESTRICT,
      recipient_email VARCHAR(320) NOT NULL,
      recipient_name VARCHAR(255),
      subject VARCHAR(500) NOT NULL,
      text_body TEXT NOT NULL,
      html_body TEXT NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'ready'
        CHECK (status IN ('ready','sending','sent','failed','cancelled')),
      provider VARCHAR(40) NOT NULL DEFAULT 'resend',
      provider_reference VARCHAR(255),
      idempotency_key VARCHAR(256) NOT NULL UNIQUE,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      last_error TEXT,
      sent_at TIMESTAMPTZ,
      cancelled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS demand_outreach_events (
      id BIGSERIAL PRIMARY KEY,
      event_key TEXT NOT NULL DEFAULT gen_random_uuid()::text UNIQUE,
      proposal_id BIGINT NOT NULL REFERENCES demand_proposals(id) ON DELETE CASCADE,
      review_id BIGINT REFERENCES demand_proposal_reviews(id) ON DELETE SET NULL,
      outbox_id BIGINT REFERENCES demand_outbox(id) ON DELETE SET NULL,
      event_type VARCHAR(80) NOT NULL,
      actor VARCHAR(255),
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS demand_proposal_reviews_status_idx
      ON demand_proposal_reviews(status,created_at DESC);
    CREATE INDEX IF NOT EXISTS demand_outbox_status_idx
      ON demand_outbox(status,created_at DESC);
    CREATE INDEX IF NOT EXISTS demand_outreach_events_proposal_idx
      ON demand_outreach_events(proposal_id,created_at DESC);
  `);
}
