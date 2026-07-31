import { NextResponse } from 'next/server';
import { db } from '@workspace/db';
import { tradeLogsTable } from '@workspace/db/schema';
import { ne, sql, avg, count, sum } from 'drizzle-orm';

const NO_CACHE = { 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache' };

export async function GET() {
  try {
    const rows = await db
      .select({
        symbol:    tradeLogsTable.symbol,
        direction: tradeLogsTable.direction,
        trades:    count(),
        wins:      sql<number>`COUNT(CASE WHEN ${tradeLogsTable.status} = 'WIN'  THEN 1 END)`.mapWith(Number),
        losses:    sql<number>`COUNT(CASE WHEN ${tradeLogsTable.status} = 'LOSS' THEN 1 END)`.mapWith(Number),
        winRate:   sql<number>`
          ROUND(
            COUNT(CASE WHEN ${tradeLogsTable.status} = 'WIN' THEN 1 END)::numeric
            / NULLIF(COUNT(CASE WHEN ${tradeLogsTable.status} IN ('WIN','LOSS') THEN 1 END), 0) * 100,
            2
          )`.mapWith(Number),
        totalPnl:  sum(tradeLogsTable.pnl),
        avgEr:     avg(tradeLogsTable.noiseAtEntry),
        avgErAtEntry: avg(tradeLogsTable.erAtEntry),
        avgZ:      avg(sql`ABS(${tradeLogsTable.zScoreAtEntry})`),
        avgAcc:    avg(tradeLogsTable.accelerationAtEntry),
        liveCount: sql<number>`COUNT(CASE WHEN ${tradeLogsTable.executionType} = 'LIVE'  THEN 1 END)`.mapWith(Number),
        ghostCount: sql<number>`COUNT(CASE WHEN ${tradeLogsTable.executionType} = 'GHOST' THEN 1 END)`.mapWith(Number),
      })
      .from(tradeLogsTable)
      .where(ne(tradeLogsTable.status, 'PENDING'))
      .groupBy(tradeLogsTable.symbol, tradeLogsTable.direction)
      .orderBy(tradeLogsTable.symbol, tradeLogsTable.direction);

    const parsed = rows.map(r => ({
      symbol:       r.symbol,
      direction:    r.direction,
      trades:       Number(r.trades),
      wins:         r.wins,
      losses:       r.losses,
      win_rate_pct: r.winRate,
      total_pnl:    r.totalPnl  != null ? parseFloat(r.totalPnl)  : null,
      avg_er:       r.avgEr     != null ? parseFloat(r.avgEr)     : null,
      avg_er_at_entry: r.avgErAtEntry != null ? parseFloat(r.avgErAtEntry) : null,
      avg_z_abs:    r.avgZ      != null ? parseFloat(String(r.avgZ)) : null,
      avg_acc:      r.avgAcc    != null ? parseFloat(r.avgAcc)    : null,
      live_trades:  r.liveCount,
      ghost_trades: r.ghostCount,
      // Derived: profitability signal for ML labeling
      label: (() => {
        const wr = r.winRate;
        if (wr == null || Number(r.trades) < 50) return 'INSUFFICIENT_DATA';
        if (Number(r.trades) >= 100 && wr < 45)  return 'DISABLE';
        if (Number(r.trades) >= 50  && wr < 45)  return 'WATCHLIST';
        if (wr >= 50)                             return 'KEEP';
        return 'MONITOR';
      })(),
    }));

    return NextResponse.json({
      generated_at: new Date().toISOString(),
      total_rows: parsed.length,
      description: 'Per-symbol × per-direction aggregate stats for ML training. Each row is one (symbol, direction) pair with win rate, ER, Z-score, acceleration, and a derived label.',
      schema: {
        symbol:          'Deriv symbol identifier',
        direction:       'CALL | PUT',
        trades:          'Total resolved trades',
        wins:            'Win count',
        losses:          'Loss count',
        win_rate_pct:    'Win rate as percentage (0–100)',
        total_pnl:       'Sum of PnL for live trades',
        avg_er:          'Average noise/ER at entry (Kaufman ER proxy)',
        avg_er_at_entry: 'Average quant ER at entry',
        avg_z_abs:       'Average |Z-score| at entry',
        avg_acc:         'Average acceleration at entry',
        live_trades:     'Subset of trades with real money',
        ghost_trades:    'Subset of vetoed/shadow trades',
        label:           'ML label: KEEP | MONITOR | WATCHLIST | DISABLE | INSUFFICIENT_DATA',
      },
      data: parsed,
    }, { headers: NO_CACHE });
  } catch (err) {
    return NextResponse.json({ error: 'Failed to export', detail: String(err) }, { status: 500, headers: NO_CACHE });
  }
}
