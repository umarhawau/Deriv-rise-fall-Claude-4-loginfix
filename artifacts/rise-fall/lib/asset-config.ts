/**
 * Dynamic Asset Class Configuration Engine
 *
 * Asymmetric Architecture — ALL asset classes / ALL duration buckets:
 *   Entry Engine : 3 pure tick-formula voters  (MACRO_VEL / MICRO_VEL / ACCEL)
 *                  ALL_MUST_ALIGN (3/3 consensus required)
 *   Suppression  : 3 live gates  (NOISE / EXHAUSTION / VOLATILITY_ZSCORE)
 *                  + MARTINGALE streak-breaker
 *
 * No MA, MACD, RSI, BB, EMA, or any lagging indicator anywhere.
 * Add new assets by adding a config block — zero changes to the trading engine.
 */

import type { ActiveSymbol } from '@deriv/core';

// ─── Core Types ───────────────────────────────────────────────────────────────

export type AssetClass = 'synthetic_index' | 'forex' | 'metal' | 'indices';
export type BucketRegime = 'tick' | 'short' | 'medium' | 'long';
export type AlignmentRule = 'ALL_MUST_ALIGN' | 'MIN_VOTES';
export type GateType =
  | 'MARTINGALE'
  | 'NOISE'
  | 'EXHAUSTION'
  | 'VOLATILITY_ZSCORE';
export type GateAction = 'NEUTRAL' | 'HOLD' | 'REDUCE_CONFIDENCE';
export type DurationUnit = 't' | 's' | 'm' | 'h' | 'd';

export interface SuppressionGate {
  gateType: GateType;
  enabled: boolean;
  /** Meaning varies by gateType — see gate evaluator for details */
  threshold: number;
  action: GateAction;
}

export interface IndicatorStack {
  /** Names of indicators whose votes all matter for signal decision */
  primary: string[];
  /** Secondary indicators — unused in asymmetric architecture, always [] */
  secondary: string[];
  alignmentRule: AlignmentRule;
  /** Required for MIN_VOTES rule: how many primary votes must agree */
  minVotes?: number;
}

// ─── Gate override types (exposed for UI / BotConfig) ─────────────────────────

export interface GateOverride {
  enabled: boolean;
  threshold: number;
}
export type GateOverrides = Partial<Record<GateType, GateOverride>>;

export interface SignalOverrides {
  /** Override the minVotes threshold for MIN_VOTES alignment rule */
  minVotes?: number;
  /** Per-gate enable/threshold overrides — takes precedence over asset-class defaults */
  gates?: GateOverrides;
}

export interface DurationBucket {
  regime: BucketRegime;
  /** Which adaptive duration units map to this bucket */
  appliesTo: DurationUnit[];
  /**
   * For 's' (seconds) unit only: only applies when duration value ≤ this number.
   * Undefined means all values of that unit apply.
   */
  maxSecondsValue?: number;
  indicatorStack: IndicatorStack;
  suppressionGates: SuppressionGate[];
  /**
   * Multiplies the riskMultiplier from BotConfig when this bucket is active.
   */
  riskMultiplier: number;
}

export interface RegimeDetectionParams {
  /** ADX > this = trending market */
  trendThreshold: number;
  /** ADX < this = ranging market */
  rangeThreshold: number;
  /** Volatility % > this = high-volatility / spike mode */
  volatilityHighThreshold: number;
  /** Volatility % < this = compressed / flat market */
  volatilityLowThreshold: number;
}

export interface AssetClassConfig {
  assetClass: AssetClass;
  displayName: string;
  regimeDetection: RegimeDetectionParams;
  durationBuckets: DurationBucket[];
}

// ─── Computed Indicators (shared context for gate evaluation) ─────────────────

export interface ComputedIndicators {
  consecutiveLosses: number;
  // ── Pure tick-based metrics (asymmetric entry engine) ──────────────────────
  /** Signed efficiency ratio over 20 ticks. Range −1 to +1. Positive = upward trend. */
  macroVelocity: number | null;
  /** Signed efficiency ratio over 5 ticks. Range −1 to +1. */
  microVelocity: number | null;
  /** Rate of change of micro velocity: microVel_current − microVel_previous. */
  acceleration: number | null;
  /** Fraction of upticks in last 14 ticks (R_tick). Range 0–1. */
  directionalRatio: number | null;
  /** (currentPrice − mean20) / stdDev20 */
  zScore: number | null;
  /** Unsigned Kaufman ER for the NOISE suppression gate. Range 0–1. */
  efficiencyRatio: number | null;
}

// ─── Shared Asymmetric Stack ──────────────────────────────────────────────────

/** The one and only entry stack — used by every bucket in every asset class. */
const ASYMMETRIC_STACK: IndicatorStack = {
  primary: ['MACRO_VEL', 'MICRO_VEL', 'ACCEL'],
  secondary: [],
  alignmentRule: 'ALL_MUST_ALIGN',
};

/** Build a standard 3-gate + MARTINGALE suppression array.
 *  Thresholds are tuned per asset class; the gate evaluator logic never changes.
 */
function makeGates(
  noiseThreshold: number,
  exhaustionThreshold: number,
  zScoreThreshold: number,
  martingaleThreshold: number,
): SuppressionGate[] {
  return [
    // Gate 1 (Ch6): ER noise filter — veto when market is choppy
    { gateType: 'NOISE',             enabled: true, threshold: noiseThreshold,      action: 'NEUTRAL' },
    // Gate 2 (Ch4): R_tick exhaustion — veto when buyers/sellers exhausted
    { gateType: 'EXHAUSTION',        enabled: true, threshold: exhaustionThreshold, action: 'NEUTRAL' },
    // Gate 3 (Ch5): Z-score extremes — veto at mean-reversion snap zones
    { gateType: 'VOLATILITY_ZSCORE', enabled: true, threshold: zScoreThreshold,    action: 'NEUTRAL' },
    // Streak-breaker: pause after N consecutive losses
    { gateType: 'MARTINGALE',        enabled: true, threshold: martingaleThreshold, action: 'HOLD'    },
  ];
}

// ─── Synthetic Indices Config ─────────────────────────────────────────────────
// Fast tick-by-tick synthetics — tightest NOISE filter, tighter Z-score.

const SYNTHETIC_CONFIG: AssetClassConfig = {
  assetClass: 'synthetic_index',
  displayName: 'Synthetic',
  regimeDetection: {
    trendThreshold: 20,
    rangeThreshold: 15,
    volatilityHighThreshold: 0.30,
    volatilityLowThreshold: 0.02,
  },
  durationBuckets: [
    {
      regime: 'tick',
      appliesTo: ['t'],
      indicatorStack: ASYMMETRIC_STACK,
      suppressionGates: makeGates(0.50, 0.80, 1.50, 3),
      riskMultiplier: 1.5,
    },
    {
      regime: 'short',
      appliesTo: ['s'],
      maxSecondsValue: 30,
      indicatorStack: ASYMMETRIC_STACK,
      suppressionGates: makeGates(0.45, 0.78, 1.75, 4),
      riskMultiplier: 1.3,
    },
    {
      regime: 'medium',
      appliesTo: ['s', 'm'],
      indicatorStack: ASYMMETRIC_STACK,
      suppressionGates: makeGates(0.40, 0.78, 2.00, 5),
      riskMultiplier: 1.2,
    },
  ],
};

// ─── Metals Config ────────────────────────────────────────────────────────────
// Slower-moving assets — more lenient NOISE and wider Z-score band.

const METAL_CONFIG: AssetClassConfig = {
  assetClass: 'metal',
  displayName: 'Metals',
  regimeDetection: {
    trendThreshold: 25,
    rangeThreshold: 20,
    volatilityHighThreshold: 1.2,
    volatilityLowThreshold: 0.10,
  },
  durationBuckets: [
    {
      regime: 'short',
      appliesTo: ['s', 'm'],
      indicatorStack: ASYMMETRIC_STACK,
      suppressionGates: makeGates(0.38, 0.78, 2.00, 3),
      riskMultiplier: 1.4,
    },
    {
      regime: 'medium',
      appliesTo: ['h'],
      indicatorStack: ASYMMETRIC_STACK,
      suppressionGates: makeGates(0.35, 0.80, 2.25, 4),
      riskMultiplier: 1.2,
    },
  ],
};

// ─── Forex Config ─────────────────────────────────────────────────────────────

const FOREX_CONFIG: AssetClassConfig = {
  assetClass: 'forex',
  displayName: 'Forex',
  regimeDetection: {
    trendThreshold: 28,
    rangeThreshold: 22,
    volatilityHighThreshold: 1.0,
    volatilityLowThreshold: 0.08,
  },
  durationBuckets: [
    {
      regime: 'short',
      appliesTo: ['m'],
      indicatorStack: ASYMMETRIC_STACK,
      suppressionGates: makeGates(0.40, 0.78, 1.75, 3),
      riskMultiplier: 1.3,
    },
    {
      regime: 'medium',
      appliesTo: ['h'],
      indicatorStack: ASYMMETRIC_STACK,
      suppressionGates: makeGates(0.38, 0.80, 2.00, 4),
      riskMultiplier: 1.1,
    },
    {
      regime: 'long',
      appliesTo: ['d'],
      indicatorStack: ASYMMETRIC_STACK,
      suppressionGates: makeGates(0.35, 0.82, 2.25, 5),
      riskMultiplier: 1.0,
    },
  ],
};

// ─── Indices Config ────────────────────────────────────────────────────────────

const INDICES_CONFIG: AssetClassConfig = {
  assetClass: 'indices',
  displayName: 'Indices',
  regimeDetection: {
    trendThreshold: 22,
    rangeThreshold: 18,
    volatilityHighThreshold: 0.8,
    volatilityLowThreshold: 0.05,
  },
  durationBuckets: [
    {
      regime: 'short',
      appliesTo: ['t', 's'],
      indicatorStack: ASYMMETRIC_STACK,
      suppressionGates: makeGates(0.42, 0.78, 1.75, 3),
      riskMultiplier: 1.3,
    },
    {
      regime: 'medium',
      appliesTo: ['m', 'h'],
      indicatorStack: ASYMMETRIC_STACK,
      suppressionGates: makeGates(0.38, 0.80, 2.00, 4),
      riskMultiplier: 1.2,
    },
  ],
};

// ─── Asset Config Service ─────────────────────────────────────────────────────

const CONFIG_REGISTRY = new Map<AssetClass, AssetClassConfig>([
  ['synthetic_index', SYNTHETIC_CONFIG],
  ['forex', FOREX_CONFIG],
  ['metal', METAL_CONFIG],
  ['indices', INDICES_CONFIG],
]);

export const AssetConfigService = {
  /** Detect asset class from Deriv ActiveSymbol */
  detectAssetClass(symbol: ActiveSymbol): AssetClass {
    const market = symbol.market.toLowerCase();
    if (market === 'synthetic_index') return 'synthetic_index';
    if (market === 'forex') return 'forex';
    if (market === 'metals') return 'metal';
    if (market === 'indices') return 'indices';
    const sub = symbol.submarket.toLowerCase();
    if (sub.includes('forex')) return 'forex';
    if (sub.includes('metal') || sub.includes('gold') || sub.includes('silver')) return 'metal';
    if (sub.includes('index') || sub.includes('indices')) return 'indices';
    return 'synthetic_index';
  },

  getConfig(assetClass: AssetClass): AssetClassConfig {
    return CONFIG_REGISTRY.get(assetClass) ?? SYNTHETIC_CONFIG;
  },

  /**
   * Resolve which duration bucket applies given the selected adaptive duration.
   * Returns the first matching bucket, or the last bucket as a fallback.
   */
  resolveBucket(config: AssetClassConfig, unit: DurationUnit, value: number): DurationBucket {
    for (const bucket of config.durationBuckets) {
      if (!bucket.appliesTo.includes(unit)) continue;
      if (unit === 's' && bucket.maxSecondsValue !== undefined && value > bucket.maxSecondsValue) continue;
      return bucket;
    }
    return config.durationBuckets[config.durationBuckets.length - 1];
  },

  /** Register or override a config (for hot-reload / testing) */
  registerConfig(config: AssetClassConfig): void {
    CONFIG_REGISTRY.set(config.assetClass, config);
  },
};

// ─── Signal Evaluator ─────────────────────────────────────────────────────────

export type IndicatorVote = 'CALL' | 'PUT' | 'NEUTRAL';

/**
 * Pure tick-formula voters only.
 * MACRO_VEL / MICRO_VEL / ACCEL — always push a vote (null → NEUTRAL so
 * ALL_MUST_ALIGN correctly kills the signal on insufficient data).
 */
function getVotes(stack: string[], ind: ComputedIndicators): IndicatorVote[] {
  const votes: IndicatorVote[] = [];
  for (const name of stack) {
    if (name === 'MACRO_VEL') {
      // Ch1: sign of (P_t − P_{t-21}) / 21
      votes.push(
        ind.macroVelocity === null ? 'NEUTRAL' :
        ind.macroVelocity > 0 ? 'CALL' : ind.macroVelocity < 0 ? 'PUT' : 'NEUTRAL'
      );
    } else if (name === 'MICRO_VEL') {
      // Ch2: sign of (P_t − P_{t-5}) / 5
      votes.push(
        ind.microVelocity === null ? 'NEUTRAL' :
        ind.microVelocity > 0 ? 'CALL' : ind.microVelocity < 0 ? 'PUT' : 'NEUTRAL'
      );
    } else if (name === 'ACCEL') {
      // Ch3: sign of V_micro − V_macro
      votes.push(
        ind.acceleration === null ? 'NEUTRAL' :
        ind.acceleration > 0 ? 'CALL' : ind.acceleration < 0 ? 'PUT' : 'NEUTRAL'
      );
    }
  }
  return votes;
}

function applyAlignmentRule(
  rule: AlignmentRule,
  primaryVotes: IndicatorVote[],
  minVotesOverride?: number,
): 'CALL' | 'PUT' | null {
  if (primaryVotes.length === 0) return null;
  const callCount = primaryVotes.filter(v => v === 'CALL').length;
  const putCount  = primaryVotes.filter(v => v === 'PUT').length;
  const total     = primaryVotes.length;

  if (rule === 'ALL_MUST_ALIGN') {
    // Any NEUTRAL or split = no consensus. Prevents 2/2 from slipping through.
    const neutralCount = primaryVotes.filter(v => v === 'NEUTRAL').length;
    if (neutralCount > 0) return null;
    if (callCount === total) return 'CALL';
    if (putCount  === total) return 'PUT';
  } else if (rule === 'MIN_VOTES') {
    const required = minVotesOverride ?? 3;
    if (callCount >= required) return 'CALL';
    if (putCount  >= required) return 'PUT';
  }
  return null;
}

export interface SignalEvalResult {
  signal: 'CALL' | 'PUT' | null;
  suppressed: boolean;
  suppressReason: string;
  primaryVotes: IndicatorVote[];
  secondaryVotes: IndicatorVote[];
  activeBucket: DurationBucket;
  regime: BucketRegime;
}

/**
 * Evaluate a trade signal using the dynamic config for the given asset + duration.
 * Returns null signal when suppressed or voters don't align.
 */
export function evaluateSignal(
  _config: AssetClassConfig,
  bucket: DurationBucket,
  ind: ComputedIndicators,
  overrides?: SignalOverrides,
): SignalEvalResult {
  const stack = bucket.indicatorStack;
  const primaryVotes = getVotes(stack.primary, ind);

  const rawSignal = applyAlignmentRule(
    stack.alignmentRule,
    primaryVotes,
    overrides?.minVotes ?? stack.minVotes,
  );

  const base: SignalEvalResult = {
    signal: null,
    suppressed: false,
    suppressReason: '',
    primaryVotes,
    secondaryVotes: [],
    activeBucket: bucket,
    regime: bucket.regime,
  };

  if (!rawSignal) return base;

  // Apply suppression gates — user overrides win over asset-class defaults
  for (const baseGate of bucket.suppressionGates) {
    const userGate = overrides?.gates?.[baseGate.gateType];
    const gate: SuppressionGate = userGate
      ? { ...baseGate, enabled: userGate.enabled, threshold: userGate.threshold }
      : baseGate;

    if (!gate.enabled) continue;
    if (gate.action === 'REDUCE_CONFIDENCE') continue;

    let triggered = false;
    switch (gate.gateType) {
      case 'MARTINGALE': {
        if (ind.consecutiveLosses >= gate.threshold) triggered = true;
        break;
      }
      case 'NOISE': {
        // ER below threshold = choppy market — veto regardless of direction
        if (ind.efficiencyRatio !== null && ind.efficiencyRatio < gate.threshold) triggered = true;
        break;
      }
      case 'EXHAUSTION': {
        // R_tick > threshold on a CALL = buyers exhausted; < (1−threshold) on a PUT = sellers exhausted
        if (ind.directionalRatio !== null) {
          const blocked =
            rawSignal === 'CALL'
              ? ind.directionalRatio > gate.threshold
              : ind.directionalRatio < (1 - gate.threshold);
          if (blocked) triggered = true;
        }
        break;
      }
      case 'VOLATILITY_ZSCORE': {
        // Veto buying the statistical top (CALL) or bottom (PUT)
        if (ind.zScore !== null) {
          const blocked =
            rawSignal === 'CALL'
              ? ind.zScore > gate.threshold
              : ind.zScore < -gate.threshold;
          if (blocked) triggered = true;
        }
        break;
      }
    }

    if (triggered) {
      return { ...base, signal: null, suppressed: true, suppressReason: gate.gateType, primaryVotes, secondaryVotes: [] };
    }
  }

  return { ...base, signal: rawSignal, primaryVotes, secondaryVotes: [] };
}
