/**
 * PulseEdge — Central Trading Configuration
 *
 * Single source of truth for every numeric threshold, constant, and tuning
 * parameter used across the trading engine, risk engine, duration sizer,
 * and admin dashboard.
 *
 * ── Edit this file to tune the bot ──────────────────────────────────────────
 * No other file should define magic numbers for trading logic.
 */

// ─── Deriv Platform Constants ─────────────────────────────────────────────────

/** Deriv payout multiplier on a winning Rise/Fall binary trade (85 % = 0.85). */
export const DERIV_PAYOUT_RATE = 0.85;

// ─── ER Tier Boundaries (AUTO mode + regime classifier) ──────────────────────

/**
 * Efficiency Ratio tier boundaries used by AUTO consensus mode to select
 * the active gate profile, and by the regime classifier to label market state.
 *
 *   ER ≥ trending  →  AGGRESSIVE (strong directional trend)
 *   ER <  ranging  →  SNIPER     (choppy/ranging market)
 *   otherwise      →  BALANCED
 */
export const ER_TIERS = {
  trending: 0.65,
  ranging:  0.45,
} as const;

// ─── Mode Gate Thresholds ─────────────────────────────────────────────────────

/**
 * Per-mode suppression gate thresholds.
 *
 * SNIPER     — tightest gates; only near-perfect signals survive choppy markets.
 * BALANCED   — moderate confirmation; default mid-trend profile.
 * AGGRESSIVE — widest gates; maximises trade volume in strong trending markets.
 */
export const MODE_THRESHOLDS = {
  SNIPER: {
    noiseMin:       0.60,
    exhaustionCall: 0.75,
    exhaustionPut:  0.25,
    zMax:           1.5,
    requiredVotes:  3,
  },
  BALANCED: {
    noiseMin:       0.40,
    exhaustionCall: 0.80,
    exhaustionPut:  0.20,
    zMax:           1.50,
    requiredVotes:  3,
  },
  AGGRESSIVE: {
    noiseMin:       0.30,
    exhaustionCall: 0.90,
    exhaustionPut:  0.10,
    zMax:           2.5,
    requiredVotes:  2,
  },
} as const;

// ─── Confidence Risk Engine ────────────────────────────────────────────────────

/**
 * Parameters for the Confidence-Weighted stake sizer (Engine 3).
 *
 * erFloor   — ER below this → zero confidence, use base stake only.
 * erCeiling — ER at or above this → full ER confidence, cap removed.
 * zExtreme  — |Z-score| at or above this → zero Z confidence, use base stake.
 */
export const CONFIDENCE_ENGINE = {
  erFloor:   0.40,
  erCeiling: 0.80,
  zExtreme:  2.5,
} as const;

// ─── Dynamic Duration Sizer ───────────────────────────────────────────────────

/**
 * Sniper Strike tier: physics-based dynamic tick interpolation.
 * Activates when ER > erFloor AND |acceleration| > accelMin.
 *
 * erFloor    — minimum ER required to enter Sniper Strike tier.
 * erCeiling  — theoretical max ER (pure directional); maps to apiMin ticks.
 * accelMin   — minimum |acceleration| required to activate.
 * maxTicks   — quantitative tick cap (never exceed this, regardless of API max).
 */
export const SNIPER_STRIKE = {
  erFloor:   0.70,
  erCeiling: 1.00,
  accelMin:  1.5,
  maxTicks:  10,
} as const;

/**
 * Momentum Ride tier: seconds-based duration scaled inversely to noise.
 * Activates when ER > erFloor (and Sniper Strike did not activate).
 *
 * erFloor  — minimum ER for Momentum Ride tier.
 * erMedium — ER below this → multiplier 2× (slightly noisy trend).
 * erLow    — ER below this → multiplier 3× (borderline noisy trend).
 */
export const MOMENTUM_RIDE = {
  erFloor:  0.50,
  erMedium: 0.65,
  erLow:    0.55,
} as const;
