/**
 * Market Type Classifier
 *
 * Maps a Deriv underlying_symbol to one of the 5 market profile categories.
 * Falls back to 'synthetic' for unrecognised Deriv derived-index symbols.
 */

export type MarketType = "synthetic" | "forex" | "metals" | "bull_bear" | "step";

/**
 * Classify a Deriv symbol into a market profile category.
 *
 * Patterns (Deriv naming conventions):
 *  Synthetic  — R_10/25/50/75/100, 1HZ10V/25V/50V/75V/100V/150V/200V, JD10/25/50/75/100
 *  Step       — STPINDX*, 1HZ*S  (step variant suffix 'S')
 *  Bull/Bear  — BOOM*, CRASH*, BULL_*, BEAR_*
 *  Metals     — frxXAU*, frxXAG*, frxXPT*, frxXPD*
 *  Forex      — frx* (everything else), OTC forex pairs
 */
export function classifyMarket(symbol: string): MarketType {
  const s = symbol.toUpperCase();

  // Step indices — 1HZ*S (1-second step) or STPINDX*
  if (/^1HZ\d+S$/.test(s) || s.startsWith("STPINDX")) return "step";

  // Boom / Crash / Bull / Bear indices
  if (s.startsWith("BOOM") || s.startsWith("CRASH") || s.startsWith("BULL_") || s.startsWith("BEAR_")) return "bull_bear";

  // Volatility & Jump synthetic indices
  if (/^R_\d+$/.test(s) || /^1HZ\d+V$/.test(s) || /^JD\d+$/.test(s)) return "synthetic";

  // Metals (spot): XAUUSD, XAGUSD, XPTUSD, XPDUSD — with or without frx prefix
  if (/XAU|XAG|XPT|XPD/.test(s)) return "metals";

  // Everything else: forex pairs (frxEURUSD, frxAUDJPY, OTC variants …)
  return "forex";
}

export const MARKET_LABELS: Record<MarketType, string> = {
  synthetic: "Synthetic Indices",
  forex:     "Forex Pairs",
  metals:    "Metals",
  bull_bear: "Bull / Bear Indices",
  step:      "Step Indices",
};

export const MARKET_ICONS: Record<MarketType, string> = {
  synthetic: "⚡",
  forex:     "💱",
  metals:    "🥇",
  bull_bear: "🐂",
  step:      "📶",
};

export const MARKET_TYPES: MarketType[] = ["synthetic", "forex", "metals", "bull_bear", "step"];
