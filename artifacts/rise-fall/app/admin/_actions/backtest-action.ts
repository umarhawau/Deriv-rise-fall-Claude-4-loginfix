"use server";

import { db } from "@workspace/db";
import { tradeLogsTable } from "@workspace/db/schema";
import { eq, and, ne, desc } from "drizzle-orm";
import {
  runErGateBacktest,
  runSymbolDisableBacktest,
  type ErGateThresholds,
  type SymbolDirectionKey,
  type BacktestResult,
} from "@/lib/backtest";

export type { ErGateThresholds, SymbolDirectionKey, BacktestResult };

export type BacktestMode =
  | { kind: "er-gate"; proposed: ErGateThresholds }
  | { kind: "symbol-disable"; disables: SymbolDirectionKey[] };

/** Fetch the last `windowSize` resolved GHOST trades and run the simulation. */
export async function runBacktestAction(
  mode: BacktestMode,
  windowSize: number,
): Promise<{ success: true; data: BacktestResult } | { success: false; error: string }> {
  const size = Math.max(10, Math.min(windowSize, 2000));

  try {
    const rows = await db
      .select({
        noiseAtEntry: tradeLogsTable.noiseAtEntry,
        effectiveMode: tradeLogsTable.effectiveMode,
        direction: tradeLogsTable.direction,
        status: tradeLogsTable.status,
        pnl: tradeLogsTable.pnl,
        symbol: tradeLogsTable.symbol,
      })
      .from(tradeLogsTable)
      .where(
        and(
          eq(tradeLogsTable.executionType, "GHOST"),
          ne(tradeLogsTable.status, "PENDING"),
        ),
      )
      .orderBy(desc(tradeLogsTable.createdAt))
      .limit(size);

    const trades = rows.map((r) => ({
      noiseAtEntry: parseFloat(r.noiseAtEntry ?? "0"),
      effectiveMode: r.effectiveMode ?? "",
      direction: r.direction ?? "",
      status: r.status ?? "",
      pnl: r.pnl != null ? parseFloat(r.pnl) : null,
      symbol: r.symbol ?? "",
    }));

    const result =
      mode.kind === "er-gate"
        ? runErGateBacktest(trades, mode.proposed)
        : runSymbolDisableBacktest(trades, mode.disables);

    return { success: true, data: result };
  } catch (err: unknown) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
