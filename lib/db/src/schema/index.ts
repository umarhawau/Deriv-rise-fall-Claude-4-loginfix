import { pgTable, integer, text, numeric, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const systemSettingsTable = pgTable("system_settings", {
  id: integer("id").primaryKey(),
  callNoiseMin: numeric("call_noise_min").notNull().default("0.0000"),
  putNoiseMin: numeric("put_noise_min").notNull().default("0.6000"),
  globalDebounceSeconds: integer("global_debounce_seconds").notNull().default(15),
  sniperCallErMin: numeric("sniper_call_er_min").notNull().default("0.00"),
  sniperPutErMin: numeric("sniper_put_er_min").notNull().default("0.60"),
  balancedCallErMin: numeric("balanced_call_er_min").notNull().default("0.10"),
  balancedPutErMin: numeric("balanced_put_er_min").notNull().default("0.40"),
  aggressiveCallErMin: numeric("aggressive_call_er_min").notNull().default("0.20"),
  aggressivePutErMin: numeric("aggressive_put_er_min").notNull().default("0.30"),
  sniperZMax: numeric("sniper_z_max").notNull().default("1.5"),
  balancedZMax: numeric("balanced_z_max").notNull().default("2.0"),
  aggressiveZMax: numeric("aggressive_z_max").notNull().default("2.5"),
  autoErTrending: numeric("auto_er_trending").notNull().default("0.65"),
  autoErRanging: numeric("auto_er_ranging").notNull().default("0.45"),
  sniperExhaustionCall: numeric("sniper_exhaustion_call").notNull().default("0.75"),
  sniperExhaustionPut: numeric("sniper_exhaustion_put").notNull().default("0.25"),
  balancedExhaustionCall: numeric("balanced_exhaustion_call").notNull().default("0.80"),
  balancedExhaustionPut: numeric("balanced_exhaustion_put").notNull().default("0.20"),
  aggressiveExhaustionCall: numeric("aggressive_exhaustion_call").notNull().default("0.90"),
  aggressiveExhaustionPut: numeric("aggressive_exhaustion_put").notNull().default("0.10"),
  sniperRequiredVotes: integer("sniper_required_votes").notNull().default(3),
  balancedRequiredVotes: integer("balanced_required_votes").notNull().default(3),
  aggressiveRequiredVotes: integer("aggressive_required_votes").notNull().default(2),
  // ── Confidence / Stake-Sizing Engine ──────────────────────────────────────
  confidenceErFloor:   numeric("confidence_er_floor").notNull().default("0.40"),
  confidenceErCeiling: numeric("confidence_er_ceiling").notNull().default("0.80"),
  confidenceZExtreme:  numeric("confidence_z_extreme").notNull().default("2.50"),
  // ── Duration Sizer — Sniper Strike ────────────────────────────────────────
  sniperStrikeErFloor:   numeric("sniper_strike_er_floor").notNull().default("0.70"),
  sniperStrikeErCeiling: numeric("sniper_strike_er_ceiling").notNull().default("1.00"),
  sniperStrikeAccelMin:  numeric("sniper_strike_accel_min").notNull().default("1.50"),
  sniperStrikeMaxTicks:  integer("sniper_strike_max_ticks").notNull().default(10),
  // ── Duration Sizer — Momentum Ride ────────────────────────────────────────
  momentumRideErFloor:  numeric("momentum_ride_er_floor").notNull().default("0.50"),
  momentumRideErMedium: numeric("momentum_ride_er_medium").notNull().default("0.65"),
  momentumRideErLow:    numeric("momentum_ride_er_low").notNull().default("0.55"),
  // ── Analytics ─────────────────────────────────────────────────────────────
  expiryMinSample: integer("expiry_min_sample").notNull().default(30),
});

export const tradeLogsTable = pgTable("trade_logs", {
  id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
  accountId: text("account_id").notNull().default("unknown"),
  executionType: text("execution_type").$type<"LIVE" | "GHOST">().notNull(),
  status: text("status").$type<"PENDING" | "WIN" | "LOSS">().notNull().default("PENDING"),
  direction: text("direction").$type<"CALL" | "PUT">().notNull(),
  symbol: text("symbol").notNull(),
  effectiveMode: text("effective_mode").$type<"SNIPER" | "BALANCED" | "AGGRESSIVE">().notNull(),
  durationTarget: integer("duration_target").notNull(),
  durationUnit: text("duration_unit").$type<"t" | "s" | "m">().notNull(),
  entryPrice: numeric("entry_price").notNull(),
  noiseAtEntry: numeric("noise_at_entry").notNull(),
  zScoreAtEntry: numeric("z_score_at_entry").notNull(),
  erAtEntry: numeric("er_at_entry").notNull().default("0"),
  accelerationAtEntry: numeric("acceleration_at_entry").notNull().default("0"),
  stake: numeric("stake"),
  exitPrice: numeric("exit_price"),
  pnl: numeric("pnl"),
  resolvedAt: timestamp("resolved_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const symbolConfigTable = pgTable("symbol_config", {
  symbol: text("symbol").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  callEnabled: boolean("call_enabled").notNull().default(true),
  putEnabled: boolean("put_enabled").notNull().default(true),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const suppressionLogsTable = pgTable("suppression_logs", {
  id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
  symbol: text("symbol").notNull(),
  direction: text("direction").$type<"CALL" | "PUT" | "ALL">().notNull(),
  suppressedAt: timestamp("suppressed_at").notNull().defaultNow(),
});

export const marketProfilesTable = pgTable("market_profiles", {
  marketType: text("market_type")
    .$type<"synthetic" | "forex" | "metals" | "bull_bear" | "step">()
    .primaryKey(),
  sniperCallErMin:    numeric("sniper_call_er_min").notNull().default("0.05"),
  sniperPutErMin:     numeric("sniper_put_er_min").notNull().default("0.05"),
  sniperZMax:         numeric("sniper_z_max").notNull().default("1.5"),
  balancedCallErMin:  numeric("balanced_call_er_min").notNull().default("0.03"),
  balancedPutErMin:   numeric("balanced_put_er_min").notNull().default("0.03"),
  balancedZMax:       numeric("balanced_z_max").notNull().default("1.8"),
  aggressiveCallErMin: numeric("aggressive_call_er_min").notNull().default("0.02"),
  aggressivePutErMin:  numeric("aggressive_put_er_min").notNull().default("0.02"),
  aggressiveZMax:     numeric("aggressive_z_max").notNull().default("2.2"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type MarketProfile = typeof marketProfilesTable.$inferSelect;
export type MarketType = "synthetic" | "forex" | "metals" | "bull_bear" | "step";

export const insertTradeLogSchema = createInsertSchema(tradeLogsTable).omit({ createdAt: true });
export type InsertTradeLog = z.infer<typeof insertTradeLogSchema>;
export type TradeLog = typeof tradeLogsTable.$inferSelect;
export type SymbolConfig = typeof symbolConfigTable.$inferSelect;
