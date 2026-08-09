import { pool } from "./db.js";

export async function initAssistedSourcingDb() {
  await pool.query(`
    CREATE OR REPLACE FUNCTION ecotracker_guard_assisted_source_jobs()
    RETURNS TRIGGER AS $$
    DECLARE
      enabled BOOLEAN;
    BEGIN
      SELECT COALESCE(automation_enabled,FALSE) INTO enabled
      FROM quote_requests
      WHERE id=NEW.quote_id;

      IF enabled=FALSE AND NEW.job_type IN ('source_asset','retire_asset') THEN
        INSERT INTO commerce_events(event_key,quote_id,event_type,provider,payload)
        VALUES(
          CONCAT('assisted-guard:',NEW.quote_id,':',NEW.job_type),
          NEW.quote_id,
          'automation.blocked_assisted_source_job',
          'ecotracker',
          jsonb_build_object('jobType',NEW.job_type,'reason','quote_automation_disabled')
        )
        ON CONFLICT(event_key) DO NOTHING;
        RETURN NULL;
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS guard_assisted_source_jobs_before_insert ON automation_jobs;
    CREATE TRIGGER guard_assisted_source_jobs_before_insert
      BEFORE INSERT ON automation_jobs
      FOR EACH ROW EXECUTE FUNCTION ecotracker_guard_assisted_source_jobs();

    CREATE INDEX IF NOT EXISTS quote_requests_assisted_ops_idx
      ON quote_requests(automation_enabled,payment_status,status,created_at DESC);
  `);
}
