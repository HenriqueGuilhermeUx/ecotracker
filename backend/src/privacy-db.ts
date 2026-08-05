import { pool } from "./db.js";

export async function initPrivacyDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS privacy_deletion_requests (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      request_email VARCHAR(320),
      email_hash VARCHAR(64) NOT NULL,
      verification_method VARCHAR(30) NOT NULL DEFAULT 'manual',
      status VARCHAR(30) NOT NULL DEFAULT 'pending_verification',
      result JSONB NOT NULL DEFAULT '{}'::jsonb,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS privacy_deletion_status_idx
      ON privacy_deletion_requests(status, requested_at DESC);
    CREATE INDEX IF NOT EXISTS privacy_deletion_email_hash_idx
      ON privacy_deletion_requests(email_hash, requested_at DESC);
  `);
}
