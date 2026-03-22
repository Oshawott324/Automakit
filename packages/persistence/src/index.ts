import { Pool } from "pg";

const defaultDatabaseUrl = "postgres://postgres:postgres@127.0.0.1:5432/agentic_polymarket";

export function getDatabaseUrl() {
  return process.env.DATABASE_URL ?? defaultDatabaseUrl;
}

export function createDatabasePool() {
  return new Pool({
    connectionString: getDatabaseUrl(),
  });
}

export async function ensureCoreSchema(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      developer_id TEXT NOT NULL,
      name TEXT NOT NULL,
      runtime_type TEXT NOT NULL,
      public_key TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      verified_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS auth_challenges (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      payload TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS agent_tokens (
      token_hash TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY,
      proposer_agent_id TEXT NOT NULL,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      close_time TIMESTAMPTZ NOT NULL,
      resolution_criteria TEXT NOT NULL,
      source_of_truth_url TEXT NOT NULL,
      resolution_kind TEXT NOT NULL,
      resolution_metadata JSONB NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      origin TEXT NOT NULL,
      signal_source_id TEXT,
      signal_source_type TEXT,
      status TEXT NOT NULL,
      confidence_score DOUBLE PRECISION NOT NULL,
      observation_count INTEGER NOT NULL,
      autonomy_note TEXT NOT NULL,
      linked_market_id TEXT,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS markets (
      id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL UNIQUE,
      event_id TEXT NOT NULL,
      title TEXT NOT NULL,
      subtitle TEXT,
      status TEXT NOT NULL,
      category TEXT NOT NULL,
      close_time TIMESTAMPTZ NOT NULL,
      resolution_source TEXT NOT NULL,
      resolution_kind TEXT NOT NULL,
      resolution_metadata JSONB NOT NULL,
      last_traded_price_yes DOUBLE PRECISION,
      volume_24h DOUBLE PRECISION NOT NULL,
      liquidity_score DOUBLE PRECISION NOT NULL,
      outcomes JSONB NOT NULL,
      rules TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS resolution_cases (
      market_id TEXT PRIMARY KEY REFERENCES markets(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      draft_outcome TEXT,
      final_outcome TEXT,
      canonical_source_url TEXT,
      quorum_threshold INTEGER NOT NULL,
      last_updated_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS resolution_evidence (
      id TEXT PRIMARY KEY,
      market_id TEXT NOT NULL REFERENCES resolution_cases(market_id) ON DELETE CASCADE,
      submitter_agent_id TEXT NOT NULL,
      evidence_type TEXT NOT NULL,
      derived_outcome TEXT NOT NULL,
      summary TEXT NOT NULL,
      source_url TEXT NOT NULL,
      observed_at TIMESTAMPTZ NOT NULL,
      observation_payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      UNIQUE (market_id, submitter_agent_id)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      market_id TEXT NOT NULL REFERENCES markets(id) ON DELETE RESTRICT,
      client_order_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      side TEXT NOT NULL,
      outcome TEXT NOT NULL,
      price DOUBLE PRECISION NOT NULL,
      size DOUBLE PRECISION NOT NULL,
      filled_size DOUBLE PRECISION NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      signed_at TIMESTAMPTZ NOT NULL,
      request_signature TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      canceled_at TIMESTAMPTZ,
      UNIQUE (agent_id, client_order_id)
    );

    CREATE TABLE IF NOT EXISTS fills (
      id TEXT PRIMARY KEY,
      market_id TEXT NOT NULL REFERENCES markets(id) ON DELETE RESTRICT,
      outcome TEXT NOT NULL,
      price DOUBLE PRECISION NOT NULL,
      size DOUBLE PRECISION NOT NULL,
      buy_order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
      sell_order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
      buy_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
      sell_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
      executed_at TIMESTAMPTZ NOT NULL
    );

    ALTER TABLE orders ADD COLUMN IF NOT EXISTS filled_size DOUBLE PRECISION NOT NULL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  `);
}

export function toIsoTimestamp(value: unknown) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return new Date(String(value)).toISOString();
}

export function parseJsonField<T>(value: unknown): T {
  if (typeof value === "string") {
    return JSON.parse(value) as T;
  }

  return value as T;
}

export function toNumberOrNull(value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}
