/**
 * Pure counterfactual backtest simulation.
 * No DB access here — pass in pre-fetched trade snapshots.
 */

export interface TradeSnapshot {
  noiseAtEntry: number;
  effectiveMode: string; // "SNIPER" | "BALANCED" | "AGGRESSIVE"
  direction: string;     // "CALL" | "PUT"
  status: string;        // "WIN" | "LOSS"
  pnl: number | null;
  symbol: string;
}

export interface ErGateThresholds {
  sniperCallErMin: number;
  sniperPutErMin: number;
  balancedCallErMin: number;
  balancedPutErMin: number;
  aggressiveCallErMin: number;
  aggressivePutErMin: number;
}

export interface SymbolDirectionKey {
  symbol: string;
  direction: "CALL" | "PUT";
}

export interface BacktestStats {
  tradeCount: number;
  wins: number;
  losses: number;
  winRate: number | null; // null if no resolved trades
  totalPnl: number;
}

export interface BacktestResult {
  windowSize: number;        // total trades in the window
  current: BacktestStats;
  proposed: BacktestStats;
  winRateDelta: number | null; // percentage-points; null if either side has no data
  pnlDelta: number;            // proposed.totalPnl - current.totalPnl
  tradesAffected: number;      // count of trades whose outcome changes between current & proposed
  looseningNote: boolean;      // true when proposed gate is looser (can't show upside)
}

// ─── helpers ────────────────────────────────────────────────────────────────

function computeStats(trades: TradeSnapshot[]): BacktestStats {
  const wins   = trades.filter(t => t.status === "WIN").length;
  const losses = trades.filter(t => t.status === "LOSS").length;
  const total  = wins + losses;
  const totalPnl = trades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  return {
    tradeCount: trades.length,
    wins,
    losses,
    winRate: total > 0 ? (wins / total) * 100 : null,
    totalPnl,
  };
}

/** Map a trade to the proposed ER gate minimum for its mode/direction. */
function proposedGateFor(
  trade: TradeSnapshot,
  thresholds: ErGateThresholds,
): number {
  const mode = trade.effectiveMode?.toUpperCase();
  const dir  = trade.direction?.toUpperCase();
  if (mode === "SNIPER"     && dir === "CALL") return thresholds.sniperCallErMin;
  if (mode === "SNIPER"     && dir === "PUT")  return thresholds.sniperPutErMin;
  if (mode === "BALANCED"   && dir === "CALL") return thresholds.balancedCallErMin;
  if (mode === "BALANCED"   && dir === "PUT")  return thresholds.balancedPutErMin;
  if (mode === "AGGRESSIVE" && dir === "CALL") return thresholds.aggressiveCallErMin;
  if (mode === "AGGRESSIVE" && dir === "PUT")  return thresholds.aggressivePutErMin;
  return 0; // unknown → always passes
}

// ─── ER-gate backtest ────────────────────────────────────────────────────────

/**
 * Simulate the effect of changing ER gate thresholds.
 *
 * "Current" pool = all resolved trades in the window (they already passed
 * the live gate).  "Proposed" pool = trades whose noiseAtEntry would also
 * satisfy the NEW gate.
 *
 * When the proposed gate is LOOSER, no new historical trades are available
 * to fill the extra room, so `proposed === current` and we set looseningNote.
 */
export function runErGateBacktest(
  trades: TradeSnapshot[],
  proposed: ErGateThresholds,
): BacktestResult {
  const resolved = trades.filter(t => t.status === "WIN" || t.status === "LOSS");

  // Check whether every threshold is looser-or-equal (looseningNote heuristic).
  // We only know whether individual trades would be filtered, so we compute
  // per-trade and let the aggregate speak.
  let tightenedCount = 0;
  let loosenedCount  = 0;

  const proposedTrades = resolved.filter(trade => {
    const gate = proposedGateFor(trade, proposed);
    const passes = trade.noiseAtEntry >= gate;
    if (!passes) tightenedCount++;
    // (Trades admitted by a looser gate can't appear — they weren't logged.)
    return passes;
  });

  // If proposed is strictly looser for all modes/dirs, note the limitation.
  // Heuristic: no trade was filtered out → likely a loosening or no-change.
  const looseningNote = tightenedCount === 0 && loosenedCount === 0;

  const current  = computeStats(resolved);
  const proposedStats = computeStats(proposedTrades);

  const winRateDelta =
    current.winRate != null && proposedStats.winRate != null
      ? proposedStats.winRate - current.winRate
      : null;

  return {
    windowSize:     resolved.length,
    current,
    proposed:       proposedStats,
    winRateDelta,
    pnlDelta:       proposedStats.totalPnl - current.totalPnl,
    tradesAffected: current.tradeCount - proposedStats.tradeCount,
    looseningNote,
  };
}

// ─── Symbol-disable backtest ─────────────────────────────────────────────────

/**
 * Simulate the effect of disabling specific symbol+direction pairs.
 *
 * "Current" pool = all resolved trades.
 * "Proposed" pool = current minus the disabled symbol/direction trades.
 *
 * ENABLE proposals cannot be backtested (the trades were never logged);
 * they are excluded from the simulation and noted separately.
 */
export function runSymbolDisableBacktest(
  trades: TradeSnapshot[],
  disables: SymbolDirectionKey[],
): BacktestResult {
  const resolved = trades.filter(t => t.status === "WIN" || t.status === "LOSS");

  const disableSet = new Set(
    disables.map(d => `${d.symbol}:${d.direction.toUpperCase()}`)
  );

  const proposedTrades = resolved.filter(
    t => !disableSet.has(`${t.symbol}:${t.direction?.toUpperCase()}`)
  );

  const current       = computeStats(resolved);
  const proposedStats = computeStats(proposedTrades);

  const winRateDelta =
    current.winRate != null && proposedStats.winRate != null
      ? proposedStats.winRate - current.winRate
      : null;

  return {
    windowSize:     resolved.length,
    current,
    proposed:       proposedStats,
    winRateDelta,
    pnlDelta:       proposedStats.totalPnl - current.totalPnl,
    tradesAffected: current.tradeCount - proposedStats.tradeCount,
    looseningNote:  false,
  };
}
