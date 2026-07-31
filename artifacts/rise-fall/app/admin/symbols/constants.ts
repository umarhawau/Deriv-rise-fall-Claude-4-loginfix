// Recommendation thresholds — single source of truth.
// This file has NO 'use server' directive so it can export plain values
// alongside the async server actions in actions.ts.
export const REC_THRESHOLDS = {
  MIN_DISPLAY_TRADES: 30,
  HC_MIN_TRADES:      50,
  DISABLE_MAX_WR:     45,
  WATCH_MAX_WR:       52,
} as const;

export interface HighConfidenceCandidate {
  symbol: string;
  direction: 'CALL' | 'PUT';
  trades: number;
  winRate: number;
}
