'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import type { DerivWS, ActiveSymbol, BuyResponse } from '@deriv/core';
import { pickAdaptiveDuration } from '@/lib/duration-utils';
import type { DurationOption } from '@/lib/duration-utils';
import type { OpenPosition } from '@/lib/types';
import {
  AssetConfigService,
  evaluateSignal,
  type AssetClass,
  type AssetClassConfig,
  type BucketRegime,
  type DurationBucket,
  type IndicatorVote,
  type GateType,
  type GateOverride,
} from '@/lib/asset-config';
import { classifyMarket } from '@/lib/market-classifier';
import { calculateFinalStake, type RiskEngine } from '@/lib/risk-engines';
import { ER_TIERS, MODE_THRESHOLDS } from '@/lib/trading-config';

export type { GateOverride };
export type { GateType };

export type BotStatus = 'idle' | 'warming' | 'analyzing' | 'trading' | 'paused';
export type BotSignal = 'CALL' | 'PUT' | null;
/** @deprecated — kept for migration shim only. Use RiskEngine. */
export type MartingaleMode = 'off' | 'martingale' | 'anti-martingale';
export type { RiskEngine };
export type ConsensusMode = 'SNIPER' | 'BALANCED' | 'AGGRESSIVE' | 'AUTO';
export type MarketRegime = 'TRENDING' | 'RANGING' | 'VOLATILE';

/** Which tier of the 4-Tier Duration Sizer fired for the current trade horizon. */
export type RoutingTier = 'SNIPER' | 'MOMENTUM' | 'MACRO' | 'FAILSAFE' | 'MANUAL';

export interface BotConfig {
  stake: string;
  maxTrades: number;
  maxConsecutiveLosses: number;
  allowEquals: boolean;
  autoSell: boolean;
  /** Take-profit as % of potential profit (payout − stake). E.g. 40 = sell when up 40% of max gain */
  takeProfitPct: number;
  /** Stop-loss as % of stake. E.g. 50 = sell when down 50% of what was paid */
  stopLossPct: number;
  riskEngine: RiskEngine;
  stakeMultiplier: number;
  maxStakeAmount: number;
  // ── Dynamic signal engine ──────────────────────────────────────────────────
  /** Intent-based consensus mode — resolves to a required vote count at runtime */
  consensusMode: ConsensusMode;
  /** % of suppression events to log — 100 = show all, 10 = show 10% (old default) */
  suppressionLogRate: number;
  /** Per-gate enable + threshold overrides. Takes precedence over asset-class defaults. */
  gates: Record<GateType, GateOverride>;
  // ── Duration chooser ───────────────────────────────────────────────────────
  /** 'AUTO' = 4-tier adaptive sizer; 'MANUAL' = user-fixed duration */
  durationMode: 'AUTO' | 'MANUAL';
  /** Unit for manual duration selection */
  manualDurationUnit: 't' | 's' | 'm';
  /** Value for manual duration selection (clamped to API min/max at trade time) */
  manualDurationValue: number;
}

const DEFAULT_GATES: Record<GateType, GateOverride> = {
  MARTINGALE:        { enabled: true, threshold: 3    },
  NOISE:             { enabled: true, threshold: 0.50 }, // ER < 0.50 = choppy — veto
  EXHAUSTION:        { enabled: true, threshold: 0.80 }, // R_tick > 0.80 = buyers exhausted
  VOLATILITY_ZSCORE: { enabled: true, threshold: 1.50 }, // |z| > 1.50 = mean-reversion snap zone
};

const CONFIG_STORAGE_KEY = 'pulseedge_bot_config_v2';
const CONFIG_STORAGE_KEY_V1 = 'uniace_bot_config_v1';

function migrateV1Config(v1: Record<string, unknown>): Partial<BotConfig> {
  const mgMap: Record<string, RiskEngine> = {
    'martingale': 'MARTINGALE',
    'anti-martingale': 'ANTI_MARTINGALE',
  };
  const migrated: Partial<BotConfig> = { ...(v1 as Partial<BotConfig>) };
  if ('martingaleMode' in v1) {
    migrated.riskEngine = mgMap[v1.martingaleMode as string] ?? 'OFF';
    delete (migrated as Record<string, unknown>).martingaleMode;
  }
  return migrated;
}

function loadStoredConfig(): Partial<BotConfig> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Partial<BotConfig>;
    // Migrate from v1 — maps martingaleMode → riskEngine without data loss
    const v1Raw = localStorage.getItem(CONFIG_STORAGE_KEY_V1);
    if (v1Raw) return migrateV1Config(JSON.parse(v1Raw) as Record<string, unknown>);
    return {};
  } catch {
    return {};
  }
}

function persistConfig(cfg: BotConfig) {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(cfg)); } catch { /* ignore */ }
}

export interface BotLogEntry {
  id: number;
  time: string;
  message: string;
  type: 'signal' | 'trade' | 'result' | 'info' | 'warn' | 'win' | 'loss';
}

export interface BotStats {
  totalTrades: number;
  wins: number;
  losses: number;
  consecutiveLosses: number;
  consecutiveWins: number;
  autoSells: number;
}

export interface PnlPoint {
  tradeNum: number;
  pnl: number;
  cumPnl: number;
}

// ── Signal Telemetry ─────────────────────────────────────────────────────────
export type SignalOutcome = 'WIN' | 'LOSS' | 'PENDING' | 'FAILED_EXECUTION';

export interface SignalRecord {
  id: string;
  contractId?: number;
  timestamp: number;
  /** Unix ms when the buy confirmation was received — subtract timestamp for exec lag */
  executedAt?: number;
  direction: 'CALL' | 'PUT';
  voters: { MACRO_VEL: IndicatorVote; MICRO_VEL: IndicatorVote; ACCEL: IndicatorVote };
  votesFor: number;
  votesNeeded: number;
  gates: { er: number; rTick: number | null; zScore: number | null };
  regime: MarketRegime;
  stake: number;
  outcome: SignalOutcome;
  pnlDelta: number;
  resolvedAt?: number;
  ttlExpiry: number;
}

interface SignalContext {
  voters: { MACRO_VEL: IndicatorVote; MICRO_VEL: IndicatorVote; ACCEL: IndicatorVote };
  votesFor: number;
  votesNeeded: number;
  gates: { er: number; rTick: number | null; zScore: number | null };
  regime: MarketRegime;
  /** Resolved effective mode at signal time — stored in Neon for ML feature engineering */
  effectiveMode: 'SNIPER' | 'BALANCED' | 'AGGRESSIVE';
  /** Raw acceleration value at signal time — key XGBoost feature */
  acceleration: number;
  /** Market price at entry — used for Neon LIVE trade record */
  entryPrice: number;
}

const SIGNAL_HISTORY_KEY = 'pulseedge_signal_history_v1';
const SIGNAL_TTL_MS      = 10_000;
const SIGNAL_BUFFER_MAX  = 200;
const SIGNAL_VISIBLE_MAX = 20;

function loadSignalHistory(): SignalRecord[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(SIGNAL_HISTORY_KEY);
    if (!raw) return [];
    const { savedAt, records } = JSON.parse(raw) as { savedAt: number; records: SignalRecord[] };
    if (Date.now() - savedAt > 30 * 60 * 1000) return []; // >30 min old — discard
    return records;
  } catch { return []; }
}

function persistSignalHistory(records: SignalRecord[]) {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(SIGNAL_HISTORY_KEY, JSON.stringify({ savedAt: Date.now(), records })); } catch { /* ignore */ }
}

export interface AdaptiveDuration {
  value: number;
  unit: string;
  label: string;
}

/** Gate arm/clear state for the asymmetric suppression zone */
export type GateState = 'CLEAR' | 'VETO';
export interface GateStates {
  noise: GateState;
  exhaustion: GateState;
  volatility: GateState;
}

/**
 * An in-memory ghost trade — a vetoed signal being tracked to resolution.
 * Held in pendingGhosts useRef; never stored in React state to avoid re-renders.
 */
interface GhostTrade {
  id: number;
  direction: 'CALL' | 'PUT';
  entryPrice: number;
  /** Tick index (when unit='t') or epoch-ms timestamp (when unit='s'/'m') */
  expiryTarget: number;
  expiryUnit: 't' | 's' | 'm';
}

/** Asymmetric engine snapshot — 3 entry engine voters + raw gate metric values */
export interface IndicatorSnapshot {
  macroVote: IndicatorVote;
  microVote: IndicatorVote;
  accelVote: IndicatorVote;
  erValue: number | null;
  rTickValue: number | null;
  zScoreValue: number | null;
}

export interface UseAutotradeReturn {
  isEnabled: boolean;
  enable: () => void;
  disable: () => void;
  status: BotStatus;
  signal: BotSignal;
  adaptiveDuration: AdaptiveDuration | null;
  volatility: number | null;
  /** Ring buffer of the last 60 trimmed-mean volPct readings (newest last) */
  volHistory: number[];
  indicators: IndicatorSnapshot | null;
  assetClass: AssetClass | null;
  assetConfig: AssetClassConfig | null;
  activeRegime: BucketRegime | null;
  activeBucket: DurationBucket | null;
  botPositions: OpenPosition[];
  currentStake: string;
  log: BotLogEntry[];
  stats: BotStats;
  config: BotConfig;
  setConfig: (cfg: Partial<BotConfig>) => void;
  sessionPnl: number;
  pnlHistory: PnlPoint[];
  efficiencyRatio: number | null;
  activeVotes: number;
  marketRegime: MarketRegime | null;
  /** Live 3-gate suppression state for the UI */
  gateStates: GateStates | null;
  /** Resolved effective mode (AUTO resolves to SNIPER/BALANCED/AGGRESSIVE live) */
  effectiveMode: 'SNIPER' | 'BALANCED' | 'AGGRESSIVE';
  /** Signal telemetry — last 20 records flushed every 500 ms */
  signalHistory: SignalRecord[];
  /** Which tier of the 4-Tier Duration Sizer fired (updates every tick). */
  routingTier: RoutingTier | null;
  /** The 4× dynamic gate lookback period currently in use (in ticks). */
  dynamicLookback: number;
  /** Live API duration options for the active symbol (used to validate/display manual range). */
  durationOptions: DurationOption[];
  /** Session suppression counts per symbol (reset on bot restart). */
  suppressionCounts: Map<string, { call: number; put: number; all: number }>;
}

// ─── Consensus Mode + gate-threshold resolvers ────────────────────────────────

/** Ch6 — Unsigned Kaufman ER: |Net| / Path over `period` ticks. Range 0–1. */
function computeEfficiencyRatio(prices: number[], period = 10): number {
  // Fail-closed: insufficient data → return 0.0 (pure noise).
  // A warm-up ER of 0.5 (neutral) would pass a 0.35 CALL threshold and allow
  // a live trade based on a fabricated number. 0.0 guarantees every gate vetoes.
  if (prices.length < period + 1) return 0.0;
  const recent = prices.slice(-(period + 1));
  const directional = Math.abs(recent[recent.length - 1] - recent[0]);
  const total = recent.slice(1).reduce((sum, p, i) => sum + Math.abs(p - recent[i]), 0);
  if (total === 0) return 1;
  return Math.min(1, Math.max(0, directional / total));
}

/** Ch1 — Macro Tick Velocity: (P_t − P_{t-21}) / 21 */
function computeVMacro(prices: number[]): number | null {
  if (prices.length < 22) return null;
  return (prices[prices.length - 1] - prices[prices.length - 22]) / 21;
}

/** Ch2 — Micro Tick Velocity: (P_t − P_{t-5}) / 5 */
function computeVMicro(prices: number[]): number | null {
  if (prices.length < 6) return null;
  return (prices[prices.length - 1] - prices[prices.length - 6]) / 5;
}

/** Ch3 — Tick Acceleration: A_t = V_micro − V_macro (spec-exact cross-channel) */
function computeAcceleration(prices: number[]): number | null {
  const vMicro = computeVMicro(prices);
  const vMacro = computeVMacro(prices);
  if (vMicro === null || vMacro === null) return null;
  return vMicro - vMacro;
}

/**
 * Ch4 — Tick Directional Ratio: ups / totalChanges over last 14 ticks.
 * Denominator excludes flat ticks (spec-exact). Range 0–1.
 */
function computeDirectionalRatio(prices: number[], period = 14): number | null {
  if (prices.length < period + 1) return null;
  const slice = prices.slice(-(period + 1));
  let ups = 0, totalChanges = 0;
  for (let i = 1; i < slice.length; i++) {
    if (slice[i] > slice[i - 1]) ups++;
    if (slice[i] !== slice[i - 1]) totalChanges++;
  }
  // Fail-closed: a perfectly flat market has no directional signal.
  // Returning null skips the exhaustion gate entirely, rather than passing
  // a fake 0.5 that could incorrectly allow a trade through.
  return totalChanges === 0 ? null : ups / totalChanges;
}

/** Ch5 — Z-score of the latest price vs the last `period` ticks (20-tick rolling window). */
function computeZScore(prices: number[], period = 20): number | null {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);
  if (stdDev < 1e-10) return 0;
  return (prices[prices.length - 1] - mean) / stdDev;
}

// ─── Gate threshold interface ──────────────────────────────────────────────────
interface GateThresholds {
  noiseMin: number;
  exhaustionCall: number;
  exhaustionPut: number;
  zMax: number;
  /** Always a resolved concrete mode (never 'AUTO') — resolveGateThresholds always resolves via resolveEffectiveMode */
  effective: 'SNIPER' | 'BALANCED' | 'AGGRESSIVE';
}

interface ModeConfig extends GateThresholds {
  /** How many of the 3 primary indicators must agree to fire a trade. */
  requiredVotes: number;
}

const MODE_CONFIG: Record<'SNIPER' | 'BALANCED' | 'AGGRESSIVE', ModeConfig> = {
  SNIPER:     { ...MODE_THRESHOLDS.SNIPER,     effective: 'SNIPER'     },
  BALANCED:   { ...MODE_THRESHOLDS.BALANCED,   effective: 'BALANCED'   },
  AGGRESSIVE: { ...MODE_THRESHOLDS.AGGRESSIVE, effective: 'AGGRESSIVE' },
};

/** Resolve the concrete effective mode from a ConsensusMode + live ER. */
interface DynamicEngineSettings {
  autoErTrending?: number; autoErRanging?: number;
  sniperExhaustionCall?: number; sniperExhaustionPut?: number;
  balancedExhaustionCall?: number; balancedExhaustionPut?: number;
  aggressiveExhaustionCall?: number; aggressiveExhaustionPut?: number;
  sniperRequiredVotes?: number; balancedRequiredVotes?: number; aggressiveRequiredVotes?: number;
}

function resolveEffectiveMode(mode: ConsensusMode, er: number, erTrending: number = ER_TIERS.trending, erRanging: number = ER_TIERS.ranging): 'SNIPER' | 'BALANCED' | 'AGGRESSIVE' {
  if (mode !== 'AUTO') return mode as 'SNIPER' | 'BALANCED' | 'AGGRESSIVE';
  if (er >= erTrending) return 'AGGRESSIVE';
  if (er <  erRanging)  return 'SNIPER';
  return 'BALANCED';
}

function resolveRequiredVotes(mode: ConsensusMode, er: number, ds?: DynamicEngineSettings): number {
  const effective = resolveEffectiveMode(mode, er, ds?.autoErTrending, ds?.autoErRanging);
  const base = MODE_CONFIG[effective].requiredVotes;
  if (!ds) return base;
  return effective === 'SNIPER' ? (ds.sniperRequiredVotes ?? base) : effective === 'AGGRESSIVE' ? (ds.aggressiveRequiredVotes ?? base) : (ds.balancedRequiredVotes ?? base);
}

function resolveGateThresholds(mode: ConsensusMode, er: number, ds?: DynamicEngineSettings): GateThresholds {
  const effective = resolveEffectiveMode(mode, er, ds?.autoErTrending, ds?.autoErRanging);
  const base = MODE_CONFIG[effective];
  if (!ds) return base;
  return {
    ...base,
    exhaustionCall: effective === 'SNIPER' ? (ds.sniperExhaustionCall ?? base.exhaustionCall) : effective === 'AGGRESSIVE' ? (ds.aggressiveExhaustionCall ?? base.exhaustionCall) : (ds.balancedExhaustionCall ?? base.exhaustionCall),
    exhaustionPut:  effective === 'SNIPER' ? (ds.sniperExhaustionPut  ?? base.exhaustionPut)  : effective === 'AGGRESSIVE' ? (ds.aggressiveExhaustionPut  ?? base.exhaustionPut)  : (ds.balancedExhaustionPut  ?? base.exhaustionPut),
  };
}

function computeMarketRegime(er: number, vol: number | null): MarketRegime {
  if (vol !== null && vol > 0.015) return 'VOLATILE';
  if (er >= 0.62) return 'TRENDING';
  return 'RANGING';
}

// ─── Constants ─────────────────────────────────────────────────────────────────

// Buffer must be large enough for the 4× dynamic lookback.
// Worst case: 45 s contract → 180-tick gate window. 300 gives comfortable headroom.
const TICK_BUFFER_SIZE = 300;
// Legacy indicator constants removed — all entry signals are now pure tick formulas.
const WARMUP_TICKS = 60; // 60-tick warm-up = ~1 min of real data; arms 5t/15s Sniper Strike immediately on tick 61
const COOLDOWN_MS = 12_000;

// ─── Indicator Math ─────────────────────────────────────────────────────────────

/**
 * Trimmed-mean volatility — discards top + bottom 5% of tick deltas before
 * averaging. A single spike tick cannot skew the reading for the whole window.
 */
function computeVolatilityPct(prices: number[]): number | null {
  if (prices.length < 5) return null;
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] !== 0) returns.push(Math.abs((prices[i] - prices[i - 1]) / prices[i - 1]) * 100);
  }
  if (!returns.length) return null;
  const sorted = [...returns].sort((a, b) => a - b);
  const trim = Math.floor(sorted.length * 0.05);
  // Only trim when the buffer is large enough that trimming won't empty the slice
  const trimmed = trim > 0 && trim < sorted.length / 2
    ? sorted.slice(trim, sorted.length - trim)
    : sorted;
  return trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
}

// pickAdaptiveDuration is now imported from @/lib/duration-utils.
// It implements the 4-tier asymmetric sizer: Ticks → Seconds → Minutes → Failsafe.

/**
 * Build the Entry Engine snapshot (3 voters only).
 * Ch1–Ch3: simple sign of velocity (spec: vote if >0 / <0).
 * R_tick + Z-score are NOT voters — they are Suppression Gate inputs.
 */
function buildTickSnapshot(
  macroVel: number | null,
  microVel: number | null,
  accel: number | null,
  er: number,
  rTick: number | null,
  zScore: number | null,
): IndicatorSnapshot {
  const macroVote: IndicatorVote =
    macroVel === null ? 'NEUTRAL' : macroVel > 0 ? 'CALL' : macroVel < 0 ? 'PUT' : 'NEUTRAL';
  const microVote: IndicatorVote =
    microVel === null ? 'NEUTRAL' : microVel > 0 ? 'CALL' : microVel < 0 ? 'PUT' : 'NEUTRAL';
  const accelVote: IndicatorVote =
    accel === null ? 'NEUTRAL' : accel > 0 ? 'CALL' : accel < 0 ? 'PUT' : 'NEUTRAL';
  return {
    macroVote, microVote, accelVote,
    erValue: er, rTickValue: rTick, zScoreValue: zScore,
  };
}

// ─── Hook ──────────────────────────────────────────────────────────────────────

export function useAutotrade(
  ws: DerivWS | null,
  isConnected: boolean,
  activeSymbol: ActiveSymbol | null,
  durationOptions: DurationOption[],
  openPositions: OpenPosition[],
  latestPrice: number | null,
  currency = 'USD',
  accountId = 'anonymous'
): UseAutotradeReturn {
  const [isEnabled, setIsEnabled] = useState(false);
  const [status, setStatus] = useState<BotStatus>('idle');
  const [signal, setSignal] = useState<BotSignal>(null);
  const [adaptiveDuration, setAdaptiveDuration] = useState<AdaptiveDuration | null>(null);
  const [volatility, setVolatility] = useState<number | null>(null);
  const [indicators, setIndicators] = useState<IndicatorSnapshot | null>(null);
  const [assetClass, setAssetClass] = useState<AssetClass | null>(null);
  const [assetConfig, setAssetConfig] = useState<AssetClassConfig | null>(null);
  const [activeRegime, setActiveRegime] = useState<BucketRegime | null>(null);
  const [activeBucket, setActiveBucket] = useState<DurationBucket | null>(null);
  const [botPositions, setBotPositions] = useState<OpenPosition[]>([]);
  const [currentStake, setCurrentStake] = useState<string>('1');
  const [log, setLog] = useState<BotLogEntry[]>([]);
  const [stats, setStats] = useState<BotStats>({ totalTrades: 0, wins: 0, losses: 0, consecutiveLosses: 0, consecutiveWins: 0, autoSells: 0 });
  const [sessionPnl, setSessionPnl] = useState(0);
  const [pnlHistory, setPnlHistory] = useState<PnlPoint[]>([]);
  const [efficiencyRatio, setEfficiencyRatio] = useState<number | null>(null);
  const [activeVotes, setActiveVotes] = useState<number>(3);
  const [marketRegime, setMarketRegime] = useState<MarketRegime | null>(null);
  const [routingTier, setRoutingTier] = useState<RoutingTier | null>(null);
  const [dynamicLookback, setDynamicLookback] = useState<number>(0);
  const [gateStates, setGateStates] = useState<GateStates | null>(null);
  const [effectiveMode, setEffectiveMode] = useState<'SNIPER' | 'BALANCED' | 'AGGRESSIVE'>('BALANCED');
  const pnlHistoryRef = useRef<PnlPoint[]>([]);
  const [signalHistory, setSignalHistory] = useState<SignalRecord[]>([]);
  const signalHistoryRef = useRef<SignalRecord[]>([]);
  const [volHistory, setVolHistory] = useState<number[]>([]);
  const signalIdCounter  = useRef(0);
  const DEFAULT_CONFIG: BotConfig = {
    stake: '1',
    maxTrades: 20,
    maxConsecutiveLosses: 3,
    allowEquals: false,
    autoSell: true,
    takeProfitPct: 40,
    stopLossPct: 50,
    riskEngine: 'OFF',
    stakeMultiplier: 2,
    maxStakeAmount: 10,
    consensusMode: 'AUTO',
    suppressionLogRate: 100,
    gates: { ...DEFAULT_GATES },
    durationMode: 'AUTO',
    manualDurationUnit: 't',
    manualDurationValue: 5,
  };

  const [config, setConfigState] = useState<BotConfig>(() => {
    const stored = loadStoredConfig();
    return {
      ...DEFAULT_CONFIG,
      ...stored,
      // Always deep-merge gates so new gate keys appear even for old stored configs
      gates: { ...DEFAULT_CONFIG.gates, ...(stored.gates ?? {}) },
    };
  });

  const tickBuffer = useRef<number[]>([]);
  const logCounter = useRef(0);
  const lastTradeTime = useRef<number>(0);
  const isTradingRef = useRef(false);
  const botContractIds = useRef(new Set<number>());
  const sellingIds = useRef(new Set<number>());
  const processedForResult = useRef(new Set<number>());
  /** Maps Deriv contract_id → Neon trade log id for PATCH on resolution */
  const liveTradeNeonIds = useRef<Map<number, number>>(new Map());
  /** Stable ref so accountId is always current inside async callbacks */
  const accountIdRef = useRef(accountId);
  const currentStakeRef = useRef<number>(1);
  // Fail-closed: start at 0.0 (pure noise) before any data arrives.
  // Starting at 0.5 would pass gate thresholds during the first ticks.
  const efficiencyRatioRef = useRef<number>(0.0);
  const zScoreRef = useRef<number>(0);
  const routingTierRef = useRef<string | null>(null);
  /** Ghost pipeline: in-memory queue of vetoed signals awaiting resolution */
  const pendingGhosts = useRef<GhostTrade[]>([]);
  /** Monotonically incrementing tick counter — used for tick-unit ghost expiry */
  const ghostTickCount = useRef<number>(0);
  /**
   * Signal debounce lock — tracks the last DB-insert time per symbol (Unix ms).
   * Prevents duplicate ghost rows when multiple ticks fire within the same
   * market opportunity window (the "Suppression Storm" / tick-bloat problem).
   * One ghost row per contract-duration window per symbol, keyed by symbol.
   */
  const lastGhostLogTimeBySymbol = useRef<Map<string, number>>(new Map());

  /**
   * Market profile thresholds keyed by market type.
   * Loaded once on mount and refreshed every 60 s.
   * When a profile exists for the active symbol's market, its ER/Z values
   * override the global settings for that specific market.
   */
  type MarketProfileEntry = {
    sniperCallErMin: number; sniperPutErMin: number; sniperZMax: number;
    balancedCallErMin: number; balancedPutErMin: number; balancedZMax: number;
    aggressiveCallErMin: number; aggressivePutErMin: number; aggressiveZMax: number;
  };
  const marketProfilesMapRef = useRef<Map<string, MarketProfileEntry>>(new Map());

  /**
   * Live global settings fetched from /api/settings.
   * Fail-safe defaults match the DB defaults so the engine is never blocked
   * if the API is temporarily unreachable.
   */
  const globalSettingsRef = useRef({
    globalDebounceSeconds: 15,
    sniperCallErMin: 0.00,
    sniperPutErMin: 0.60,
    balancedCallErMin: 0.10,
    balancedPutErMin: 0.40,
    aggressiveCallErMin: 0.20,
    aggressivePutErMin: 0.30,
    sniperZMax: 1.5,
    balancedZMax: 2.0,
    aggressiveZMax: 2.5,
    autoErTrending: 0.65,
    autoErRanging: 0.45,
    sniperExhaustionCall: 0.75,
    sniperExhaustionPut: 0.25,
    balancedExhaustionCall: 0.80,
    balancedExhaustionPut: 0.20,
    aggressiveExhaustionCall: 0.90,
    aggressiveExhaustionPut: 0.10,
    sniperRequiredVotes: 3,
    balancedRequiredVotes: 3,
    aggressiveRequiredVotes: 2,
    // Confidence / Stake-Sizing Engine
    confidenceErFloor:   0.40,
    confidenceErCeiling: 0.80,
    confidenceZExtreme:  2.50,
    // Duration Sizer — Sniper Strike
    sniperStrikeErFloor:   0.70,
    sniperStrikeErCeiling: 1.00,
    sniperStrikeAccelMin:  1.50,
    sniperStrikeMaxTicks:  10,
    // Duration Sizer — Momentum Ride
    momentumRideErFloor:  0.50,
    momentumRideErMedium: 0.65,
    momentumRideErLow:    0.55,
  });

  const statsRef = useRef(stats);
  const configRef = useRef(config);
  const openPositionsRef = useRef(openPositions);
  const activeSymbolRef = useRef(activeSymbol);
  const durationOptionsRef = useRef(durationOptions);
  const wsRef = useRef(ws);
  const isConnectedRef = useRef(isConnected);
  const isEnabledRef = useRef(isEnabled);
  const currencyRef = useRef(currency);

  useEffect(() => { accountIdRef.current = accountId; }, [accountId]);
  useEffect(() => { statsRef.current = stats; }, [stats]);
  useEffect(() => { configRef.current = config; }, [config]);
  useEffect(() => { openPositionsRef.current = openPositions; }, [openPositions]);
  useEffect(() => { activeSymbolRef.current = activeSymbol; }, [activeSymbol]);
  useEffect(() => { durationOptionsRef.current = durationOptions; }, [durationOptions]);
  useEffect(() => { wsRef.current = ws; }, [ws]);
  useEffect(() => { isConnectedRef.current = isConnected; }, [isConnected]);
  useEffect(() => { isEnabledRef.current = isEnabled; }, [isEnabled]);
  useEffect(() => {
    try { localStorage.setItem('autotrade_enabled', String(isEnabled)); } catch { /* ignore */ }
  }, [isEnabled]);
  useEffect(() => { currencyRef.current = currency; }, [currency]);
  useEffect(() => { routingTierRef.current = routingTier; }, [routingTier]);

  // ── Suppression counters (session — reset on bot restart) ─────────────────
  // Tracks how many signals were killed by the direction filter this session.
  // Exposed via suppressionCounts state for the autotrade panel display.
  const suppressionCountsRef = useRef<Map<string, { call: number; put: number; all: number }>>(new Map());
  const [suppressionCounts, setSuppressionCounts] = useState<Map<string, { call: number; put: number; all: number }>>(new Map());

  const recordSuppression = useCallback((symbol: string, direction: 'CALL' | 'PUT' | 'ALL') => {
    // 1. Increment in-memory session counter
    const existing = suppressionCountsRef.current.get(symbol) ?? { call: 0, put: 0, all: 0 };
    const updated  = {
      call: direction === 'CALL' ? existing.call + 1 : existing.call,
      put:  direction === 'PUT'  ? existing.put  + 1 : existing.put,
      all:  direction === 'ALL'  ? existing.all  + 1 : existing.all,
    };
    suppressionCountsRef.current.set(symbol, updated);
    setSuppressionCounts(new Map(suppressionCountsRef.current));

    // 2. Persist to DB for daily totals (fire-and-forget — never blocks trading)
    fetch('/api/suppression-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, direction }),
    }).catch(() => { /* ignore — suppression logging is non-critical */ });
  }, []);


  // ── Symbol direction config: fetch on mount + refresh every 60 s ─────────
  // Maps symbol → { enabled, callEnabled, putEnabled }.
  // Fail-open: if the API is unreachable, all symbols/directions are allowed.
  const symbolConfigMapRef = useRef<Map<string, { enabled: boolean; callEnabled: boolean; putEnabled: boolean }>>(new Map());
  useEffect(() => {
    const load = () => {
      fetch('/api/symbol-config')
        .then(r => r.json())
        .then((rows: { symbol: string; enabled: boolean; callEnabled: boolean; putEnabled: boolean }[]) => {
          const m = new Map<string, { enabled: boolean; callEnabled: boolean; putEnabled: boolean }>();
          for (const row of rows) m.set(row.symbol, { enabled: row.enabled, callEnabled: row.callEnabled, putEnabled: row.putEnabled });
          symbolConfigMapRef.current = m;
        })
        .catch(() => { /* keep previous map — fail-open */ });
    };
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  // ── Live global settings: fetch on mount + refresh every 60 s ────────────
  // Fail-silent: if the API is unreachable, the engine continues with the
  // last known (or default) values — it never throws or blocks trading.
  useEffect(() => {
    const load = () => {
      fetch('/api/settings')
        .then(r => r.json())
        .then((data: {
          globalDebounceSeconds?: number;
          sniperCallErMin?: string | number; sniperPutErMin?: string | number;
          balancedCallErMin?: string | number; balancedPutErMin?: string | number;
          aggressiveCallErMin?: string | number; aggressivePutErMin?: string | number;
          sniperZMax?: string | number; balancedZMax?: string | number; aggressiveZMax?: string | number;
          autoErTrending?: string | number; autoErRanging?: string | number;
          sniperExhaustionCall?: string | number; sniperExhaustionPut?: string | number;
          balancedExhaustionCall?: string | number; balancedExhaustionPut?: string | number;
          aggressiveExhaustionCall?: string | number; aggressiveExhaustionPut?: string | number;
          sniperRequiredVotes?: string | number; balancedRequiredVotes?: string | number; aggressiveRequiredVotes?: string | number;
          confidenceErFloor?: string | number; confidenceErCeiling?: string | number; confidenceZExtreme?: string | number;
          sniperStrikeErFloor?: string | number; sniperStrikeErCeiling?: string | number;
          sniperStrikeAccelMin?: string | number; sniperStrikeMaxTicks?: string | number;
          momentumRideErFloor?: string | number; momentumRideErMedium?: string | number; momentumRideErLow?: string | number;
        }) => {
          const n = (v: string | number | undefined, fb: number) =>
            v === undefined ? fb : typeof v === 'string' ? parseFloat(v) : v;
          globalSettingsRef.current = {
            globalDebounceSeconds:    data.globalDebounceSeconds ?? 15,
            sniperCallErMin:          n(data.sniperCallErMin, 0.00),
            sniperPutErMin:           n(data.sniperPutErMin, 0.60),
            balancedCallErMin:        n(data.balancedCallErMin, 0.10),
            balancedPutErMin:         n(data.balancedPutErMin, 0.40),
            aggressiveCallErMin:      n(data.aggressiveCallErMin, 0.20),
            aggressivePutErMin:       n(data.aggressivePutErMin, 0.30),
            sniperZMax:               n(data.sniperZMax, 1.5),
            balancedZMax:             n(data.balancedZMax, 2.0),
            aggressiveZMax:           n(data.aggressiveZMax, 2.5),
            autoErTrending:           n(data.autoErTrending, 0.65),
            autoErRanging:            n(data.autoErRanging, 0.45),
            sniperExhaustionCall:     n(data.sniperExhaustionCall, 0.75),
            sniperExhaustionPut:      n(data.sniperExhaustionPut, 0.25),
            balancedExhaustionCall:   n(data.balancedExhaustionCall, 0.80),
            balancedExhaustionPut:    n(data.balancedExhaustionPut, 0.20),
            aggressiveExhaustionCall: n(data.aggressiveExhaustionCall, 0.90),
            aggressiveExhaustionPut:  n(data.aggressiveExhaustionPut, 0.10),
            sniperRequiredVotes:      Math.round(n(data.sniperRequiredVotes, 3)),
            balancedRequiredVotes:    Math.round(n(data.balancedRequiredVotes, 3)),
            aggressiveRequiredVotes:  Math.round(n(data.aggressiveRequiredVotes, 2)),
            confidenceErFloor:        n(data.confidenceErFloor,   0.40),
            confidenceErCeiling:      n(data.confidenceErCeiling, 0.80),
            confidenceZExtreme:       n(data.confidenceZExtreme,  2.50),
            sniperStrikeErFloor:      n(data.sniperStrikeErFloor,   0.70),
            sniperStrikeErCeiling:    n(data.sniperStrikeErCeiling, 1.00),
            sniperStrikeAccelMin:     n(data.sniperStrikeAccelMin,  1.50),
            sniperStrikeMaxTicks:     Math.round(n(data.sniperStrikeMaxTicks, 10)),
            momentumRideErFloor:      n(data.momentumRideErFloor,  0.50),
            momentumRideErMedium:     n(data.momentumRideErMedium, 0.65),
            momentumRideErLow:        n(data.momentumRideErLow,    0.55),
          };
        })
        .catch(() => { /* keep previous ref values */ });
    };
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  // ── Market profiles: fetch on mount + refresh every 60 s ─────────────────
  // Fail-silent: engine falls back to globalSettingsRef on any fetch failure.
  useEffect(() => {
    const n = (v: string | number | undefined, fb: number) =>
      v === undefined ? fb : typeof v === 'string' ? parseFloat(v) : v;
    const load = () => {
      fetch('/api/market-profiles')
        .then(r => r.json())
        .then((rows: { marketType: string; sniperCallErMin?: string | number; sniperPutErMin?: string | number; sniperZMax?: string | number; balancedCallErMin?: string | number; balancedPutErMin?: string | number; balancedZMax?: string | number; aggressiveCallErMin?: string | number; aggressivePutErMin?: string | number; aggressiveZMax?: string | number }[]) => {
          const map = new Map<string, MarketProfileEntry>();
          for (const row of rows) {
            map.set(row.marketType, {
              sniperCallErMin:     n(row.sniperCallErMin, 0.05),
              sniperPutErMin:      n(row.sniperPutErMin, 0.05),
              sniperZMax:          n(row.sniperZMax, 1.5),
              balancedCallErMin:   n(row.balancedCallErMin, 0.03),
              balancedPutErMin:    n(row.balancedPutErMin, 0.03),
              balancedZMax:        n(row.balancedZMax, 1.8),
              aggressiveCallErMin: n(row.aggressiveCallErMin, 0.02),
              aggressivePutErMin:  n(row.aggressivePutErMin, 0.02),
              aggressiveZMax:      n(row.aggressiveZMax, 2.2),
            });
          }
          marketProfilesMapRef.current = map;
        })
        .catch(() => { /* keep previous map — fail-open */ });
    };
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  // ── DB keep-warm: client-side layer ───────────────────────────────────────
  // Pings the API server every 3 min while the bot is armed so Neon's compute
  // node never cold-starts mid-session (the api-server has its own server-side
  // ping — this is belt-and-suspenders for long silent regimes).
  useEffect(() => {
    if (!isEnabled) return;
    const BOT_HEARTBEAT_MS = 3 * 60 * 1000;
    const id = setInterval(() => {
      fetch('/api/healthz', { method: 'GET' }).catch(() => {
        // fire-and-forget — ignore failures, don't disrupt trading
      });
    }, BOT_HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [isEnabled]);

  // Reset current stake display when base stake changes (and bot is idle)
  useEffect(() => {
    if (!isEnabled) {
      const base = parseFloat(config.stake);
      if (!isNaN(base)) { currentStakeRef.current = base; setCurrentStake(config.stake); }
    }
  }, [config.stake, isEnabled]);

  const addLog = useCallback((message: string, type: BotLogEntry['type']) => {
    setLog(prev => [{ id: ++logCounter.current, time: new Date().toLocaleTimeString(), message, type }, ...prev].slice(0, 60));
  }, []);

  const setConfig = useCallback((cfg: Partial<BotConfig>) => {
    setConfigState(prev => {
      const next: BotConfig = {
        ...prev,
        ...cfg,
        // Deep-merge gates so toggling one gate doesn't wipe the rest
        gates: cfg.gates ? { ...prev.gates, ...cfg.gates } : prev.gates,
      };
      persistConfig(next);
      return next;
    });
  }, []);

  // ── Risk Engine (Strategy Pattern) ────────────────────────────────────────
  const applyRiskEngine = useCallback((won: boolean) => {
    const cfg = configRef.current;
    if (cfg.riskEngine === 'OFF') return;
    const s = statsRef.current; // ref is updated synchronously before this call — see all setStats call sites
    const base = parseFloat(cfg.stake) || 1;
    const next = calculateFinalStake(cfg.riskEngine, {
      base,
      maxCap: cfg.maxStakeAmount,
      consecutiveLosses: s.consecutiveLosses,
      consecutiveWins: s.consecutiveWins,
      stakeMultiplier: cfg.stakeMultiplier,
      er: efficiencyRatioRef.current,
      zScore: zScoreRef.current,
      confidenceParams: {
        erFloor:   globalSettingsRef.current.confidenceErFloor,
        erCeiling: globalSettingsRef.current.confidenceErCeiling,
        zExtreme:  globalSettingsRef.current.confidenceZExtreme,
      },
    });
    currentStakeRef.current = next;
    setCurrentStake(String(next));
    const engineTag = { MARTINGALE: 'MG', ANTI_MARTINGALE: 'AMG', CONFIDENCE: 'DYN', OFF: '' }[cfg.riskEngine];
    if (next !== base) {
      addLog(`📈 [${engineTag}] stake → $${next.toFixed(2)}${!won ? ' (recovery)' : ' (streak)'}`, 'info');
    } else {
      addLog(`↩ [${engineTag}] stake reset → $${base.toFixed(2)}`, 'info');
    }
  }, [addLog]);

  // ── Signal telemetry helpers ──────────────────────────────────────────────
  const pushSignalRecord = useCallback((rec: SignalRecord) => {
    signalHistoryRef.current = [...signalHistoryRef.current, rec].slice(-SIGNAL_BUFFER_MAX);
  }, []);

  const resolveSignalRecord = useCallback((contractId: number, outcome: 'WIN' | 'LOSS', pnlDelta: number) => {
    signalHistoryRef.current = signalHistoryRef.current.map(r =>
      r.contractId === contractId ? { ...r, outcome, pnlDelta, resolvedAt: Date.now() } : r
    );
  }, []);

  const patchSignalContractId = useCallback((signalId: string, contractId: number, executedAt: number) => {
    signalHistoryRef.current = signalHistoryRef.current.map(r =>
      r.id === signalId ? { ...r, contractId, executedAt } : r
    );
  }, []);

  // ── Auto-sell + natural expiry detection ──────────────────────────────────
  useEffect(() => {
    const cfg = configRef.current;
    for (const pos of openPositions) {
      if (!botContractIds.current.has(pos.contract_id)) continue;
      const isClosed = !!pos.is_sold || !!pos.is_expired || pos.status !== 'open';

      if (isClosed && !processedForResult.current.has(pos.contract_id)) {
        processedForResult.current.add(pos.contract_id);
        botContractIds.current.delete(pos.contract_id);
        sellingIds.current.delete(pos.contract_id);
        const profit = parseFloat(pos.profit);
        const won = !isNaN(profit) && profit > 0;
        // Update ref synchronously BEFORE applyRiskEngine reads it — React's
        // setState updater is queued (not immediate), so the ref must be set
        // here to avoid applyRiskEngine reading stale consecutiveLosses/Wins.
        const nextStats = { ...statsRef.current, wins: won ? statsRef.current.wins + 1 : statsRef.current.wins, losses: !won ? statsRef.current.losses + 1 : statsRef.current.losses, consecutiveLosses: won ? 0 : statsRef.current.consecutiveLosses + 1, consecutiveWins: won ? statsRef.current.consecutiveWins + 1 : 0 };
        statsRef.current = nextStats;
        setStats(nextStats);
        if (!isNaN(profit)) {
          const prev = pnlHistoryRef.current;
          const cumPnl = (prev.length > 0 ? prev[prev.length - 1].cumPnl : 0) + profit;
          const point: PnlPoint = { tradeNum: prev.length + 1, pnl: profit, cumPnl };
          pnlHistoryRef.current = [...prev, point];
          setPnlHistory(pnlHistoryRef.current);
          setSessionPnl(cumPnl);
          // PATCH Neon LIVE trade with outcome — closes the ML record
          const neonId = liveTradeNeonIds.current.get(pos.contract_id);
          if (neonId !== undefined) {
            fetch(`/api/trade-logs/${neonId}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                exitPrice: String(parseFloat(pos.buy_price) + profit),
                status: won ? 'WIN' : 'LOSS',
                pnl: String(profit),
                resolvedAt: new Date().toISOString(),
              }),
            }).catch(() => {});
            liveTradeNeonIds.current.delete(pos.contract_id);
          }
        }
        resolveSignalRecord(pos.contract_id, won ? 'WIN' : 'LOSS', !isNaN(profit) ? profit : 0);
        // Emit a rich outcome line to the activity log
        if (!isNaN(profit)) {
          const dir = (pos.contract_type || '').toUpperCase().includes('CALL') ? 'CALL ↑' : 'PUT ↓';
          const pnlSoFar = pnlHistoryRef.current.length > 0
            ? pnlHistoryRef.current[pnlHistoryRef.current.length - 1].cumPnl
            : profit;
          const sign = profit >= 0 ? '+' : '';
          const cumSign = pnlSoFar >= 0 ? '+' : '';
          addLog(
            `#${pos.contract_id} | ${dir} | ${sign}$${Math.abs(profit).toFixed(2)} | Session ${cumSign}$${Math.abs(pnlSoFar).toFixed(2)}`,
            won ? 'win' : 'loss',
          );
        }
        applyRiskEngine(won);
        continue;
      }

      if (!cfg.autoSell || !isEnabledRef.current) continue;
      if (!wsRef.current || !isConnectedRef.current) continue;
      if (!pos.is_valid_to_sell) continue;
      if (sellingIds.current.has(pos.contract_id)) continue;
      if (processedForResult.current.has(pos.contract_id)) continue;

      const profit = parseFloat(pos.profit);
      if (isNaN(profit)) continue;

      // Dynamic % thresholds based on actual payout and stake for this contract
      const payout = parseFloat(pos.payout);
      const buyPrice = parseFloat(pos.buy_price);
      const potentialProfit = !isNaN(payout) && !isNaN(buyPrice) ? payout - buyPrice : null;
      const tpThreshold = potentialProfit !== null ? potentialProfit * (cfg.takeProfitPct / 100) : null;
      const slThreshold = !isNaN(buyPrice) ? buyPrice * (cfg.stopLossPct / 100) : null;

      let shouldSell = false, isWin = false, reason = '';
      if (tpThreshold !== null && profit >= tpThreshold) {
        shouldSell = true; isWin = true;
        reason = `🎯 TP +$${profit.toFixed(2)} (${cfg.takeProfitPct}%)`;
      } else if (slThreshold !== null && profit <= -slThreshold) {
        shouldSell = true; isWin = false;
        reason = `🛡 SL $${profit.toFixed(2)} (${cfg.stopLossPct}%)`;
      }
      if (!shouldSell) continue;

      const contractId = pos.contract_id, bidPrice = pos.bid_price, capturedWin = isWin;
      const capturedSymbol = pos.underlying_symbol;
      const capturedContractType = pos.contract_type;
      const capturedBuyPrice = pos.buy_price;
      const capturedPayout = pos.payout;
      sellingIds.current.add(contractId);
      processedForResult.current.add(contractId);
      addLog(`${reason} — selling #${contractId}`, 'signal');

      const capturedProfit = profit;
      wsRef.current.send<{ sell?: { sold_for: number } }>({ sell: contractId, price: bidPrice })
        .then(res => {
          const soldFor = res?.sell?.sold_for;
          addLog(`✓ Auto-closed #${contractId}${soldFor !== undefined ? ` at $${soldFor.toFixed(2)}` : ''}`, 'result');
          botContractIds.current.delete(contractId);
          sellingIds.current.delete(contractId);
          const nextAutoStats = { ...statsRef.current, autoSells: statsRef.current.autoSells + 1, wins: capturedWin ? statsRef.current.wins + 1 : statsRef.current.wins, losses: !capturedWin ? statsRef.current.losses + 1 : statsRef.current.losses, consecutiveLosses: capturedWin ? 0 : statsRef.current.consecutiveLosses + 1, consecutiveWins: capturedWin ? statsRef.current.consecutiveWins + 1 : 0 };
          statsRef.current = nextAutoStats;
          setStats(nextAutoStats);
          const p = pnlHistoryRef.current;
          const cumPnl = (p.length > 0 ? p[p.length - 1].cumPnl : 0) + capturedProfit;
          const point: PnlPoint = { tradeNum: p.length + 1, pnl: capturedProfit, cumPnl };
          pnlHistoryRef.current = [...p, point];
          setPnlHistory(pnlHistoryRef.current);
          setSessionPnl(cumPnl);
          resolveSignalRecord(contractId, capturedWin ? 'WIN' : 'LOSS', capturedProfit);
          // PATCH Neon LIVE trade with auto-sell outcome — closes the ML record
          const neonIdAutoSell = liveTradeNeonIds.current.get(contractId);
          if (neonIdAutoSell !== undefined) {
            const exitPriceStr = soldFor !== undefined
              ? String(soldFor)
              : String(parseFloat(capturedBuyPrice) + capturedProfit);
            fetch(`/api/trade-logs/${neonIdAutoSell}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                exitPrice: exitPriceStr,
                status: capturedWin ? 'WIN' : 'LOSS',
                pnl: String(capturedProfit),
                resolvedAt: new Date().toISOString(),
              }),
            }).catch(() => {});
            liveTradeNeonIds.current.delete(contractId);
          }
          // Outcome log for auto-sell closes
          const autoSign = capturedProfit >= 0 ? '+' : '';
          const autoCumSign = cumPnl >= 0 ? '+' : '';
          addLog(
            `#${contractId} | Auto-sell | ${autoSign}$${Math.abs(capturedProfit).toFixed(2)} | Session ${autoCumSign}$${Math.abs(cumPnl).toFixed(2)}`,
            capturedWin ? 'win' : 'loss',
          );
          applyRiskEngine(capturedWin);
        })
        .catch((err: unknown) => {
          addLog(`✗ Auto-sell #${contractId}: ${err instanceof Error ? err.message : 'failed'}`, 'warn');
          sellingIds.current.delete(contractId);
          processedForResult.current.delete(contractId);
        });
    }
  }, [openPositions, addLog, applyRiskEngine, resolveSignalRecord]);

  useEffect(() => {
    setBotPositions(openPositions.filter(p => botContractIds.current.has(p.contract_id)));
  }, [openPositions]);

  // ── Trade execution ──────────────────────────────────────────────────────
  const executeTrade = useCallback(async (dir: 'CALL' | 'PUT', dur: AdaptiveDuration, ctx: SignalContext) => {
    const currentWs = wsRef.current;
    const sym = activeSymbolRef.current;
    const cfg = configRef.current;
    if (!currentWs || !isConnectedRef.current || !sym) return;
    if (isTradingRef.current) return;

    // Confidence engine must be re-evaluated at ENTRY time — ER and Z-score
    // reflect the market right now, not when the previous trade closed.
    // Martingale/Anti-Martingale are streak-based so outcome-time sizing is correct for them.
    let stakeNum: number;
    if (cfg.riskEngine === 'CONFIDENCE') {
      stakeNum = calculateFinalStake('CONFIDENCE', {
        base: parseFloat(cfg.stake) || 1,
        maxCap: cfg.maxStakeAmount,
        consecutiveLosses: statsRef.current.consecutiveLosses,
        consecutiveWins: statsRef.current.consecutiveWins,
        stakeMultiplier: cfg.stakeMultiplier,
        er: efficiencyRatioRef.current,
        zScore: zScoreRef.current,
        confidenceParams: {
          erFloor:   globalSettingsRef.current.confidenceErFloor,
          erCeiling: globalSettingsRef.current.confidenceErCeiling,
          zExtreme:  globalSettingsRef.current.confidenceZExtreme,
        },
      });
      currentStakeRef.current = stakeNum;
      setCurrentStake(String(stakeNum));
    } else {
      stakeNum = currentStakeRef.current > 0 ? currentStakeRef.current : parseFloat(cfg.stake);
    }
    if (!stakeNum || stakeNum <= 0) { addLog('Invalid stake amount', 'warn'); return; }

    isTradingRef.current = true;
    setStatus('trading');

    // Create PENDING telemetry record
    const sigId = `${Date.now()}-${++signalIdCounter.current}`;
    const sigRec: SignalRecord = {
      id: sigId, timestamp: Date.now(), direction: dir,
      voters: ctx.voters, votesFor: ctx.votesFor, votesNeeded: ctx.votesNeeded,
      gates: ctx.gates, regime: ctx.regime,
      stake: stakeNum, outcome: 'PENDING', pnlDelta: 0,
      ttlExpiry: Date.now() + SIGNAL_TTL_MS,
    };
    pushSignalRecord(sigRec);

    const contractType = cfg.allowEquals ? `${dir}E` : dir;
    const engineTag: Record<string, string> = { MARTINGALE: 'MG', ANTI_MARTINGALE: 'AMG', CONFIDENCE: 'DYN' };
    const stakeLabel = cfg.riskEngine !== 'OFF' ? `$${stakeNum.toFixed(2)} [${engineTag[cfg.riskEngine] ?? ''}]` : `$${cfg.stake}`;
    addLog(`▶ ${dir} | ${dur.label} | ${stakeLabel} | ${sym.underlying_symbol_name}`, 'trade');

    try {
      // ── Direct buy — single WebSocket round-trip, no proposal handshake ──────
      // price = stakeNum is the max-price guard; with basis:"stake" the cost
      // always equals the stake. If Deriv rejects the price (ask shifted since
      // the signal fired), we retry once with a 5% buffer — still direct buy,
      // zero extra proposal latency on the happy path.
      const buyParams = {
        amount: stakeNum,
        basis: 'stake',
        contract_type: contractType,
        currency: currencyRef.current,
        duration: dur.value,
        duration_unit: dur.unit,
        underlying_symbol: sym.underlying_symbol,  // Deriv parameters schema uses underlying_symbol, not symbol
      };
      const doBuy = (priceGuard: number) =>
        currentWs.send<BuyResponse>({ buy: 1, price: priceGuard, parameters: buyParams });

      const t0 = Date.now();
      const buyRes = await doBuy(stakeNum).catch(async (firstErr: unknown) => {
        const msg = (firstErr instanceof Error ? firstErr.message : String(firstErr)).toLowerCase();
        // Price validation errors: ask moved above our guard since the signal fired.
        if (/price|amount|minimum|maximum|stake/.test(msg)) {
          addLog(`⚡ Price guard widened — retrying`, 'info');
          return doBuy(parseFloat((stakeNum * 1.05).toFixed(2)));
        }
        throw firstErr;
      });

      if (!buyRes?.buy) throw new Error('Buy failed — no confirmation');
      const executedAt = Date.now();
      addLog(`  Latency: ${executedAt - t0}ms (direct buy)`, 'info');

      const { contract_id, buy_price } = buyRes.buy;
      patchSignalContractId(sigId, contract_id, executedAt);
      botContractIds.current.add(contract_id);
      setStats(prev => { const next = { ...prev, totalTrades: prev.totalTrades + 1 }; statsRef.current = next; return next; });
      addLog(`✓ Placed! #${contract_id} at $${buy_price.toFixed(2)}${cfg.autoSell ? ` | TP ${cfg.takeProfitPct}% / SL ${cfg.stopLossPct}%` : ''}`, 'result');

      // Fire-and-forget: persist LIVE trade to Neon for ML pipeline
      fetch('/api/trade-logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          executionType: 'LIVE',
          accountId: accountIdRef.current,
          direction: dir,
          symbol: sym.underlying_symbol,
          effectiveMode: ctx.effectiveMode,
          durationTarget: dur.value,
          durationUnit: dur.unit,
          entryPrice: String(ctx.entryPrice),
          noiseAtEntry: String(ctx.gates.er),
          zScoreAtEntry: String(ctx.gates.zScore ?? 0),
          erAtEntry: String(ctx.gates.er),
          accelerationAtEntry: String(ctx.acceleration),
          stake: String(stakeNum),
        }),
      })
        .then(r => r.json())
        .then((body: unknown) => {
          const { id } = body as { id?: number };
          if (typeof id === 'number') {
            liveTradeNeonIds.current.set(contract_id, id);
          }
        })
        .catch(() => {});
    } catch (err) {
      addLog(`✗ ${err instanceof Error ? err.message : 'Trade failed'}`, 'warn');
      // Mark the pending signal as failed (API drop / buy rejection)
      signalHistoryRef.current = signalHistoryRef.current.map(r =>
        r.id === sigId ? { ...r, outcome: 'FAILED_EXECUTION' as SignalOutcome, resolvedAt: Date.now() } : r
      );
      const nextFailStats = { ...statsRef.current, losses: statsRef.current.losses + 1, consecutiveLosses: statsRef.current.consecutiveLosses + 1, consecutiveWins: 0 };
      statsRef.current = nextFailStats;
      setStats(nextFailStats);
      applyRiskEngine(false);
    } finally {
      // Bug fix: always stamp lastTradeTime so the COOLDOWN_MS guard fires even
      // after a failed buy. Without this, a failing trade never updates the
      // timestamp, the cooldown is skipped on every tick, and the Martingale
      // engine spirals the stake on each consecutive rejection.
      lastTradeTime.current = Date.now();
      isTradingRef.current = false;
      setStatus('analyzing');
    }
  }, [addLog, applyRiskEngine, pushSignalRecord, patchSignalContractId]);

  // ── Signal telemetry: restore on mount + Page Visibility persistence ───────
  useEffect(() => {
    // Restore session from localStorage on mount (client-side only)
    const restored = loadSignalHistory();
    if (restored.length > 0) {
      signalHistoryRef.current = restored;
      setSignalHistory(restored.slice(-SIGNAL_VISIBLE_MAX));
    }

    // Persist whenever the user hides the tab, minimizes, or locks their screen.
    // The Page Visibility API fires reliably on mobile kills and desktop tab switches
    // where beforeunload is often skipped entirely.
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        persistSignalHistory(signalHistoryRef.current);
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  // ── Tick analysis — always runs when price arrives (even when bot is off) ──
  const onTick = useCallback((price: number) => {
    // TTL sweep + React flush — driven by the tick stream, not a blind timer.
    // If the WebSocket is alive and delivering ticks, the sweeper is alive.
    // A backgrounded setInterval would freeze here; a live WS tick never does.
    const now = Date.now();
    const swept = signalHistoryRef.current.map(r =>
      r.outcome === 'PENDING' && now > r.ttlExpiry
        ? { ...r, outcome: 'FAILED_EXECUTION' as SignalOutcome, resolvedAt: now }
        : r
    );
    if (swept !== signalHistoryRef.current) signalHistoryRef.current = swept;
    setSignalHistory(swept.slice(-SIGNAL_VISIBLE_MAX));

    // ── Ghost resolution sweep ────────────────────────────────────────────
    // Runs on every tick — piggybacking on the existing WS stream at zero cost.
    ghostTickCount.current += 1;
    if (pendingGhosts.current.length > 0) {
      const nowMs = Date.now();
      pendingGhosts.current = pendingGhosts.current.filter(ghost => {
        const expired =
          ghost.expiryUnit === 't'
            ? ghostTickCount.current >= ghost.expiryTarget
            : nowMs >= ghost.expiryTarget;
        if (!expired) return true;

        const won =
          ghost.direction === 'CALL' ? price > ghost.entryPrice : price < ghost.entryPrice;
        const status: 'WIN' | 'LOSS' = won ? 'WIN' : 'LOSS';

        fetch(`/api/trade-logs/${ghost.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            exitPrice: String(price),
            status,
            resolvedAt: new Date().toISOString(),
          }),
        }).catch(() => {});

        return false;
      });
    }

    tickBuffer.current.push(price);
    if (tickBuffer.current.length > TICK_BUFFER_SIZE) tickBuffer.current.shift();
    const prices = tickBuffer.current;

    const booting = prices.length < WARMUP_TICKS;
    if (booting) {
      if (isEnabledRef.current) setStatus('warming');
      return;
    }

    // ── Step 1: Direction metrics — fixed periods, always first ─────────────
    // These feed the Entry Engine (3/3 voter). Periods are spec-exact and
    // independent of the selected duration horizon.
    const macroVel = computeVMacro(prices);          // Ch1: (P_t − P_{t-21}) / 21
    const microVel = computeVMicro(prices);          // Ch2: (P_t − P_{t-5}) / 5
    const accel    = computeAcceleration(prices);    // Ch3: V_micro − V_macro
    const vol      = computeVolatilityPct(prices);   // Trimmed-mean % for display + regime

    setVolatility(vol);
    if (vol !== null) setVolHistory(h => { const n = [...h, vol]; return n.length > 60 ? n.slice(-60) : n; });

    // ── Step 2: Initial ER (sizing window) — feeds the duration sizer ────────
    // Uses a tight 10-tick default — just enough to characterise momentum quality
    // without looking so far back that the regime classification lags the signal.
    const erForSizing = computeEfficiencyRatio(prices); // period = 10 default

    // ── Step 3: Duration sizer — AUTO (4-tier adaptive) or MANUAL (user-fixed) ─
    // Solves the "Chicken and Egg" paradox: we pick the duration BEFORE the gates
    // so the gates can calibrate their lookback to match the selected horizon.
    let dur: AdaptiveDuration | null;
    let tier: RoutingTier;

    if (configRef.current.durationMode === 'MANUAL') {
      // ── MANUAL branch: user-supplied unit + value, silently clamped to API range
      const mUnit = configRef.current.manualDurationUnit;
      const mOpt  = durationOptionsRef.current.find(o => o.unit === mUnit);
      let   mVal  = configRef.current.manualDurationValue;
      if (mOpt) mVal = Math.max(mOpt.min, Math.min(mOpt.max, mVal));
      dur = mVal > 0 ? {
        value: mVal,
        unit:  mUnit,
        label: mUnit === 't' ? `${mVal}t`
             : mUnit === 'm' ? `${mVal} Min`
             : `${mVal}s`,
      } : null;
      tier = 'MANUAL';
    } else {
      // ── AUTO branch: 4-tier adaptive sizer (ER + Acceleration)
      const durResult = pickAdaptiveDuration(durationOptionsRef.current, {
        acceleration: accel,
        efficiencyRatio: erForSizing,
      }, {
        sniperStrike: {
          erFloor:   globalSettingsRef.current.sniperStrikeErFloor,
          erCeiling: globalSettingsRef.current.sniperStrikeErCeiling,
          accelMin:  globalSettingsRef.current.sniperStrikeAccelMin,
          maxTicks:  globalSettingsRef.current.sniperStrikeMaxTicks,
        },
        momentumRide: {
          erFloor:  globalSettingsRef.current.momentumRideErFloor,
          erMedium: globalSettingsRef.current.momentumRideErMedium,
          erLow:    globalSettingsRef.current.momentumRideErLow,
        },
      });

      // Strict Abort — API returned no valid duration options.
      // Setting dur = null causes the existing guard at line 1004
      // (`if (!dur) return`) to silently halt trade execution for this tick.
      // Capital is preserved; the bot retries automatically on the next tick.
      if (durResult.unit === 'ABORT') {
        dur = null;
        tier = 'FAILSAFE';
      } else {
        dur = {
          value: durResult.duration,
          unit:  durResult.unit,
          label: durResult.unit === 't' ? `${durResult.duration}t`
               : durResult.unit === 'm' ? `${durResult.duration} Min`
               : `${durResult.duration}s`,
        };
        tier = dur.unit === 't' ? 'SNIPER'
          : dur.unit === 'm' ? 'MACRO'
          : erForSizing > 0.50 ? 'MOMENTUM'
          : 'FAILSAFE';
      }
    }

    setAdaptiveDuration(dur);
    setRoutingTier(tier);

    // ── Step 4: 4× Dynamic Lookback — gates calibrate to the trade horizon ───
    // Rule: dynamicPeriod = executionTicks × 4.
    // Examples: 5-tick contract → 20-tick gate window (tight, sniper).
    //           15 s contract   → 60-tick gate window.
    //           30 s contract   → 120-tick gate window (broader noise floor).
    // This makes the suppression gates mathematically self-consistent with the
    // duration — a short tick contract doesn't look back 240 ticks for its ER.
    let executionTicks = dur ? dur.value : 15;
    if (dur?.unit === 'm') executionTicks = dur.value * 60;
    const dynamicPeriod = Math.max(10, Math.min(executionTicks * 4, prices.length - 1));
    setDynamicLookback(dynamicPeriod);

    // ── Step 5: Gate metrics — recalculated with the dynamic horizon ──────────
    const er     = computeEfficiencyRatio(prices, dynamicPeriod);
    const rTick  = computeDirectionalRatio(prices, Math.min(dynamicPeriod, prices.length - 1));
    const zScore = computeZScore(prices, Math.min(dynamicPeriod, prices.length));

    setEfficiencyRatio(er);
    efficiencyRatioRef.current = er;
    if (zScore !== null) zScoreRef.current = zScore;
    else zScoreRef.current = 0;
    const gs = globalSettingsRef.current;
    const resolvedVotes = resolveRequiredVotes(configRef.current.consensusMode, er, gs);
    setActiveVotes(resolvedVotes);
    setMarketRegime(computeMarketRegime(er, vol));

    const thresholds = resolveGateThresholds(configRef.current.consensusMode, er, gs);
    setEffectiveMode(thresholds.effective);

    // Panel snapshot (asymmetric entry engine — always live)
    const snapshot = buildTickSnapshot(macroVel, microVel, accel, er, rTick, zScore);
    setIndicators(snapshot);

    // ── Live gate states for UI suppression panel (always, bot on or off) ────
    // Entry Engine: dynamic vote threshold — resolvedVotes/3, driven by ER-resolved mode
    const allSnapVotes = [snapshot.macroVote, snapshot.microVote, snapshot.accelVote];
    const snapCallCount = allSnapVotes.filter(v => v === 'CALL').length;
    const snapPutCount  = allSnapVotes.filter(v => v === 'PUT').length;
    const engineConsensus: 'CALL' | 'PUT' | null =
      snapCallCount >= resolvedVotes ? 'CALL' : snapPutCount >= resolvedVotes ? 'PUT' : null;

    // Asymmetric Consensus Matrix: direction × mode-aware thresholds.
    // Market profile overrides global settings when a profile exists for the active symbol.
    const activeMode = thresholds.effective;
    const _activeSym = activeSymbolRef.current?.underlying_symbol ?? '';
    const _mktType = classifyMarket(_activeSym);
    const _mktProfile = marketProfilesMapRef.current.get(_mktType);
    // Merge: market profile takes priority over global settings
    const ms = _mktProfile ?? {
      sniperCallErMin: gs.sniperCallErMin, sniperPutErMin: gs.sniperPutErMin, sniperZMax: gs.sniperZMax,
      balancedCallErMin: gs.balancedCallErMin, balancedPutErMin: gs.balancedPutErMin, balancedZMax: gs.balancedZMax,
      aggressiveCallErMin: gs.aggressiveCallErMin, aggressivePutErMin: gs.aggressivePutErMin, aggressiveZMax: gs.aggressiveZMax,
    };
    const effectiveNoiseMin =
      engineConsensus === 'CALL'
        ? (activeMode === 'SNIPER' ? ms.sniperCallErMin : activeMode === 'AGGRESSIVE' ? ms.aggressiveCallErMin : ms.balancedCallErMin)
        : engineConsensus === 'PUT'
        ? (activeMode === 'SNIPER' ? ms.sniperPutErMin  : activeMode === 'AGGRESSIVE' ? ms.aggressivePutErMin  : ms.balancedPutErMin)
        : thresholds.noiseMin;
    const effectiveZMax =
      activeMode === 'SNIPER' ? ms.sniperZMax : activeMode === 'AGGRESSIVE' ? ms.aggressiveZMax : ms.balancedZMax;
    const noiseState: GateState   = er < effectiveNoiseMin ? 'VETO' : 'CLEAR';
    const exhaustionState: GateState =
      rTick === null   ? 'CLEAR'
      : engineConsensus === 'CALL' ? (rTick > thresholds.exhaustionCall ? 'VETO' : 'CLEAR')
      : engineConsensus === 'PUT'  ? (rTick < thresholds.exhaustionPut  ? 'VETO' : 'CLEAR')
      : (rTick > 0.88 || rTick < 0.12 ? 'VETO' : 'CLEAR');
    const volatilityState: GateState =
      zScore === null ? 'CLEAR' : (Math.abs(zScore) > effectiveZMax ? 'VETO' : 'CLEAR');
    setGateStates({ noise: noiseState, exhaustion: exhaustionState, volatility: volatilityState });

    // ── Detect asset class + resolve config (always live) ───────────────────
    const sym = activeSymbolRef.current;
    const detectedClass = sym ? AssetConfigService.detectAssetClass(sym) : 'synthetic_index';
    const cfg2 = AssetConfigService.getConfig(detectedClass);
    setAssetClass(detectedClass);
    setAssetConfig(cfg2);

    // Resolve bucket for regime display (always live, even when bot is off)
    if (dur) {
      const bucket = AssetConfigService.resolveBucket(cfg2, dur.unit as 't' | 's' | 'm' | 'h' | 'd', dur.value);
      setActiveBucket(bucket);
      setActiveRegime(bucket.regime);
    }

    // ── From here: trading logic only runs when bot is enabled ───────────────
    if (!isEnabledRef.current) return;

    setStatus('analyzing');

    const cfg = configRef.current;
    const s = statsRef.current;

    if (isTradingRef.current || !dur) return;
    if (Date.now() - lastTradeTime.current < COOLDOWN_MS) return;
    if (openPositionsRef.current.length > 0) return;
    if (s.totalTrades >= cfg.maxTrades) {
      addLog(`Max trades (${cfg.maxTrades}) reached — bot paused`, 'warn');
      setIsEnabled(false); setStatus('paused'); return;
    }
    if (s.consecutiveLosses >= cfg.maxConsecutiveLosses) {
      addLog(`${cfg.maxConsecutiveLosses} consecutive losses — bot paused`, 'warn');
      setIsEnabled(false); setStatus('paused'); return;
    }

    // ── Evaluate signal via dynamic config engine ────────────────────────────
    const bucket = AssetConfigService.resolveBucket(cfg2, dur.unit as 't' | 's' | 'm' | 'h' | 'd', dur.value);
    const evalResult = evaluateSignal(cfg2, bucket, {
      consecutiveLosses: s.consecutiveLosses,
      macroVelocity: macroVel,
      microVelocity: microVel,
      acceleration: accel,
      directionalRatio: rTick,
      zScore,
      efficiencyRatio: er,
    }, {
      minVotes: resolvedVotes,
      gates: {
        ...cfg.gates,
        NOISE:             { enabled: cfg.gates.NOISE?.enabled ?? true,             threshold: effectiveNoiseMin         },
        EXHAUSTION:        { enabled: cfg.gates.EXHAUSTION?.enabled ?? true,        threshold: thresholds.exhaustionCall },
        VOLATILITY_ZSCORE: { enabled: cfg.gates.VOLATILITY_ZSCORE?.enabled ?? true, threshold: effectiveZMax             },
      },
    });

    if (evalResult.signal) {
      // ── Symbol / direction filter ─────────────────────────────────────────
      // Checked at signal time (not at boot) so dashboard toggles take effect
      // within one 60-second config refresh cycle without a redeploy.
      const symKey = activeSymbolRef.current?.underlying_symbol;
      const symCfg = symKey ? symbolConfigMapRef.current.get(symKey) : undefined;
      if (symCfg?.enabled === false) {
        addLog(`⛔ ${symKey} disabled in dashboard — signal skipped`, 'warn');
        if (symKey) recordSuppression(symKey, 'ALL');
        return;
      }
      if (evalResult.signal === 'CALL' && symCfg?.callEnabled === false) {
        addLog(`⛔ CALL disabled for ${symKey} — signal skipped`, 'warn');
        if (symKey) recordSuppression(symKey, 'CALL');
        return;
      }
      if (evalResult.signal === 'PUT' && symCfg?.putEnabled === false) {
        addLog(`⛔ PUT disabled for ${symKey} — signal skipped`, 'warn');
        if (symKey) recordSuppression(symKey, 'PUT');
        return;
      }
      // ─────────────────────────────────────────────────────────────────────

      setSignal(evalResult.signal);
      const agreeCount = evalResult.primaryVotes.filter(v => v === evalResult.signal).length;
      const total = evalResult.primaryVotes.length;
      const voteSummary = evalResult.primaryVotes.map(v => v === 'CALL' ? '▲' : v === 'PUT' ? '▼' : '—').join('');
      addLog(
        `⚡ ${evalResult.signal} | ${bucket.regime.toUpperCase()} | [${voteSummary}] ${agreeCount}/${total} | ${dur.label}`,
        'signal'
      );
      void executeTrade(evalResult.signal, dur, {
        voters: { MACRO_VEL: snapshot.macroVote, MICRO_VEL: snapshot.microVote, ACCEL: snapshot.accelVote },
        votesFor: agreeCount,
        votesNeeded: resolvedVotes,
        gates: { er, rTick, zScore },
        regime: computeMarketRegime(er, vol),
        effectiveMode: thresholds.effective,
        acceleration: accel ?? 0,
        entryPrice: prices[prices.length - 1]!,
      });
    } else if (evalResult.suppressed) {
      const GATE_DISPLAY: Record<string, string> = {
        NOISE: 'NOISE', EXHAUSTION: 'EXHAUSTION', VOLATILITY_ZSCORE: 'Z-SCORE',
        MARTINGALE: 'STREAK',
      };
      const gateLabel = GATE_DISPLAY[evalResult.suppressReason] ?? evalResult.suppressReason;

      const logRate = cfg.suppressionLogRate / 100;

      // ── Ghost capture ─────────────────────────────────────────────────────
      // Only arm when bot is enabled, Entry Engine had a direction (consensus),
      // and we have a resolved duration. MARTINGALE vetoes are money-management
      // rules, not market-signal rejections — exclude them from ghost tracking.
      if (
        isEnabledRef.current &&
        engineConsensus !== null &&
        dur !== null &&
        evalResult.suppressReason !== 'MARTINGALE'
      ) {
        const entryPx = prices[prices.length - 1]!;
        const expiryTarget =
          dur.unit === 't'
            ? ghostTickCount.current + dur.value
            : Date.now() + dur.value * (dur.unit === 'm' ? 60_000 : 1_000);

        // ── Signal debounce: global_debounce_seconds from /api/settings ─────
        // Ticks arrive 1-4×/sec. Without this gate, one choppy market episode
        // generates hundreds of identical rows, corrupting XGBoost feature weights.
        // cooldownMs is now a live parameter tunable from the admin UI.
        const ghostSymbol = activeSymbolRef.current?.underlying_symbol ?? 'unknown';
        const cooldownMs = globalSettingsRef.current.globalDebounceSeconds * 1_000;
        const lastLoggedAt = lastGhostLogTimeBySymbol.current.get(ghostSymbol) ?? 0;
        const withinCooldown = Date.now() - lastLoggedAt < cooldownMs;

        if (withinCooldown) {
          // Duplicate signal within the same opportunity window — drop silently.
          // Do not log to DB, do not add to pendingGhosts.
        } else {
        lastGhostLogTimeBySymbol.current.set(ghostSymbol, Date.now());

        fetch('/api/trade-logs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            executionType: 'GHOST',
            accountId: accountIdRef.current,
            direction: engineConsensus,
            symbol: activeSymbolRef.current?.underlying_symbol ?? 'unknown',
            effectiveMode: thresholds.effective,
            durationTarget: dur.value,
            durationUnit: dur.unit,
            entryPrice: String(entryPx),
            noiseAtEntry: String(er),
            zScoreAtEntry: String(zScore ?? 0),
            erAtEntry: String(er),
            accelerationAtEntry: String(accel ?? 0),
            stake: cfg.stake,
          }),
        })
          .then(r => r.json())
          .then((body: unknown) => {
            const { id } = body as { id?: number };
            if (typeof id === 'number') {
              pendingGhosts.current.push({
                id,
                direction: engineConsensus,
                entryPrice: entryPx,
                expiryTarget,
                expiryUnit: dur.unit as 't' | 's' | 'm',
              });
            }
          })
          .catch(() => {});

          if (Math.random() < logRate) {
            addLog(`⊘ Suppressed: ${gateLabel} → Shadow Tracking Armed`, 'info');
          }
        } // end debounce-passed else block
      } else if (Math.random() < logRate) {
        addLog(`⊘ Suppressed: ${gateLabel}`, 'info');
      }
    }
  }, [addLog, executeTrade]);

  // Always feed ticks — analysis runs regardless of bot state
  useEffect(() => {
    if (latestPrice === null || !activeSymbol) return;
    onTick(latestPrice);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestPrice]);

  useEffect(() => {
    if (!isEnabled) return;
    tickBuffer.current = [];
    setStatus('warming'); setIndicators(null);
    setActiveRegime(null); setActiveBucket(null);
    if (activeSymbol) addLog(`Symbol → ${activeSymbol.underlying_symbol_name} — recollecting data…`, 'info');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSymbol?.underlying_symbol]);

  const enable = useCallback(() => {
    const baseStake = parseFloat(configRef.current.stake) || 1;
    tickBuffer.current = [];
    lastTradeTime.current = 0;
    isTradingRef.current = false;
    botContractIds.current.clear();
    sellingIds.current.clear();
    processedForResult.current.clear();
    lastGhostLogTimeBySymbol.current.clear();
    currentStakeRef.current = baseStake;
    setCurrentStake(String(baseStake));
    setStats({ totalTrades: 0, wins: 0, losses: 0, consecutiveLosses: 0, consecutiveWins: 0, autoSells: 0 });
    statsRef.current = { totalTrades: 0, wins: 0, losses: 0, consecutiveLosses: 0, consecutiveWins: 0, autoSells: 0 };
    setSessionPnl(0);
    setPnlHistory([]);
    pnlHistoryRef.current = [];
    setLog([]);
    // Reset signal history (fresh session)
    signalHistoryRef.current = [];
    setSignalHistory([]);
    localStorage.removeItem(SIGNAL_HISTORY_KEY);
    setSignal(null); setIndicators(null);
    setActiveRegime(null); setActiveBucket(null); setBotPositions([]);
    setStatus('warming');
    setIsEnabled(true);
    addLog(`Bot enabled — collecting ${WARMUP_TICKS} ticks before analysis…`, 'info');
  }, [addLog]);

  const disable = useCallback(() => {
    setIsEnabled(false); setStatus('idle'); setSignal(null);
    setActiveRegime(null); setActiveBucket(null);
    persistSignalHistory(signalHistoryRef.current);
    addLog('Bot stopped by user', 'info');
  }, [addLog]);

  return {
    isEnabled, enable, disable, status, signal,
    adaptiveDuration, volatility, volHistory, indicators,
    assetClass, assetConfig, activeRegime, activeBucket,
    botPositions, currentStake,
    log, stats, config, setConfig,
    sessionPnl, pnlHistory,
    efficiencyRatio, activeVotes, marketRegime,
    gateStates, effectiveMode,
    signalHistory,
    routingTier, dynamicLookback,
    durationOptions: durationOptionsRef.current,
    suppressionCounts,
  };
}