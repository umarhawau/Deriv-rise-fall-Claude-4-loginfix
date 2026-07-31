/**
 * Risk Engine — Strategy Pattern
 *
 * Three isolated, pure sizing functions routed by a master dispatcher.
 * No React, no side-effects — pure TypeScript so they can be unit-tested
 * independently of any hook or component.
 */

import { CONFIDENCE_ENGINE } from './trading-config';

export type RiskEngine = 'OFF' | 'MARTINGALE' | 'ANTI_MARTINGALE' | 'CONFIDENCE';

export interface ConfidenceParams {
  erFloor: number;
  erCeiling: number;
  zExtreme: number;
}

export interface RiskContext {
  base: number;
  maxCap: number;
  consecutiveLosses: number;
  consecutiveWins: number;
  stakeMultiplier: number;
  er: number;
  zScore: number;
  /** Optional dynamic confidence engine params from DB. Falls back to CONFIDENCE_ENGINE constants. */
  confidenceParams?: ConfidenceParams;
}

// ─── Engine 1: Retail Recovery (Martingale) ───────────────────────────────────
// Doubles down after every loss. Reset to base on any win.
// WARNING: mathematically guaranteed to liquidate the account over a long
// enough timeline in a ranging market.

export function getMartingaleStake(
  base: number,
  consecutiveLosses: number,
  multiplier: number,
  maxCap: number,
): number {
  if (consecutiveLosses === 0) return base;
  const raw = base * Math.pow(multiplier, consecutiveLosses);
  return Math.min(Math.round(raw * 100) / 100, maxCap);
}

// ─── Engine 2: Anti-Martingale (Paroli) ───────────────────────────────────────
// Scales up after wins — rides hot streaks, resets on any loss.
// Safer than Martingale but still streak-dependent.

export function getAntiMartingaleStake(
  base: number,
  consecutiveWins: number,
  multiplier: number,
  maxCap: number,
): number {
  if (consecutiveWins === 0) return base;
  const raw = base * Math.pow(multiplier, consecutiveWins);
  return Math.min(Math.round(raw * 100) / 100, maxCap);
}

// ─── Engine 3: Confidence-Weighted Dynamic Sizing ─────────────────────────────
// Scales stake between [base, maxCap] using live signal quality as a proxy
// for edge.  Two orthogonal confidence dimensions are averaged:
//
//   1. ER Edge — how trending/directional is the market right now?
//      Computed as a linear ramp from erFloor (0% confidence) → erCeiling (100%).
//
//   2. Z-Score Haircut — how far is price from the mean?
//      Full confidence at |Z| = 0, zero confidence at |Z| ≥ zExtreme.
//
// The critical fix vs. a naive multiplier: a $10 base / $50 cap combination will
// actually reach $50 when confidence is 1.0.  A static 1.5× ceiling would cap at
// $15 and leave $35 of risk capacity unutilised during the ideal entry window.

export function getConfidenceStake(
  base: number,
  maxCap: number,
  er: number,
  zScore: number,
  params?: ConfidenceParams,
): number {
  const { erFloor, erCeiling, zExtreme } = params ?? CONFIDENCE_ENGINE;

  // 1. ER Edge — scales 0→1 across the configured ER floor→ceiling range
  let erConfidence = 0;
  if (er > erFloor) {
    erConfidence = Math.min(1.0, (er - erFloor) / (erCeiling - erFloor));
  }

  // 2. Z-Score Haircut — punishes stake as |Z| approaches the configured extreme
  const absZ = Math.abs(zScore);
  const zConfidence = absZ < zExtreme ? 1.0 - absZ / zExtreme : 0.0;

  // 3. Master Confidence Score — average of both dimensions
  const totalConfidence = (erConfidence + zConfidence) / 2;

  // 4. Linear map onto [base, maxCap] dollar range
  const stakeSpread = maxCap - base;
  const calculatedStake = base + stakeSpread * totalConfidence;

  return Math.round(calculatedStake * 100) / 100;
}

// ─── Master Router ────────────────────────────────────────────────────────────

export function calculateFinalStake(engine: RiskEngine, ctx: RiskContext): number {
  switch (engine) {
    case 'MARTINGALE':
      return getMartingaleStake(ctx.base, ctx.consecutiveLosses, ctx.stakeMultiplier, ctx.maxCap);
    case 'ANTI_MARTINGALE':
      return getAntiMartingaleStake(ctx.base, ctx.consecutiveWins, ctx.stakeMultiplier, ctx.maxCap);
    case 'CONFIDENCE':
      return getConfidenceStake(ctx.base, ctx.maxCap, ctx.er, ctx.zScore, ctx.confidenceParams);
    case 'OFF':
    default:
      return ctx.base;
  }
}
