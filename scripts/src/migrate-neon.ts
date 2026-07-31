/**
 * One-time schema migration for Neon database.
 * Creates all tables defined in lib/db/src/schema/index.ts.
 * Safe to re-run — uses CREATE TABLE IF NOT EXISTS and ADD COLUMN IF NOT EXISTS.
 */
import pg from "pg";

const { Pool } = pg;

const connectionString = process.env.NEON_DATABASE_URL;
if (!connectionString) {
  throw new Error("NEON_DATABASE_URL must be set");
}

const pool = new Pool({ connectionString });

const sql = `
CREATE TABLE IF NOT EXISTS system_settings (
  id                        INTEGER PRIMARY KEY,
  call_noise_min            NUMERIC NOT NULL DEFAULT '0.0000',
  put_noise_min             NUMERIC NOT NULL DEFAULT '0.6000',
  global_debounce_seconds   INTEGER NOT NULL DEFAULT 15,
  sniper_call_er_min        NUMERIC NOT NULL DEFAULT '0.00',
  sniper_put_er_min         NUMERIC NOT NULL DEFAULT '0.60',
  balanced_call_er_min      NUMERIC NOT NULL DEFAULT '0.10',
  balanced_put_er_min       NUMERIC NOT NULL DEFAULT '0.40',
  aggressive_call_er_min    NUMERIC NOT NULL DEFAULT '0.20',
  aggressive_put_er_min     NUMERIC NOT NULL DEFAULT '0.30',
  sniper_z_max              NUMERIC NOT NULL DEFAULT '1.5',
  balanced_z_max            NUMERIC NOT NULL DEFAULT '2.0',
  aggressive_z_max          NUMERIC NOT NULL DEFAULT '2.5',
  auto_er_trending          NUMERIC NOT NULL DEFAULT '0.65',
  auto_er_ranging           NUMERIC NOT NULL DEFAULT '0.45',
  sniper_exhaustion_call    NUMERIC NOT NULL DEFAULT '0.75',
  sniper_exhaustion_put     NUMERIC NOT NULL DEFAULT '0.25',
  balanced_exhaustion_call  NUMERIC NOT NULL DEFAULT '0.80',
  balanced_exhaustion_put   NUMERIC NOT NULL DEFAULT '0.20',
  aggressive_exhaustion_call NUMERIC NOT NULL DEFAULT '0.90',
  aggressive_exhaustion_put  NUMERIC NOT NULL DEFAULT '0.10',
  sniper_required_votes     INTEGER NOT NULL DEFAULT 3,
  balanced_required_votes   INTEGER NOT NULL DEFAULT 3,
  aggressive_required_votes INTEGER NOT NULL DEFAULT 2,
  confidence_er_floor       NUMERIC NOT NULL DEFAULT '0.40',
  confidence_er_ceiling     NUMERIC NOT NULL DEFAULT '0.80',
  confidence_z_extreme      NUMERIC NOT NULL DEFAULT '2.50',
  sniper_strike_er_floor    NUMERIC NOT NULL DEFAULT '0.70',
  sniper_strike_er_ceiling  NUMERIC NOT NULL DEFAULT '1.00',
  sniper_strike_accel_min   NUMERIC NOT NULL DEFAULT '1.50',
  sniper_strike_max_ticks   INTEGER NOT NULL DEFAULT 10,
  momentum_ride_er_floor    NUMERIC NOT NULL DEFAULT '0.50',
  momentum_ride_er_medium   NUMERIC NOT NULL DEFAULT '0.65',
  momentum_ride_er_low      NUMERIC NOT NULL DEFAULT '0.55',
  expiry_min_sample         INTEGER NOT NULL DEFAULT 30
);

CREATE TABLE IF NOT EXISTS trade_logs (
  id                    INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id            TEXT NOT NULL DEFAULT 'unknown',
  execution_type        TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'PENDING',
  direction             TEXT NOT NULL,
  symbol                TEXT NOT NULL,
  effective_mode        TEXT NOT NULL,
  duration_target       INTEGER NOT NULL,
  duration_unit         TEXT NOT NULL,
  entry_price           NUMERIC NOT NULL,
  noise_at_entry        NUMERIC NOT NULL,
  z_score_at_entry      NUMERIC NOT NULL,
  er_at_entry           NUMERIC NOT NULL DEFAULT '0',
  acceleration_at_entry NUMERIC NOT NULL DEFAULT '0',
  stake                 NUMERIC,
  exit_price            NUMERIC,
  pnl                   NUMERIC,
  resolved_at           TIMESTAMP,
  created_at            TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS symbol_config (
  symbol        TEXT PRIMARY KEY,
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  call_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
  put_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS suppression_logs (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  symbol          TEXT NOT NULL,
  direction       TEXT NOT NULL,
  suppressed_at   TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS market_profiles (
  market_type               TEXT PRIMARY KEY,
  sniper_call_er_min        NUMERIC NOT NULL DEFAULT '0.05',
  sniper_put_er_min         NUMERIC NOT NULL DEFAULT '0.05',
  sniper_z_max              NUMERIC NOT NULL DEFAULT '1.5',
  balanced_call_er_min      NUMERIC NOT NULL DEFAULT '0.03',
  balanced_put_er_min       NUMERIC NOT NULL DEFAULT '0.03',
  balanced_z_max            NUMERIC NOT NULL DEFAULT '1.8',
  aggressive_call_er_min    NUMERIC NOT NULL DEFAULT '0.02',
  aggressive_put_er_min     NUMERIC NOT NULL DEFAULT '0.02',
  aggressive_z_max          NUMERIC NOT NULL DEFAULT '2.2',
  updated_at                TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Seed default market profiles if none exist
INSERT INTO market_profiles (market_type)
VALUES ('synthetic'), ('forex'), ('metals'), ('bull_bear'), ('step')
ON CONFLICT (market_type) DO NOTHING;
`;

try {
  await pool.query(sql);
  console.log("✅ Schema applied successfully to Neon database");
} catch (err) {
  console.error("❌ Migration failed:", err);
  process.exit(1);
} finally {
  await pool.end();
}
