import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.warn("[database] DATABASE_URL is not configured");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
});

export async function initDb(): Promise<void> {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE IF NOT EXISTS carbon_projects (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      registry VARCHAR(100) NOT NULL,
      registry_id VARCHAR(150) NOT NULL,
      methodology VARCHAR(255),
      developer VARCHAR(255),
      vintage VARCHAR(30),
      location VARCHAR(255),
      total_kg BIGINT NOT NULL CHECK (total_kg > 0),
      tokenized_kg BIGINT NOT NULL DEFAULT 0 CHECK (tokenized_kg >= 0),
      retired_kg BIGINT NOT NULL DEFAULT 0 CHECK (retired_kg >= 0),
      certificate_filename VARCHAR(255),
      certificate_mime VARCHAR(120),
      certificate_sha256 VARCHAR(64),
      ipfs_cid VARCHAR(150),
      chain_tx_hash VARCHAR(100),
      verification_status VARCHAR(30) NOT NULL DEFAULT 'pending',
      verification_notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      verified_at TIMESTAMPTZ,
      CONSTRAINT project_volume_limit CHECK (tokenized_kg + retired_kg <= total_kg)
    );

    CREATE TABLE IF NOT EXISTS asset_serial_ranges (
      id BIGSERIAL PRIMARY KEY,
      project_id BIGINT NOT NULL REFERENCES carbon_projects(id) ON DELETE CASCADE,
      registry_key VARCHAR(255) NOT NULL,
      serial_start VARCHAR(255) NOT NULL,
      serial_end VARCHAR(255) NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(registry_key, serial_start, serial_end)
    );

    CREATE TABLE IF NOT EXISTS ecot_batches (
      id BIGSERIAL PRIMARY KEY,
      project_id BIGINT NOT NULL REFERENCES carbon_projects(id),
      total_tokens BIGINT NOT NULL CHECK (total_tokens > 0),
      available_tokens BIGINT NOT NULL CHECK (available_tokens >= 0),
      price_per_token NUMERIC(12,4) NOT NULL CHECK (price_per_token > 0),
      chain_status VARCHAR(20) NOT NULL DEFAULT 'offchain',
      chain_tx_hash VARCHAR(100),
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      public_code UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      batch_id BIGINT NOT NULL REFERENCES ecot_batches(id),
      buyer_name VARCHAR(255),
      buyer_email VARCHAR(320) NOT NULL,
      token_amount BIGINT NOT NULL CHECK (token_amount > 0),
      total_price NUMERIC(14,2) NOT NULL CHECK (total_price >= 0),
      payment_method VARCHAR(20) NOT NULL DEFAULT 'pix',
      payment_status VARCHAR(20) NOT NULL DEFAULT 'pending',
      delivery_status VARCHAR(20) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      confirmed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS distributions (
      id BIGSERIAL PRIMARY KEY,
      batch_id BIGINT NOT NULL REFERENCES ecot_batches(id),
      recipient_name VARCHAR(255),
      recipient_email VARCHAR(320) NOT NULL,
      token_amount BIGINT NOT NULL CHECK (token_amount > 0),
      source VARCHAR(30) NOT NULL DEFAULT 'manual',
      organization_name VARCHAR(255),
      status VARCHAR(20) NOT NULL DEFAULT 'delivered',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS subscription_requests (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(320) NOT NULL,
      monthly_amount NUMERIC(12,2) NOT NULL CHECK (monthly_amount > 0),
      status VARCHAR(20) NOT NULL DEFAULT 'lead',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS reward_leads (
      id BIGSERIAL PRIMARY KEY,
      company_name VARCHAR(255) NOT NULL,
      contact_name VARCHAR(255) NOT NULL,
      email VARCHAR(320) NOT NULL,
      monthly_customers INTEGER,
      message TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'new',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
