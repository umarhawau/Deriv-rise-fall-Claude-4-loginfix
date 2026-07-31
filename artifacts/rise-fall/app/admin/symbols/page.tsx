import { db } from '@workspace/db';
import { tradeLogsTable, symbolConfigTable, suppressionLogsTable } from '@workspace/db/schema';
import { eq, ne, and, sql, avg, count, sum, gte } from 'drizzle-orm';
import { AdminLoginForm } from '../quant/login-form';
import { isAdminAuthorized } from '../quant/admin-auth';
import { logoutAction } from '../quant/actions';
import { AdminNav } from '../admin-nav';
import { AutoRefresh } from '../auto-refresh';
import { getSymbolDisplayName } from '@/lib/active-symbols-display-names';
import { DERIV_PAYOUT_RATE } from '@/lib/trading-config';
import { toggleSymbolAction, toggleDirectionAction } from './actions';
import { type HighConfidenceCandidate, REC_THRESHOLDS } from './constants';
import { ApplyRecommendations } from './apply-recommendations';
import { RecommendationApproval, type DisableRec } from './recommendation-approval';
import AiTuneClient from './ai-tune-client';
import type { SymbolTuneInput } from '@/app/api/admin/symbols/ai-tune/route';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

type ViewType = 'ALL' | 'LIVE' | 'GHOST';

// ── Recommendation thresholds — imported from actions.ts (single source) ────
const { MIN_DISPLAY_TRADES, HC_MIN_TRADES, DISABLE_MAX_WR, WATCH_MAX_WR } = REC_THRESHOLDS;
const WEAK_WR     = DISABLE_MAX_WR;  // alias used in getRecommendation + legend
const WATCH_WR_MAX = WATCH_MAX_WR;   // alias used in getRecommendation
const WARN_TRADES  = MIN_DISPLAY_TRADES; // minimum trades before flagging as statistically weak

// Breakeven win rate derived from Deriv payout: 1 / (1 + payout)
// At 85% payout → 1/1.85 = 54.05% → rounded to 1dp = 54.1%
// Update DERIV_PAYOUT_RATE in lib/trading-config.ts and this auto-corrects.
const BREAKEVEN_PCT = Math.round((1 / (1 + DERIV_PAYOUT_RATE)) * 1000) / 10;

type RecommendationLevel = 'KEEP' | 'WATCH' | 'DISABLE' | 'INSUFFICIENT DATA';

function getRecommendation(trades: number, wr: number | null): RecommendationLevel {
  if (wr == null || trades < MIN_DISPLAY_TRADES) return 'INSUFFICIENT DATA';
  if (wr < WEAK_WR)     return 'DISABLE';
  if (wr <= WATCH_WR_MAX) return 'WATCH';
  return 'KEEP';
}

/** True if this direction meets the high-confidence disable threshold */
function isHighConfidenceDisable(trades: number, wr: number | null): boolean {
  return trades >= HC_MIN_TRADES && wr != null && wr < WEAK_WR;
}

interface SymbolStats {
  symbol: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgEr: number | null;
  avgZ: number | null;
  avgAcc: number | null;
  totalPnl: number | null;
  enabled: boolean;
  callEnabled: boolean;
  putEnabled: boolean;
}

interface DirectionRow {
  symbol: string;
  direction: 'CALL' | 'PUT';
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  totalPnl: number | null;
  avgEr: number | null;
  avgZ: number | null;
}

interface SymbolDirectionStats {
  symbol: string;
  callTrades: number;
  callWins: number;
  callLosses: number;
  callWinRate: number | null;
  callPnl: number | null;
  callAvgEr: number | null;
  callAvgZ: number | null;
  putTrades: number;
  putWins: number;
  putLosses: number;
  putWinRate: number | null;
  putPnl: number | null;
  putAvgEr: number | null;
  putAvgZ: number | null;
  callEnabled: boolean;
  putEnabled: boolean;
  enabled: boolean;
}

// ── Recommendation engine ──────────────────────────────────────────────────────

interface DirectionRec {
  symbol:           string;
  direction:        'CALL' | 'PUT';
  action:           'KEEP' | 'WATCH' | 'DISABLE' | 'INSUFFICIENT';
  wr:               number | null;
  trades:           number;
  pnl:              number | null;
  confidence:       'HIGH' | 'MEDIUM' | 'LOW' | null;
  reason:           string;
  currentlyEnabled: boolean;
}

function computeRecommendations(
  dirStats:  SymbolDirectionStats[],
  trendMap:  Map<string, { wr7: number | null; wr7prev: number | null; trend: string }>,
  breakeven: number,
): DirectionRec[] {
  const fmt = (v: number | null) =>
    v == null ? 'N/A' : `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(0)}`;

  const recs: DirectionRec[] = [];
  for (const row of dirStats) {
    for (const dir of ['CALL', 'PUT'] as const) {
      const trades  = dir === 'CALL' ? row.callTrades  : row.putTrades;
      const wr      = dir === 'CALL' ? row.callWinRate : row.putWinRate;
      const pnl     = dir === 'CALL' ? row.callPnl     : row.putPnl;
      const enabled = dir === 'CALL' ? row.callEnabled : row.putEnabled;
      const tw      = trendMap.get(row.symbol);

      const confidence: DirectionRec['confidence'] =
        trades >= 100 ? 'HIGH' :
        trades >= 50  ? 'MEDIUM' :
        trades >= 30  ? 'LOW' : null;

      let action: DirectionRec['action'];
      if (trades < MIN_DISPLAY_TRADES || wr == null) {
        action = 'INSUFFICIENT';
      } else if (trades >= HC_MIN_TRADES && wr < WEAK_WR) {
        action = 'DISABLE';
      } else if (wr < WATCH_WR_MAX) {
        action = 'WATCH';
      } else {
        action = 'KEEP';
      }

      let reason: string;
      if (action === 'INSUFFICIENT') {
        const needed = Math.max(0, MIN_DISPLAY_TRADES - trades);
        reason = needed > 0
          ? `Only ${trades} resolved trade${trades !== 1 ? 's' : ''}. Need ${needed} more before a recommendation can be formed. No action should be taken yet.`
          : `Trades recorded but win rate is not computable — no resolved outcomes yet.`;
      } else if (action === 'DISABLE') {
        const gap = (breakeven - wr!).toFixed(1);
        const trendNote =
          tw?.trend === 'IMPROVING' && tw.wr7 != null && tw.wr7prev != null
            ? ` Important: this direction is trending UP this week (+${(tw.wr7 - tw.wr7prev).toFixed(1)}pp vs prev-7d) — verify trend before disabling.`
            : tw?.trend === 'DECLINING'
              ? ` Also declining week-over-week — deterioration is sustained.`
              : '';
        reason = `WR ${wr!.toFixed(1)}% is ${gap}pp below the ${breakeven}% breakeven across ${trades} resolved trades. P&L: ${fmt(pnl)}.${trendNote} Continuing this direction costs net capital per cycle.`;
      } else if (action === 'WATCH') {
        if (trades < HC_MIN_TRADES) {
          reason = `Sample of ${trades} trades is below the ${HC_MIN_TRADES}-trade minimum required for a DISABLE recommendation. WR ${wr!.toFixed(1)}%  — P&L: ${fmt(pnl)}. Do not act on a disable until sample exceeds ${HC_MIN_TRADES}.`;
        } else {
          const gap = (breakeven - wr!).toFixed(1);
          reason = `WR ${wr!.toFixed(1)}% is within the watch zone (${WEAK_WR}–${WATCH_WR_MAX}%), ${gap}pp from breakeven. P&L: ${fmt(pnl)} across ${trades} trades. Monitor for additional sessions before acting.`;
        }
      } else {
        const edge = (wr! - breakeven).toFixed(1);
        reason = `WR ${wr!.toFixed(1)}% is ${edge}pp above the ${breakeven}% breakeven across ${trades} trades. P&L: ${fmt(pnl)}. Direction is performing profitably — no action needed.`;
      }

      recs.push({ symbol: row.symbol, direction: dir, action, wr, trades, pnl, confidence, reason, currentlyEnabled: enabled });
    }
  }

  const order = { DISABLE: 0, WATCH: 1, KEEP: 2, INSUFFICIENT: 3 } as const;
  const confRank: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  return recs.sort((a, b) => {
    const diff = order[a.action] - order[b.action];
    if (diff !== 0) return diff;
    if (a.action === 'DISABLE') {
      const cr = (confRank[a.confidence ?? ''] ?? 3) - (confRank[b.confidence ?? ''] ?? 3);
      if (cr !== 0) return cr;
      return (a.wr ?? 100) - (b.wr ?? 100);
    }
    return (b.wr ?? 0) - (a.wr ?? 0);
  });
}

// ── UI primitives ─────────────────────────────────────────────────────────────

/** SVG sparkline for weekly WR. Width=160 Height=40. Breakeven line at 54.1%. */
function WrSparkline({ points, w = 160, h = 40 }: {
  points: Array<{ wr: number | null; trades: number }>;
  w?: number; h?: number;
}) {
  const valid = points.filter(p => p.wr != null && p.trades >= 3);
  if (valid.length < 2) return (
    <div style={{ width: w, height: h }} className="flex items-center justify-center">
      <span className="text-[9px] text-gray-300 dark:text-zinc-700">not enough data</span>
    </div>
  );
  const minWr = Math.max(0,  Math.min(...valid.map(p => p.wr!)) - 5);
  const maxWr = Math.min(100, Math.max(...valid.map(p => p.wr!)) + 5);
  const range = maxWr - minWr || 10;
  const pad = 4;
  const uw = (w - 2 * pad) / (valid.length - 1);
  const toY = (wr: number) => pad + ((maxWr - wr) / range) * (h - 2 * pad);
  const pts = valid.map((p, i) => `${pad + i * uw},${toY(p.wr!)}`).join(' ');
  const beY = toY(54.1);
  const last = valid[valid.length - 1].wr!;
  const prev = valid[valid.length - 2].wr!;
  const stroke = last > prev + 2 ? '#10b981' : last < prev - 2 ? '#f43f5e' : '#6b7280';
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} xmlns="http://www.w3.org/2000/svg">
      {/* breakeven reference line */}
      {beY > pad && beY < h - pad && (
        <line x1={pad} y1={beY} x2={w - pad} y2={beY}
          stroke="#f59e0b" strokeWidth="0.8" strokeDasharray="2,2" opacity="0.5" />
      )}
      <polyline fill="none" stroke={stroke} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" points={pts} />
      {/* dot on last point */}
      <circle cx={pad + (valid.length - 1) * uw} cy={toY(last)} r="2.5" fill={stroke} />
    </svg>
  );
}

function TrendBadge({ trend }: { trend: 'IMPROVING' | 'DECLINING' | 'STABLE' | 'INSUFFICIENT' }) {
  if (trend === 'IMPROVING') return (
    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-[9px] font-bold bg-emerald-500/15 border-emerald-500/30 text-emerald-700 dark:text-emerald-400">
      ↑ IMPROVING
    </span>
  );
  if (trend === 'DECLINING') return (
    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-[9px] font-bold bg-rose-500/15 border-rose-500/30 text-rose-700 dark:text-rose-400">
      ↓ DECLINING
    </span>
  );
  if (trend === 'STABLE') return (
    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-[9px] font-bold bg-gray-200/80 border-gray-300 dark:bg-zinc-800 dark:border-zinc-700 text-gray-600 dark:text-zinc-400">
      → STABLE
    </span>
  );
  return (
    <span className="text-[9px] text-gray-400 dark:text-zinc-600 font-mono">no data</span>
  );
}

function WrBadge({ rate, size = 'md' }: { rate: number | null; size?: 'sm' | 'md' }) {
  if (rate == null) return <span className="text-gray-400 dark:text-zinc-600 font-mono">—</span>;
  const color =
    rate >= 58 ? 'text-emerald-500 dark:text-emerald-400' :
    rate >= 52 ? 'text-blue-500 dark:text-blue-400' :
    rate >= 48 ? 'text-amber-500 dark:text-amber-400' :
    'text-rose-500 dark:text-rose-400';
  const cls = size === 'sm' ? 'tabular-nums font-mono text-[11px]' : 'font-bold tabular-nums font-mono';
  return <span className={`${cls} ${color}`}>{rate.toFixed(1)}%</span>;
}

function PnlCell({ val, compact }: { val: number | null; compact?: boolean }) {
  if (val == null) return <span className="text-gray-400 dark:text-zinc-600 font-mono">—</span>;
  const color = val >= 0 ? 'text-emerald-500 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400';
  const text = compact
    ? `${val >= 0 ? '+' : ''}$${Math.abs(val).toFixed(0)}`
    : `${val >= 0 ? '+' : ''}$${val.toFixed(2)}`;
  return <span className={`font-mono tabular-nums font-semibold ${color} ${compact ? 'text-[11px]' : ''}`}>{text}</span>;
}

function WrBar({ wr }: { wr: number | null }) {
  if (wr == null) return null;
  const pct = Math.min(wr, 100);
  const bg = wr >= 54 ? 'bg-emerald-500' : wr >= 48 ? 'bg-amber-400' : 'bg-rose-500';
  return (
    <div className="flex-1 h-1.5 bg-gray-100 dark:bg-zinc-800 rounded-full overflow-hidden">
      <div className={`h-full rounded-full ${bg}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function RecommendationBadge({ trades, wr }: { trades: number; wr: number | null }) {
  const level = getRecommendation(trades, wr);
  if (level === 'INSUFFICIENT DATA') {
    const needed = Math.max(0, MIN_DISPLAY_TRADES - trades);
    return <span className="text-[9px] text-gray-400 dark:text-zinc-600 font-mono whitespace-nowrap">{needed > 0 ? `need ${needed} more` : '…'}</span>;
  }
  const styles: Record<RecommendationLevel, string> = {
    'KEEP':             'bg-emerald-500/15 border-emerald-500/30 text-emerald-700 dark:text-emerald-400',
    'WATCH':            'bg-amber-500/15 border-amber-500/30 text-amber-700 dark:text-amber-400',
    'DISABLE':          'bg-rose-500/20 border-rose-500/40 text-rose-700 dark:text-rose-400',
    'INSUFFICIENT DATA':'',
  };
  const label =
    level === 'DISABLE' ? '🔴 DISABLE' :
    level === 'WATCH'   ? '🟡 WATCH'   :
                          '🟢 KEEP';
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[9px] font-bold uppercase tracking-wide whitespace-nowrap ${styles[level]}`}>
      {label}
    </span>
  );
}

function WeakDirectionBadge({ trades, wr }: { trades: number; wr: number | null }) {
  if (wr == null || trades < WARN_TRADES || wr >= WEAK_WR) return null;
  return (
    <span className="inline-block text-[8px] font-semibold text-rose-500 dark:text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded px-1 py-px leading-tight whitespace-nowrap">
      Statistically Weak
    </span>
  );
}

function DirectionToggle({ symbol, direction, enabled }: { symbol: string; direction: 'CALL' | 'PUT'; enabled: boolean }) {
  const action = toggleDirectionAction.bind(null, symbol, direction, enabled);
  return (
    <form action={action}>
      <button
        type="submit"
        title={`${enabled ? 'Disable' : 'Enable'} ${direction} trades on ${symbol}`}
        className={`px-2 py-0.5 rounded text-[10px] font-bold border transition-all ${
          enabled
            ? direction === 'CALL'
              ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/30'
              : 'bg-rose-500/20 border-rose-500/40 text-rose-600 dark:text-rose-400 hover:bg-rose-500/30'
            : 'bg-gray-100 dark:bg-zinc-800 border-gray-300 dark:border-zinc-700 text-gray-400 dark:text-zinc-600 line-through hover:opacity-80'
        }`}
      >
        {direction === 'CALL' ? '📈' : '📉'} {direction}
      </button>
    </form>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function SymbolPerformancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  if (!await isAdminAuthorized()) return <AdminLoginForm />;

  const sp = await searchParams;
  const view       = (sp.view ?? 'ALL') as ViewType;
  const activeTab  = sp.tab ?? 'overview';

  const baseWhere = ne(tradeLogsTable.status, 'PENDING');
  const buildWhere = (exType?: 'LIVE' | 'GHOST') =>
    exType ? and(baseWhere, eq(tradeLogsTable.executionType, exType)) : baseWhere;
  const exTypeForQuery = view === 'ALL' ? undefined : view;

  const todayUtc = new Date();
  todayUtc.setUTCHours(0, 0, 0, 0);

  const [rawStats, rawDirStats, symbolConfigs, rawSuppressions, rawTakenToday, rawWindowStats, rawSparkline, rawDirWindowStats] = await Promise.all([
    db.select({
        symbol:  tradeLogsTable.symbol,
        trades:  count(),
        wins:    sql<number>`COUNT(CASE WHEN ${tradeLogsTable.status} = 'WIN' THEN 1 END)`.mapWith(Number),
        losses:  sql<number>`COUNT(CASE WHEN ${tradeLogsTable.status} = 'LOSS' THEN 1 END)`.mapWith(Number),
        avgEr:   avg(tradeLogsTable.noiseAtEntry),
        avgZ:    avg(sql`ABS(${tradeLogsTable.zScoreAtEntry})`),
        avgAcc:  avg(tradeLogsTable.accelerationAtEntry),
        totalPnl: sum(tradeLogsTable.pnl),
      })
      .from(tradeLogsTable)
      .where(buildWhere(exTypeForQuery))
      .groupBy(tradeLogsTable.symbol),

    // Per-symbol × per-direction: now includes avgEr + avgZ for ML export
    db.select({
        symbol:    tradeLogsTable.symbol,
        direction: tradeLogsTable.direction,
        trades:    count(),
        wins:      sql<number>`COUNT(CASE WHEN ${tradeLogsTable.status} = 'WIN' THEN 1 END)`.mapWith(Number),
        losses:    sql<number>`COUNT(CASE WHEN ${tradeLogsTable.status} = 'LOSS' THEN 1 END)`.mapWith(Number),
        totalPnl:  sum(tradeLogsTable.pnl),
        avgEr:     avg(tradeLogsTable.noiseAtEntry),
        avgZ:      avg(sql`ABS(${tradeLogsTable.zScoreAtEntry})`),
      })
      .from(tradeLogsTable)
      .where(buildWhere(exTypeForQuery))
      .groupBy(tradeLogsTable.symbol, tradeLogsTable.direction),

    db.select().from(symbolConfigTable),

    // Today's suppression counts per symbol + direction
    db.select({
        symbol:    suppressionLogsTable.symbol,
        direction: suppressionLogsTable.direction,
        count:     sql<number>`COUNT(*)`.mapWith(Number),
      })
      .from(suppressionLogsTable)
      .where(gte(suppressionLogsTable.suppressedAt, todayUtc))
      .groupBy(suppressionLogsTable.symbol, suppressionLogsTable.direction),

    // Today's trades taken per symbol + direction (for Taken vs Suppressed analytics)
    db.select({
        symbol:    tradeLogsTable.symbol,
        direction: tradeLogsTable.direction,
        count:     count(),
      })
      .from(tradeLogsTable)
      .where(and(ne(tradeLogsTable.status, 'PENDING'), gte(tradeLogsTable.createdAt, todayUtc)))
      .groupBy(tradeLogsTable.symbol, tradeLogsTable.direction),

    // 7 / 30 / 90-day windowed WR + PnL + prev-7d for trend direction
    db.select({
        symbol:  tradeLogsTable.symbol,
        w7:      sql<number>`COUNT(CASE WHEN ${tradeLogsTable.createdAt} >= NOW()-INTERVAL '7 days'  AND ${tradeLogsTable.status}='WIN'              THEN 1 END)`.mapWith(Number),
        r7:      sql<number>`COUNT(CASE WHEN ${tradeLogsTable.createdAt} >= NOW()-INTERVAL '7 days'  AND ${tradeLogsTable.status} IN ('WIN','LOSS')  THEN 1 END)`.mapWith(Number),
        p7:      sql<number>`COALESCE(SUM(CASE WHEN ${tradeLogsTable.createdAt} >= NOW()-INTERVAL '7 days'  THEN ${tradeLogsTable.pnl}::numeric ELSE 0 END),0)`.mapWith(Number),
        pw7:     sql<number>`COUNT(CASE WHEN ${tradeLogsTable.createdAt} BETWEEN NOW()-INTERVAL '14 days' AND NOW()-INTERVAL '7 days' AND ${tradeLogsTable.status}='WIN'             THEN 1 END)`.mapWith(Number),
        pr7:     sql<number>`COUNT(CASE WHEN ${tradeLogsTable.createdAt} BETWEEN NOW()-INTERVAL '14 days' AND NOW()-INTERVAL '7 days' AND ${tradeLogsTable.status} IN ('WIN','LOSS') THEN 1 END)`.mapWith(Number),
        w30:     sql<number>`COUNT(CASE WHEN ${tradeLogsTable.createdAt} >= NOW()-INTERVAL '30 days' AND ${tradeLogsTable.status}='WIN'              THEN 1 END)`.mapWith(Number),
        r30:     sql<number>`COUNT(CASE WHEN ${tradeLogsTable.createdAt} >= NOW()-INTERVAL '30 days' AND ${tradeLogsTable.status} IN ('WIN','LOSS')  THEN 1 END)`.mapWith(Number),
        p30:     sql<number>`COALESCE(SUM(CASE WHEN ${tradeLogsTable.createdAt} >= NOW()-INTERVAL '30 days' THEN ${tradeLogsTable.pnl}::numeric ELSE 0 END),0)`.mapWith(Number),
        w90:     sql<number>`COUNT(CASE WHEN ${tradeLogsTable.createdAt} >= NOW()-INTERVAL '90 days' AND ${tradeLogsTable.status}='WIN'              THEN 1 END)`.mapWith(Number),
        r90:     sql<number>`COUNT(CASE WHEN ${tradeLogsTable.createdAt} >= NOW()-INTERVAL '90 days' AND ${tradeLogsTable.status} IN ('WIN','LOSS')  THEN 1 END)`.mapWith(Number),
        p90:     sql<number>`COALESCE(SUM(CASE WHEN ${tradeLogsTable.createdAt} >= NOW()-INTERVAL '90 days' THEN ${tradeLogsTable.pnl}::numeric ELSE 0 END),0)`.mapWith(Number),
      })
      .from(tradeLogsTable)
      .where(and(ne(tradeLogsTable.status, 'PENDING'), gte(tradeLogsTable.createdAt, sql`NOW()-INTERVAL '90 days'`)))
      .groupBy(tradeLogsTable.symbol),

    // Weekly sparkline: WR per week (last 12 weeks) per symbol
    db.select({
        symbol: tradeLogsTable.symbol,
        week:   sql<string>`DATE_TRUNC('week', ${tradeLogsTable.createdAt})::text`,
        wins:   sql<number>`COUNT(CASE WHEN ${tradeLogsTable.status}='WIN' THEN 1 END)`.mapWith(Number),
        total:  sql<number>`COUNT(CASE WHEN ${tradeLogsTable.status} IN ('WIN','LOSS') THEN 1 END)`.mapWith(Number),
        trades: count(),
      })
      .from(tradeLogsTable)
      .where(and(ne(tradeLogsTable.status, 'PENDING'), gte(tradeLogsTable.createdAt, sql`NOW()-INTERVAL '84 days'`)))
      .groupBy(tradeLogsTable.symbol, sql`DATE_TRUNC('week', ${tradeLogsTable.createdAt})`)
      .orderBy(tradeLogsTable.symbol, sql`DATE_TRUNC('week', ${tradeLogsTable.createdAt})`),

    // Per-direction windowed WR + PnL: CALL vs PUT × 7d / 30d / 90d
    db.select({
        symbol:    tradeLogsTable.symbol,
        direction: tradeLogsTable.direction,
        w7:   sql<number>`COUNT(CASE WHEN ${tradeLogsTable.createdAt} >= NOW()-INTERVAL '7 days'  AND ${tradeLogsTable.status}='WIN'             THEN 1 END)`.mapWith(Number),
        r7:   sql<number>`COUNT(CASE WHEN ${tradeLogsTable.createdAt} >= NOW()-INTERVAL '7 days'  AND ${tradeLogsTable.status} IN ('WIN','LOSS') THEN 1 END)`.mapWith(Number),
        p7:   sql<number>`COALESCE(SUM(CASE WHEN ${tradeLogsTable.createdAt} >= NOW()-INTERVAL '7 days'  THEN ${tradeLogsTable.pnl}::numeric ELSE 0 END),0)`.mapWith(Number),
        w30:  sql<number>`COUNT(CASE WHEN ${tradeLogsTable.createdAt} >= NOW()-INTERVAL '30 days' AND ${tradeLogsTable.status}='WIN'             THEN 1 END)`.mapWith(Number),
        r30:  sql<number>`COUNT(CASE WHEN ${tradeLogsTable.createdAt} >= NOW()-INTERVAL '30 days' AND ${tradeLogsTable.status} IN ('WIN','LOSS') THEN 1 END)`.mapWith(Number),
        p30:  sql<number>`COALESCE(SUM(CASE WHEN ${tradeLogsTable.createdAt} >= NOW()-INTERVAL '30 days' THEN ${tradeLogsTable.pnl}::numeric ELSE 0 END),0)`.mapWith(Number),
        w90:  sql<number>`COUNT(CASE WHEN ${tradeLogsTable.createdAt} >= NOW()-INTERVAL '90 days' AND ${tradeLogsTable.status}='WIN'             THEN 1 END)`.mapWith(Number),
        r90:  sql<number>`COUNT(CASE WHEN ${tradeLogsTable.createdAt} >= NOW()-INTERVAL '90 days' AND ${tradeLogsTable.status} IN ('WIN','LOSS') THEN 1 END)`.mapWith(Number),
        p90:  sql<number>`COALESCE(SUM(CASE WHEN ${tradeLogsTable.createdAt} >= NOW()-INTERVAL '90 days' THEN ${tradeLogsTable.pnl}::numeric ELSE 0 END),0)`.mapWith(Number),
      })
      .from(tradeLogsTable)
      .where(and(ne(tradeLogsTable.status, 'PENDING'), gte(tradeLogsTable.createdAt, sql`NOW()-INTERVAL '90 days'`)))
      .groupBy(tradeLogsTable.symbol, tradeLogsTable.direction),
  ]);

  const configMap = new Map(symbolConfigs.map((c) => [c.symbol, c]));

  const stats: SymbolStats[] = rawStats
    .map((r) => {
      const resolved = r.wins + r.losses;
      const cfg = configMap.get(r.symbol);
      return {
        symbol:    r.symbol,
        trades:    Number(r.trades),
        wins:      r.wins,
        losses:    r.losses,
        winRate:   resolved > 0 ? (r.wins / resolved) * 100 : null,
        avgEr:     r.avgEr  != null ? parseFloat(r.avgEr)  : null,
        avgZ:      r.avgZ   != null ? parseFloat(String(r.avgZ)) : null,
        avgAcc:    r.avgAcc != null ? parseFloat(r.avgAcc) : null,
        totalPnl:  r.totalPnl != null ? parseFloat(r.totalPnl) : null,
        enabled:      cfg?.enabled      ?? true,
        callEnabled:  cfg?.callEnabled  ?? true,
        putEnabled:   cfg?.putEnabled   ?? true,
      };
    })
    .sort((a, b) => {
      if (a.winRate == null && b.winRate == null) return 0;
      if (a.winRate == null) return 1;
      if (b.winRate == null) return -1;
      return b.winRate - a.winRate;
    });

  const dirMap = new Map<string, { call?: DirectionRow; put?: DirectionRow }>();
  for (const r of rawDirStats) {
    const resolved = r.wins + r.losses;
    const row: DirectionRow = {
      symbol:    r.symbol,
      direction: r.direction as 'CALL' | 'PUT',
      trades:    Number(r.trades),
      wins:      r.wins,
      losses:    r.losses,
      winRate:   resolved > 0 ? (r.wins / resolved) * 100 : null,
      totalPnl:  r.totalPnl != null ? parseFloat(r.totalPnl) : null,
      avgEr:     r.avgEr != null ? parseFloat(r.avgEr) : null,
      avgZ:      r.avgZ  != null ? parseFloat(String(r.avgZ)) : null,
    };
    const existing = dirMap.get(r.symbol) ?? {};
    if (r.direction === 'CALL') existing.call = row;
    else existing.put = row;
    dirMap.set(r.symbol, existing);
  }

  const dirStats: SymbolDirectionStats[] = Array.from(dirMap.entries())
    .map(([symbol, { call, put }]) => {
      const cfg = configMap.get(symbol);
      return {
        symbol,
        callTrades:  call?.trades   ?? 0,
        callWins:    call?.wins     ?? 0,
        callLosses:  call?.losses   ?? 0,
        callWinRate: call?.winRate  ?? null,
        callPnl:     call?.totalPnl ?? null,
        callAvgEr:   call?.avgEr    ?? null,
        callAvgZ:    call?.avgZ     ?? null,
        putTrades:   put?.trades    ?? 0,
        putWins:     put?.wins      ?? 0,
        putLosses:   put?.losses    ?? 0,
        putWinRate:  put?.winRate   ?? null,
        putPnl:      put?.totalPnl  ?? null,
        putAvgEr:    put?.avgEr     ?? null,
        putAvgZ:     put?.avgZ      ?? null,
        callEnabled: cfg?.callEnabled ?? true,
        putEnabled:  cfg?.putEnabled  ?? true,
        enabled:     cfg?.enabled     ?? true,
      };
    })
    // Sort: worst PUT win rate first — surfaces biggest losers at the top
    .sort((a, b) => {
      const aWr = a.putWinRate ?? 999;
      const bWr = b.putWinRate ?? 999;
      return aWr - bWr;
    });

  // ── Suppression map: symbol → { call, put, all } counts today ────────────
  const suppressionMap = new Map<string, { call: number; put: number; all: number }>();
  for (const s of rawSuppressions) {
    const existing = suppressionMap.get(s.symbol) ?? { call: 0, put: 0, all: 0 };
    if (s.direction === 'CALL') existing.call = s.count;
    else if (s.direction === 'PUT') existing.put = s.count;
    else if (s.direction === 'ALL') existing.all = s.count;
    suppressionMap.set(s.symbol, existing);
  }
  const totalCallSuppressed = rawSuppressions.filter(s => s.direction === 'CALL').reduce((sum, s) => sum + s.count, 0);
  const totalPutSuppressed  = rawSuppressions.filter(s => s.direction === 'PUT' ).reduce((sum, s) => sum + s.count, 0);
  const totalAllSuppressed  = rawSuppressions.filter(s => s.direction === 'ALL' ).reduce((sum, s) => sum + s.count, 0);
  const grandTotalSuppressed = totalCallSuppressed + totalPutSuppressed + totalAllSuppressed;

  // ── Today: trades taken per symbol × direction ────────────────────────────
  const takenTodayMap = new Map<string, { call: number; put: number }>();
  for (const t of rawTakenToday) {
    const existing = takenTodayMap.get(t.symbol) ?? { call: 0, put: 0 };
    if (t.direction === 'CALL') existing.call = Number(t.count);
    if (t.direction === 'PUT')  existing.put  = Number(t.count);
    takenTodayMap.set(t.symbol, existing);
  }

  // ── Windowed trend stats ───────────────────────────────────────────────────
  type WindowStat = {
    wr7: number | null; pnl7: number; trades7: number;
    wr7prev: number | null; // previous 7-day window (for trend direction)
    wr30: number | null; pnl30: number; trades30: number;
    wr90: number | null; pnl90: number; trades90: number;
    trend: 'IMPROVING' | 'DECLINING' | 'STABLE' | 'INSUFFICIENT';
  };
  const trendMap = new Map<string, WindowStat>();
  for (const r of rawWindowStats) {
    const wr7     = r.r7   > 0 ? (r.w7   / r.r7)   * 100 : null;
    const wr7prev = r.pr7  > 0 ? (r.pw7  / r.pr7)  * 100 : null;
    const wr30    = r.r30  > 0 ? (r.w30  / r.r30)  * 100 : null;
    const wr90    = r.r90  > 0 ? (r.w90  / r.r90)  * 100 : null;
    let trend: WindowStat['trend'] = 'INSUFFICIENT';
    if (wr7 != null && wr7prev != null && r.r7 >= 5 && r.pr7 >= 5) {
      const delta = wr7 - wr7prev;
      trend = delta > 3 ? 'IMPROVING' : delta < -3 ? 'DECLINING' : 'STABLE';
    }
    trendMap.set(r.symbol, {
      wr7, pnl7: r.p7, trades7: r.r7,
      wr7prev,
      wr30, pnl30: r.p30, trades30: r.r30,
      wr90, pnl90: r.p90, trades90: r.r90,
      trend,
    });
  }

  // ── Sparkline data: symbol → weekly WR points ────────────────────────────
  const sparklineMap = new Map<string, Array<{ week: string; wr: number | null; trades: number }>>();
  for (const r of rawSparkline) {
    const arr = sparklineMap.get(r.symbol) ?? [];
    arr.push({ week: r.week, wr: r.total > 0 ? (r.wins / r.total) * 100 : null, trades: Number(r.trades) });
    sparklineMap.set(r.symbol, arr);
  }

  // ── Per-direction windowed trend stats (CALL vs PUT × 7d/30d/90d) ─────────
  type DirWindowStat = {
    wr7: number | null; pnl7: number; trades7: number;
    wr30: number | null; pnl30: number; trades30: number;
    wr90: number | null; pnl90: number; trades90: number;
  };
  const emptyDWS = (): DirWindowStat => ({ wr7: null, pnl7: 0, trades7: 0, wr30: null, pnl30: 0, trades30: 0, wr90: null, pnl90: 0, trades90: 0 });
  const dirTrendMap = new Map<string, { call: DirWindowStat; put: DirWindowStat }>();
  for (const r of rawDirWindowStats) {
    const entry = dirTrendMap.get(r.symbol) ?? { call: emptyDWS(), put: emptyDWS() };
    const dws: DirWindowStat = {
      wr7:     r.r7  > 0 ? (r.w7  / r.r7)  * 100 : null,
      pnl7:    r.p7,
      trades7: r.r7,
      wr30:    r.r30 > 0 ? (r.w30 / r.r30) * 100 : null,
      pnl30:   r.p30,
      trades30:r.r30,
      wr90:    r.r90 > 0 ? (r.w90 / r.r90) * 100 : null,
      pnl90:   r.p90,
      trades90:r.r90,
    };
    if (r.direction === 'CALL') entry.call = dws;
    else entry.put = dws;
    dirTrendMap.set(r.symbol, entry);
  }

  // ── Summary stats ─────────────────────────────────────────────────────────
  const totalTrades  = stats.reduce((s, r) => s + r.trades,           0);
  const totalWins    = stats.reduce((s, r) => s + r.wins,             0);
  const totalLosses  = stats.reduce((s, r) => s + r.losses,           0);
  const totalResolved = totalWins + totalLosses;
  const overallWinRate = totalResolved > 0 ? (totalWins / totalResolved) * 100 : null;
  const totalPnl     = stats.reduce((s, r) => s + (r.totalPnl ?? 0), 0);
  const disabledCount = stats.filter((r) => !r.enabled).length;

  const allCallWr = (() => {
    const rows = rawDirStats.filter(r => r.direction === 'CALL');
    const w = rows.reduce((s, r) => s + r.wins, 0);
    const t = rows.reduce((s, r) => s + r.wins + r.losses, 0);
    return t > 0 ? (w / t) * 100 : null;
  })();
  const allPutWr = (() => {
    const rows = rawDirStats.filter(r => r.direction === 'PUT');
    const w = rows.reduce((s, r) => s + r.wins, 0);
    const t = rows.reduce((s, r) => s + r.wins + r.losses, 0);
    return t > 0 ? (w / t) * 100 : null;
  })();

  const callPnlTotal = dirStats.reduce((s, r) => s + (r.callPnl ?? 0), 0);
  const putPnlTotal  = dirStats.reduce((s, r) => s + (r.putPnl  ?? 0), 0);

  // High-confidence disable candidates — passed to the Apply button client component
  const hcCandidates: HighConfidenceCandidate[] = [];
  for (const r of dirStats) {
    if (isHighConfidenceDisable(r.callTrades, r.callWinRate) && r.callEnabled)
      hcCandidates.push({ symbol: r.symbol, direction: 'CALL', trades: r.callTrades, winRate: r.callWinRate! });
    if (isHighConfidenceDisable(r.putTrades,  r.putWinRate)  && r.putEnabled)
      hcCandidates.push({ symbol: r.symbol, direction: 'PUT',  trades: r.putTrades,  winRate: r.putWinRate!  });
  }

  const recDisableCount = dirStats.filter(r =>
    getRecommendation(r.callTrades, r.callWinRate) === 'DISABLE' ||
    getRecommendation(r.putTrades,  r.putWinRate)  === 'DISABLE'
  ).length;

  // ── AI Auto-Tune data (serialisable subset of dirStats for client component) ─
  const aiTuneSymbols: SymbolTuneInput[] = dirStats.map((r) => ({
    symbol:       r.symbol,
    displayName:  getSymbolDisplayName(r.symbol),
    callEnabled:  r.callEnabled,
    putEnabled:   r.putEnabled,
    callTrades:   r.callTrades,
    callWinRate:  r.callWinRate,
    callPnl:      r.callPnl,
    putTrades:    r.putTrades,
    putWinRate:   r.putWinRate,
    putPnl:       r.putPnl,
  }));

  // ── Recommendations ─────────────────────────────────────────────────────────
  const recs = computeRecommendations(dirStats, trendMap, BREAKEVEN_PCT);
  const disableRecs: DisableRec[] = recs
    .filter(r => r.action === 'DISABLE' && r.confidence != null && r.currentlyEnabled)
    .map(r => ({
      symbol:     r.symbol,
      direction:  r.direction,
      wr:         r.wr!,
      trades:     r.trades,
      pnl:        r.pnl,
      confidence: r.confidence as 'HIGH' | 'MEDIUM' | 'LOW',
      reason:     r.reason,
    }));

  const recCounts = {
    disable:      recs.filter(r => r.action === 'DISABLE').length,
    watch:        recs.filter(r => r.action === 'WATCH').length,
    keep:         recs.filter(r => r.action === 'KEEP').length,
    insufficient: recs.filter(r => r.action === 'INSUFFICIENT').length,
  };

  const viewHref = (v: ViewType) => `/admin/symbols?view=${v}&tab=${activeTab}`;
  const tabHref  = (t: string)   => `/admin/symbols?view=${view}&tab=${t}`;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-[#0a0a0f] text-gray-900 dark:text-zinc-100 p-4 sm:p-6 space-y-5">

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-lg sm:text-xl font-bold tracking-tight text-gray-900 dark:text-white">📊 Symbol Performance</h1>
          <p className="text-xs text-gray-500 dark:text-zinc-500 mt-0.5">Per-symbol win rate, direction breakdown, auto-recommendations, and kill switches</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {recDisableCount > 0 && (
            <span className="text-[10px] bg-rose-500/15 text-rose-500 dark:text-rose-400 border border-rose-500/30 px-2.5 py-1 rounded-full font-bold animate-pulse">
              🔴 {recDisableCount} direction{recDisableCount > 1 ? 's' : ''} flagged DISABLE
            </span>
          )}
          <span className="text-[10px] bg-rose-500/20 text-rose-500 dark:text-rose-400 border border-rose-500/30 px-2.5 py-1 rounded-full font-mono uppercase tracking-wider">ADMIN ONLY</span>
          <AutoRefresh intervalSeconds={60} />
          <form action={logoutAction}>
            <button type="submit" className="text-[11px] text-gray-500 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300 border border-gray-200 dark:border-zinc-800 px-3 py-1.5 rounded-lg transition-colors bg-white dark:bg-transparent">
              Sign out
            </button>
          </form>
        </div>
      </div>

      <AdminNav />

      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <div className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 p-3 sm:p-4 space-y-1">
          <p className="text-[10px] text-gray-500 dark:text-zinc-500 uppercase tracking-widest font-semibold">Overall WR</p>
          <p className={`text-xl sm:text-2xl font-bold tabular-nums ${!overallWinRate ? 'text-gray-400' : overallWinRate >= 55 ? 'text-emerald-500' : overallWinRate >= 50 ? 'text-amber-500' : 'text-rose-500'}`}>
            {overallWinRate != null ? `${overallWinRate.toFixed(1)}%` : '—'}
          </p>
          <p className="text-[10px] text-gray-400 dark:text-zinc-500">{totalResolved.toLocaleString()} resolved · {totalTrades.toLocaleString()} total</p>
        </div>

        <div className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 p-3 sm:p-4 space-y-1">
          <p className="text-[10px] text-gray-500 dark:text-zinc-500 uppercase tracking-widest font-semibold">CALL vs PUT</p>
          <div className="flex items-baseline gap-2">
            <span className={`text-base font-bold tabular-nums ${allCallWr != null && allCallWr >= 54 ? 'text-emerald-500' : 'text-amber-500'}`}>
              📈 {allCallWr != null ? `${allCallWr.toFixed(1)}%` : '—'}
            </span>
            <span className="text-gray-300 dark:text-zinc-700 text-xs">/</span>
            <span className={`text-base font-bold tabular-nums ${allPutWr != null && allPutWr < 45 ? 'text-rose-500' : 'text-amber-500'}`}>
              📉 {allPutWr != null ? `${allPutWr.toFixed(1)}%` : '—'}
            </span>
          </div>
          {allCallWr != null && allPutWr != null && (
            <p className="text-[10px] text-amber-500 dark:text-amber-400 font-semibold">{Math.abs(allCallWr - allPutWr).toFixed(1)}pp asymmetry</p>
          )}
        </div>

        <div className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 p-3 sm:p-4 space-y-1">
          <p className="text-[10px] text-gray-500 dark:text-zinc-500 uppercase tracking-widest font-semibold">Direction PnL</p>
          <div className="space-y-0.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-gray-400 dark:text-zinc-500">CALL</span>
              <PnlCell val={callPnlTotal} compact />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-gray-400 dark:text-zinc-500">PUT</span>
              <PnlCell val={putPnlTotal} compact />
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 p-3 sm:p-4 space-y-1">
          <p className="text-[10px] text-gray-500 dark:text-zinc-500 uppercase tracking-widest font-semibold">Symbols</p>
          <p className="text-xl sm:text-2xl font-bold tabular-nums text-gray-800 dark:text-zinc-100">{stats.length}</p>
          <p className="text-[10px] text-gray-400 dark:text-zinc-500">
            {disabledCount > 0 ? `${disabledCount} fully disabled` : 'all active'}
            {recDisableCount > 0 ? ` · ${recDisableCount} ⛔ flagged` : ''}
          </p>
        </div>

        <div className={`rounded-xl border p-3 sm:p-4 space-y-1 ${grandTotalSuppressed > 0 ? 'border-violet-500/30 bg-violet-500/5 dark:bg-violet-500/8' : 'border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60'}`}>
          <p className="text-[10px] text-gray-500 dark:text-zinc-500 uppercase tracking-widest font-semibold">🛡 Filter Shield</p>
          <p className={`text-xl sm:text-2xl font-bold tabular-nums ${grandTotalSuppressed > 0 ? 'text-violet-600 dark:text-violet-400' : 'text-gray-400'}`}>
            {grandTotalSuppressed > 0 ? grandTotalSuppressed.toLocaleString() : '0'}
          </p>
          <div className="text-[10px] text-gray-400 dark:text-zinc-500 space-y-px">
            {grandTotalSuppressed > 0 ? (
              <>
                <p><span className="text-emerald-500 font-medium">📈 CALL</span> suppressed: {totalCallSuppressed}</p>
                <p><span className="text-rose-500 font-medium">📉 PUT</span> suppressed: {totalPutSuppressed}</p>
                {totalAllSuppressed > 0 && <p><span className="text-gray-500">🚫 ALL</span> suppressed: {totalAllSuppressed}</p>}
              </>
            ) : (
              <p>no signals blocked today</p>
            )}
          </div>
        </div>
      </div>

      {/* View + Tab Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center gap-1 bg-gray-100 dark:bg-zinc-900/80 border border-gray-200 dark:border-zinc-800 rounded-xl p-1 w-fit">
          {(['ALL', 'LIVE', 'GHOST'] as ViewType[]).map((v) => (
            <Link key={v} href={viewHref(v)} className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all whitespace-nowrap ${view === v ? 'bg-violet-600 text-white shadow-sm' : 'text-gray-500 dark:text-zinc-400 hover:text-gray-800 dark:hover:text-zinc-200 hover:bg-white dark:hover:bg-zinc-800'}`}>
              {v === 'ALL' ? '🔀 All' : v === 'LIVE' ? '💸 Live' : '👻 Ghost'}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-1 bg-gray-100 dark:bg-zinc-900/80 border border-gray-200 dark:border-zinc-800 rounded-xl p-1 w-fit">
          <Link href={tabHref('overview')} className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all whitespace-nowrap ${activeTab === 'overview' ? 'bg-white dark:bg-zinc-800 text-gray-900 dark:text-zinc-100 shadow-sm' : 'text-gray-500 dark:text-zinc-400 hover:text-gray-800 dark:hover:text-zinc-200'}`}>
            Overview
          </Link>
          <Link href={tabHref('direction')} className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all whitespace-nowrap ${activeTab === 'direction' ? 'bg-white dark:bg-zinc-800 text-gray-900 dark:text-zinc-100 shadow-sm' : 'text-gray-500 dark:text-zinc-400 hover:text-gray-800 dark:hover:text-zinc-200'}`}>
            CALL vs PUT {recDisableCount > 0 && <span className="ml-1 text-rose-400">●</span>}
          </Link>
          <Link href={tabHref('trends')} className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all whitespace-nowrap ${activeTab === 'trends' ? 'bg-white dark:bg-zinc-800 text-gray-900 dark:text-zinc-100 shadow-sm' : 'text-gray-500 dark:text-zinc-400 hover:text-gray-800 dark:hover:text-zinc-200'}`}>
            📈 Trends
          </Link>
          <Link href={tabHref('recs')} className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all whitespace-nowrap ${activeTab === 'recs' ? 'bg-white dark:bg-zinc-800 text-gray-900 dark:text-zinc-100 shadow-sm' : 'text-gray-500 dark:text-zinc-400 hover:text-gray-800 dark:hover:text-zinc-200'}`}>
            🤖 Recs
            {recCounts.disable > 0 && <span className="ml-1 text-rose-400">●</span>}
          </Link>
        </div>
        <Link
          href="/api/export/direction-stats"
          target="_blank"
          className="text-[11px] text-violet-600 dark:text-violet-400 border border-violet-500/30 bg-violet-500/10 hover:bg-violet-500/20 px-3 py-1.5 rounded-lg transition-colors font-semibold whitespace-nowrap"
        >
          ⬇ Export ML Dataset
        </Link>
        {activeTab === 'direction' && (
          <ApplyRecommendations candidates={hcCandidates} />
        )}
      </div>

      {/* OVERVIEW TAB */}
      {activeTab === 'overview' && (
        <>
          <div className="flex items-center gap-4 flex-wrap text-[10px] text-gray-400 dark:text-zinc-600">
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" /> ≥58%</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-blue-500 inline-block" /> 52–58%</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-amber-500 inline-block" /> 48–52%</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-rose-500 inline-block" /> &lt;48%</span>
            <span className="ml-2 text-gray-300 dark:text-zinc-700">|</span>
            <span>⚠️ = &lt;{WEAK_WR}% WR with {WARN_TRADES}+ trades</span>
            <span className="ml-2 text-gray-300 dark:text-zinc-700">|</span>
            <span>breakeven ≈ {BREAKEVEN_PCT}% at 85% payout</span>
          </div>
          {stats.length === 0 ? (
            <div className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 px-6 py-12 text-center text-sm text-gray-400">No resolved trades yet.</div>
          ) : (
            <div className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-xs min-w-[700px]">
                  <thead>
                    <tr className="border-b border-gray-100 dark:border-zinc-800 text-gray-400 dark:text-zinc-500 text-[10px] uppercase tracking-widest">
                      <th className="px-4 py-2.5 text-left">Symbol</th>
                      <th className="px-4 py-2.5 text-right">Trades</th>
                      <th className="px-4 py-2.5 text-right">Win Rate</th>
                      <th className="px-4 py-2.5 text-right">W / L</th>
                      <th className="px-4 py-2.5 text-right">Avg ER</th>
                      <th className="px-4 py-2.5 text-right">Avg |Z|</th>
                      <th className="px-4 py-2.5 text-right">Total PnL</th>
                      <th className="px-4 py-2.5 text-center">Kill Switch</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.map((row) => {
                      const resolved   = row.wins + row.losses;
                      const isFlagged  = resolved >= WARN_TRADES && row.winRate != null && row.winRate < WEAK_WR;
                      return (
                        <tr key={row.symbol} className={`border-b border-gray-50 dark:border-zinc-800/50 hover:bg-gray-50 dark:hover:bg-zinc-800/20 transition-colors ${!row.enabled ? 'opacity-50' : ''}`}>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              {isFlagged && <span title="Statistically weak — consider disabling" className="text-[10px]">⚠️</span>}
                              <div>
                                <p className="font-semibold text-gray-900 dark:text-zinc-100 leading-tight">{getSymbolDisplayName(row.symbol)}</p>
                                <p className="text-[10px] text-gray-400 dark:text-zinc-600 font-mono leading-tight">{row.symbol}</p>
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums text-gray-700 dark:text-zinc-300">{row.trades.toLocaleString()}</td>
                          <td className="px-4 py-3 text-right"><WrBadge rate={row.winRate} /></td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums text-[10px]">
                            <span className="text-emerald-500">{row.wins}</span>
                            <span className="text-gray-300 dark:text-zinc-700 mx-0.5">/</span>
                            <span className="text-rose-500">{row.losses}</span>
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums text-gray-500 dark:text-zinc-500">
                            {row.avgEr != null ? row.avgEr.toFixed(4) : '—'}
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums text-gray-500 dark:text-zinc-500">
                            {row.avgZ != null ? row.avgZ.toFixed(2) : '—'}
                          </td>
                          <td className="px-4 py-3 text-right"><PnlCell val={row.totalPnl} /></td>
                          <td className="px-4 py-3 text-center">
                            <form action={toggleSymbolAction.bind(null, row.symbol, row.enabled)}>
                              <button type="submit" title={row.enabled ? 'Kill all trades for this symbol' : 'Re-enable this symbol'} className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${row.enabled ? 'bg-violet-600' : 'bg-gray-300 dark:bg-zinc-700'}`}>
                                <span className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-lg transform transition-transform ${row.enabled ? 'translate-x-4' : 'translate-x-0'}`} />
                              </button>
                            </form>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* CALL vs PUT TAB */}
      {activeTab === 'direction' && (
        <>
          {/* ── AI Auto-Tune ──────────────────────────────────────────────── */}
          <AiTuneClient
            symbols={aiTuneSymbols}
            breakevenPct={BREAKEVEN_PCT}
            minTrades={MIN_DISPLAY_TRADES}
          />

          {/* Asymmetry banner */}
          {allCallWr != null && allPutWr != null && (
            <div className={`rounded-xl border px-4 py-3 text-xs flex flex-col sm:flex-row sm:items-start gap-2 ${
              Math.abs(allCallWr - allPutWr) > 15
                ? 'bg-rose-500/10 border-rose-500/30 text-rose-700 dark:text-rose-400'
                : Math.abs(allCallWr - allPutWr) > 8
                  ? 'bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-400'
                  : 'bg-blue-500/10 border-blue-500/30 text-blue-700 dark:text-blue-400'
            }`}>
              <span className="text-base shrink-0">
                {Math.abs(allCallWr - allPutWr) > 15 ? '🚨' : Math.abs(allCallWr - allPutWr) > 8 ? '⚠️' : 'ℹ️'}
              </span>
              <div className="space-y-1">
                <p className="font-semibold">
                  CALL {allCallWr.toFixed(1)}% vs PUT {allPutWr.toFixed(1)}% — {Math.abs(allCallWr - allPutWr).toFixed(1)}pp asymmetry
                </p>
                <p className="opacity-80">
                  {Math.abs(allCallWr - allPutWr) > 15
                    ? `Severe directional bias. The primary source of losses is PUT direction across all symbols. Breakeven requires ${BREAKEVEN_PCT}% — PUT is ${(BREAKEVEN_PCT - allPutWr).toFixed(1)}pp below that threshold. Disabling poor PUT directions is higher-impact than adjusting ER thresholds.`
                    : Math.abs(allCallWr - allPutWr) > 8
                      ? `Meaningful asymmetry. Review individual symbols in the table below — some PUT directions may be statistically weak.`
                      : `CALL/PUT balance is reasonable. No systemic directional bias detected.`
                  }
                </p>
              </div>
            </div>
          )}

          {/* ── Directional Edge Monitor ─────────────────────────────────── */}
          {(() => {
            const edgeRows = dirStats
              .filter(r => r.callWinRate != null || r.putWinRate != null)
              .map(r => ({
                symbol:   r.symbol,
                callWr:   r.callWinRate,
                putWr:    r.putWinRate,
                callT:    r.callTrades,
                putT:     r.putTrades,
                edge:     (r.callWinRate ?? 0) - (r.putWinRate ?? 0),
              }))
              .sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));
            if (edgeRows.length === 0) return null;
            return (
              <div className="bg-white dark:bg-zinc-900 border border-gray-100 dark:border-zinc-800 rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-100 dark:border-zinc-800 flex items-center gap-2">
                  <span className="text-[11px] font-bold text-gray-700 dark:text-zinc-300 uppercase tracking-wide">⚡ Directional Edge Monitor</span>
                  <span className="text-[10px] text-gray-400 dark:text-zinc-600 ml-1">— sorted by strongest directional advantage</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-gray-100 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-900/60">
                        <th className="px-4 py-2 text-left text-[10px] font-semibold text-gray-500 dark:text-zinc-500 uppercase tracking-wide">Symbol</th>
                        <th className="px-4 py-2 text-center text-[10px] font-semibold text-emerald-600 dark:text-emerald-500 uppercase tracking-wide">📈 CALL WR</th>
                        <th className="px-4 py-2 text-center text-[10px] font-semibold text-rose-600 dark:text-rose-500 uppercase tracking-wide">📉 PUT WR</th>
                        <th className="px-4 py-2 text-center text-[10px] font-semibold text-violet-600 dark:text-violet-400 uppercase tracking-wide">Edge</th>
                        <th className="px-4 py-2 text-center text-[10px] font-semibold text-gray-500 dark:text-zinc-500 uppercase tracking-wide">Verdict</th>
                      </tr>
                    </thead>
                    <tbody>
                      {edgeRows.map(row => {
                        const edgeAbs = Math.abs(row.edge);
                        const favorsCall = row.edge >= 0;
                        const edgeColor = edgeAbs >= 20 ? (favorsCall ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400')
                          : edgeAbs >= 10 ? (favorsCall ? 'text-emerald-500 dark:text-emerald-500' : 'text-rose-500 dark:text-rose-500')
                          : 'text-gray-500 dark:text-zinc-400';
                        const verdict = edgeAbs >= 20
                          ? (favorsCall ? '🟢 Strong CALL advantage' : '🔴 Strong PUT disadvantage')
                          : edgeAbs >= 10
                            ? (favorsCall ? '🟡 Moderate CALL edge' : '🟡 Moderate PUT weakness')
                            : '⚪ Balanced';
                        return (
                          <tr key={row.symbol} className="border-b border-gray-50 dark:border-zinc-800/50 hover:bg-gray-50 dark:hover:bg-zinc-800/30 transition-colors">
                            <td className="px-4 py-2.5">
                              <span className="text-[11px] font-semibold text-gray-800 dark:text-zinc-200">{getSymbolDisplayName(row.symbol)}</span>
                              <span className="ml-1.5 text-[9px] text-gray-400 dark:text-zinc-600 font-mono">{row.symbol}</span>
                            </td>
                            <td className="px-4 py-2.5 text-center">
                              <span className="font-mono tabular-nums font-bold text-emerald-600 dark:text-emerald-400">
                                {row.callWr != null ? row.callWr.toFixed(1) + '%' : '—'}
                              </span>
                              {row.callT > 0 && <span className="ml-1 text-[9px] text-gray-400 dark:text-zinc-600">({row.callT})</span>}
                            </td>
                            <td className="px-4 py-2.5 text-center">
                              <span className="font-mono tabular-nums font-bold text-rose-600 dark:text-rose-400">
                                {row.putWr != null ? row.putWr.toFixed(1) + '%' : '—'}
                              </span>
                              {row.putT > 0 && <span className="ml-1 text-[9px] text-gray-400 dark:text-zinc-600">({row.putT})</span>}
                            </td>
                            <td className="px-4 py-2.5 text-center">
                              <span className={`font-mono tabular-nums font-bold text-[13px] ${edgeColor}`}>
                                {row.edge >= 0 ? '+' : ''}{row.edge.toFixed(1)}pp
                              </span>
                            </td>
                            <td className="px-4 py-2.5 text-center text-[10px] text-gray-600 dark:text-zinc-400">{verdict}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="text-[9px] text-gray-400 dark:text-zinc-600 px-4 py-2 border-t border-gray-100 dark:border-zinc-800">
                  Edge = CALL WR − PUT WR. Positive edge = CALL direction has structural advantage. Trade counts in parentheses.
                </p>
              </div>
            );
          })()}

          {/* Recommendation legend */}
          <div className="flex items-center gap-3 flex-wrap text-[10px]">
            <span className="text-gray-400 dark:text-zinc-600 font-semibold">Rec. Center:</span>
            <span className="px-1.5 py-0.5 rounded border text-[9px] font-bold bg-emerald-500/15 border-emerald-500/30 text-emerald-700 dark:text-emerald-400">🟢 KEEP</span>
            <span className="px-1.5 py-0.5 rounded border text-[9px] font-bold bg-amber-500/15 border-amber-500/30 text-amber-700 dark:text-amber-400">🟡 WATCH</span>
            <span className="px-1.5 py-0.5 rounded border text-[9px] font-bold bg-rose-500/20 border-rose-500/40 text-rose-700 dark:text-rose-400">🔴 DISABLE</span>
            <span className="text-gray-300 dark:text-zinc-700 ml-1">|</span>
            <span className="text-gray-300 dark:text-zinc-700 ml-1">|</span>
            <span className="text-gray-400 dark:text-zinc-600">&lt;{MIN_DISPLAY_TRADES} trades → WATCH · &lt;{WEAK_WR}% WR → DISABLE · {WATCH_WR_MAX}%+ → KEEP · sorted by worst PUT WR</span>
            <span className="text-gray-300 dark:text-zinc-700 ml-1">|</span>
            <span className="text-violet-500 dark:text-violet-400 font-medium">🛡 Apply button requires {HC_MIN_TRADES}+ trades</span>
          </div>

          {/* Taken vs Suppressed Today — per-session analytics */}
          {(rawTakenToday.length > 0 || rawSuppressions.length > 0) && (
            <div className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 overflow-hidden">
              <div className="px-4 py-2.5 border-b border-gray-50 dark:border-zinc-800/60">
                <p className="text-[10px] font-semibold text-gray-500 dark:text-zinc-400 uppercase tracking-widest">
                  📊 Trades Taken vs Suppressed — Today
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs min-w-[600px]">
                  <thead>
                    <tr className="border-b border-gray-50 dark:border-zinc-800/60 text-gray-400 dark:text-zinc-500 text-[10px] uppercase tracking-widest">
                      <th className="px-4 py-2 text-left">Symbol</th>
                      <th className="px-4 py-2 text-right">📈 CALL Taken</th>
                      <th className="px-4 py-2 text-right">📈 CALL Suppressed</th>
                      <th className="px-4 py-2 text-right">📈 Filter Rate</th>
                      <th className="px-1 py-2 text-center text-gray-200 dark:text-zinc-800">│</th>
                      <th className="px-4 py-2 text-right">📉 PUT Taken</th>
                      <th className="px-4 py-2 text-right">📉 PUT Suppressed</th>
                      <th className="px-4 py-2 text-right">📉 Filter Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from(new Set([
                      ...rawTakenToday.map(r => r.symbol),
                      ...rawSuppressions.map(r => r.symbol),
                    ])).sort().map(sym => {
                      const taken = takenTodayMap.get(sym) ?? { call: 0, put: 0 };
                      const sup   = suppressionMap.get(sym)  ?? { call: 0, put: 0, all: 0 };
                      const callTotal = taken.call + sup.call;
                      const putTotal  = taken.put  + sup.put;
                      const callFilterRate = callTotal > 0 ? (sup.call / callTotal) * 100 : null;
                      const putFilterRate  = putTotal  > 0 ? (sup.put  / putTotal)  * 100 : null;
                      if (callTotal === 0 && putTotal === 0 && sup.all === 0) return null;
                      return (
                        <tr key={sym} className="border-b border-gray-50 dark:border-zinc-800/50 hover:bg-gray-50 dark:hover:bg-zinc-800/20">
                          <td className="px-4 py-2.5">
                            <p className="font-semibold text-gray-900 dark:text-zinc-100 text-[11px] leading-tight">{getSymbolDisplayName(sym)}</p>
                            <p className="text-[9px] text-gray-400 dark:text-zinc-600 font-mono">{sym}</p>
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono tabular-nums text-emerald-600 dark:text-emerald-400 font-semibold">{taken.call > 0 ? taken.call : <span className="text-gray-300 dark:text-zinc-700">—</span>}</td>
                          <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                            <span className={`font-bold ${sup.call >= 20 ? 'text-rose-500' : sup.call >= 5 ? 'text-amber-500' : sup.call > 0 ? 'text-gray-600 dark:text-zinc-400' : 'text-gray-300 dark:text-zinc-700'}`}>
                              {sup.call > 0 ? sup.call : '—'}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono tabular-nums text-[10px]">
                            {callFilterRate != null
                              ? <span className={callFilterRate >= 50 ? 'text-rose-500 font-bold' : callFilterRate >= 20 ? 'text-amber-500' : 'text-gray-400 dark:text-zinc-500'}>{callFilterRate.toFixed(0)}%</span>
                              : <span className="text-gray-300 dark:text-zinc-700">—</span>}
                          </td>
                          <td className="px-0 py-2.5 text-center text-gray-200 dark:text-zinc-800 text-lg select-none">│</td>
                          <td className="px-4 py-2.5 text-right font-mono tabular-nums text-emerald-600 dark:text-emerald-400 font-semibold">{taken.put > 0 ? taken.put : <span className="text-gray-300 dark:text-zinc-700">—</span>}</td>
                          <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                            <span className={`font-bold ${sup.put >= 20 ? 'text-rose-500' : sup.put >= 5 ? 'text-amber-500' : sup.put > 0 ? 'text-gray-600 dark:text-zinc-400' : 'text-gray-300 dark:text-zinc-700'}`}>
                              {sup.put > 0 ? sup.put : '—'}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono tabular-nums text-[10px]">
                            {putFilterRate != null
                              ? <span className={putFilterRate >= 50 ? 'text-rose-500 font-bold' : putFilterRate >= 20 ? 'text-amber-500' : 'text-gray-400 dark:text-zinc-500'}>{putFilterRate.toFixed(0)}%</span>
                              : <span className="text-gray-300 dark:text-zinc-700">—</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="px-4 py-2 border-t border-gray-50 dark:border-zinc-800/60 text-[10px] text-gray-400 dark:text-zinc-600">
                Filter Rate = suppressed ÷ (taken + suppressed) today · high filter rate on a good direction may indicate the ER threshold is too tight
              </div>
            </div>
          )}

          {dirStats.length === 0 ? (
            <div className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 px-6 py-12 text-center text-sm text-gray-400">No resolved trades yet.</div>
          ) : (
            <div className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-xs min-w-[1020px]">
                  <thead>
                    <tr className="border-b border-gray-100 dark:border-zinc-800 text-gray-400 dark:text-zinc-500 text-[10px] uppercase tracking-widest">
                      <th className="px-4 py-2.5 text-left">Symbol</th>
                      <th className="px-4 py-2.5 text-right">📈 CALL WR</th>
                      <th className="px-4 py-2.5 text-right">W/L</th>
                      <th className="px-4 py-2.5 text-right">CALL PnL</th>
                      <th className="px-4 py-2.5 text-left">CALL Rec.</th>
                      <th className="px-1 py-2.5 text-center text-gray-200 dark:text-zinc-800">│</th>
                      <th className="px-4 py-2.5 text-right">📉 PUT WR</th>
                      <th className="px-4 py-2.5 text-right">W/L</th>
                      <th className="px-4 py-2.5 text-right">PUT PnL</th>
                      <th className="px-4 py-2.5 text-left">PUT Rec.</th>
                      <th className="px-1 py-2.5 text-center text-gray-200 dark:text-zinc-800">│</th>
                      <th className="px-4 py-2.5 text-center" title="Signals blocked today by direction filter">🛡 Suppressed Today</th>
                      <th className="px-4 py-2.5 text-center">Controls</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dirStats.map((row) => {
                      const callRec = getRecommendation(row.callTrades, row.callWinRate);
                      const putRec  = getRecommendation(row.putTrades,  row.putWinRate);
                      const rowHighlight =
                        putRec === 'DISABLE' ? 'bg-rose-500/5 dark:bg-rose-500/5' :
                        callRec === 'DISABLE' ? 'bg-rose-500/5 dark:bg-rose-500/5' : '';
                      return (
                        <tr key={row.symbol} className={`border-b border-gray-50 dark:border-zinc-800/50 hover:bg-gray-50 dark:hover:bg-zinc-800/20 transition-colors ${!row.enabled ? 'opacity-40' : ''} ${rowHighlight}`}>
                          <td className="px-4 py-3">
                            <div>
                              <p className="font-semibold text-gray-900 dark:text-zinc-100 leading-tight">{getSymbolDisplayName(row.symbol)}</p>
                              <p className="text-[10px] text-gray-400 dark:text-zinc-600 font-mono leading-tight">{row.symbol}</p>
                            </div>
                          </td>

                          {/* ── CALL ── */}
                          <td className="px-4 py-3">
                            <div className="space-y-1">
                              <div className="flex items-center justify-end gap-1.5">
                                <WrBadge rate={row.callWinRate} size="sm" />
                              </div>
                              <div className="flex items-center gap-1">
                                <WrBar wr={row.callWinRate} />
                              </div>
                              <div className="flex justify-end">
                                <WeakDirectionBadge trades={row.callTrades} wr={row.callWinRate} />
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums text-[11px]">
                            {row.callTrades > 0
                              ? <><span className="text-emerald-500">{row.callWins}</span><span className="text-gray-400 dark:text-zinc-700 mx-0.5">/</span><span className="text-rose-500">{row.callLosses}</span></>
                              : <span className="text-gray-400">—</span>}
                          </td>
                          <td className="px-4 py-3 text-right"><PnlCell val={row.callPnl} compact /></td>
                          <td className="px-4 py-3">
                            <RecommendationBadge trades={row.callTrades} wr={row.callWinRate} />
                          </td>

                          {/* divider */}
                          <td className="px-0 py-3 text-center text-gray-200 dark:text-zinc-800 text-lg select-none">│</td>

                          {/* ── PUT ── */}
                          <td className="px-4 py-3">
                            <div className="space-y-1">
                              <div className="flex items-center justify-end gap-1.5">
                                <WrBadge rate={row.putWinRate} size="sm" />
                              </div>
                              <div className="flex items-center gap-1">
                                <WrBar wr={row.putWinRate} />
                              </div>
                              <div className="flex justify-end">
                                <WeakDirectionBadge trades={row.putTrades} wr={row.putWinRate} />
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums text-[11px]">
                            {row.putTrades > 0
                              ? <><span className="text-emerald-500">{row.putWins}</span><span className="text-gray-400 dark:text-zinc-700 mx-0.5">/</span><span className="text-rose-500">{row.putLosses}</span></>
                              : <span className="text-gray-400">—</span>}
                          </td>
                          <td className="px-4 py-3 text-right"><PnlCell val={row.putPnl} compact /></td>
                          <td className="px-4 py-3">
                            <RecommendationBadge trades={row.putTrades} wr={row.putWinRate} />
                          </td>

                          {/* Suppression divider */}
                          <td className="px-0 py-3 text-center text-gray-200 dark:text-zinc-800 text-lg select-none">│</td>

                          {/* Suppression counts today */}
                          <td className="px-4 py-3 text-center">
                            {(() => {
                              const sup = suppressionMap.get(row.symbol);
                              const callSup = sup?.call ?? 0;
                              const putSup  = sup?.put  ?? 0;
                              const allSup  = sup?.all  ?? 0;
                              const total   = callSup + putSup + allSup;
                              if (total === 0) return <span className="text-gray-300 dark:text-zinc-700 text-[10px]">—</span>;
                              return (
                                <div className="space-y-0.5 text-[10px] font-mono tabular-nums">
                                  {callSup > 0 && (
                                    <div className="flex items-center justify-center gap-1">
                                      <span className="text-emerald-400 dark:text-emerald-500">📈</span>
                                      <span className={`font-bold ${callSup >= 20 ? 'text-rose-500' : callSup >= 5 ? 'text-amber-500' : 'text-gray-600 dark:text-zinc-400'}`}>{callSup}</span>
                                    </div>
                                  )}
                                  {putSup > 0 && (
                                    <div className="flex items-center justify-center gap-1">
                                      <span className="text-rose-400 dark:text-rose-500">📉</span>
                                      <span className={`font-bold ${putSup >= 20 ? 'text-rose-500' : putSup >= 5 ? 'text-amber-500' : 'text-gray-600 dark:text-zinc-400'}`}>{putSup}</span>
                                    </div>
                                  )}
                                  {allSup > 0 && (
                                    <div className="flex items-center justify-center gap-1">
                                      <span className="text-gray-400">🚫</span>
                                      <span className="font-bold text-gray-500 dark:text-zinc-500">{allSup}</span>
                                    </div>
                                  )}
                                </div>
                              );
                            })()}
                          </td>

                          {/* Controls */}
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1.5 justify-center">
                              <DirectionToggle symbol={row.symbol} direction="CALL" enabled={row.callEnabled} />
                              <DirectionToggle symbol={row.symbol} direction="PUT"  enabled={row.putEnabled}  />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <p className="text-[10px] text-gray-400 dark:text-zinc-600 text-center">
            Kill switch takes effect within 60 s (next config refresh) · Symbol must also be ON in Overview tab · ⬇ Export ML Dataset for raw training data
          </p>
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* TRENDS TAB                                                          */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {activeTab === 'trends' && (
        <>
          {/* Header */}
          <div className="bg-white dark:bg-zinc-900 border border-gray-100 dark:border-zinc-800 rounded-xl px-5 py-4">
            <div className="flex flex-col sm:flex-row sm:items-start gap-3">
              <div className="flex-1">
                <h2 className="text-sm font-bold text-gray-800 dark:text-zinc-200 mb-1">📈 Historical Trend Analysis</h2>
                <p className="text-[11px] text-gray-500 dark:text-zinc-500 leading-relaxed">
                  Win rate and P&amp;L over 7 / 30 / 90-day windows, broken down by CALL vs PUT per symbol.
                  The sparkline shows weekly WR for the past 12 weeks — the <span className="text-amber-500 font-medium">amber dashed line</span> marks
                  the {BREAKEVEN_PCT}% breakeven threshold. Trend compares current vs previous 7-day window (±3pp).
                </p>
                <p className="text-[10px] text-blue-500 dark:text-blue-400 mt-1.5 font-medium bg-blue-500/8 border border-blue-500/20 rounded-lg px-2.5 py-1 inline-block">
                  ℹ️ If 7d / 30d / 90d WR appear identical, all recorded trades fall within the last 7 days — the numbers are correct and will diverge as older data accumulates.
                </p>
              </div>
              <div className="flex gap-3 text-[10px] flex-wrap shrink-0">
                <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-full bg-emerald-500"></span> ↑ IMPROVING</span>
                <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-full bg-rose-500"></span> ↓ DECLINING</span>
                <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-full bg-gray-400"></span> → STABLE</span>
              </div>
            </div>
          </div>

          {/* ── Confidence Score Panel ────────────────────────────────────────── */}
          {(() => {
            const disablePut  = dirStats.filter(r => r.putTrades  >= 50 && r.putWinRate  != null && r.putWinRate  < 45 && r.putPnl  != null && r.putPnl  < 0);
            const disableCall = dirStats.filter(r => r.callTrades >= 50 && r.callWinRate != null && r.callWinRate < 45 && r.callPnl != null && r.callPnl < 0);
            const keepCall    = dirStats.filter(r => r.callTrades >= 30 && r.callWinRate != null && r.callWinRate >= BREAKEVEN_PCT);
            const keepPut     = dirStats.filter(r => r.putTrades  >= 30 && r.putWinRate  != null && r.putWinRate  >= BREAKEVEN_PCT);
            return (
              <div className="bg-white dark:bg-zinc-900 border border-gray-100 dark:border-zinc-800 rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-100 dark:border-zinc-800 flex items-center gap-2">
                  <span className="text-[11px] font-bold text-gray-700 dark:text-zinc-300 uppercase tracking-wide">🎯 Confidence Score — Actionable Summary</span>
                  <span className="text-[10px] text-gray-400 dark:text-zinc-600">threshold: ≥50 trades + WR &lt;45% + negative P&amp;L = Disable</span>
                </div>
                <div className="grid sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-gray-100 dark:divide-zinc-800">
                  <div className="px-4 py-3 space-y-2">
                    <p className="text-[10px] font-bold text-rose-600 dark:text-rose-400 uppercase tracking-wide">🔴 Disable Recommended</p>
                    {disablePut.length === 0 && disableCall.length === 0 ? (
                      <p className="text-[10px] text-gray-400 dark:text-zinc-600">No directions meet criteria yet (≥50 trades, WR &lt;45%, negative P&amp;L)</p>
                    ) : (
                      <div className="space-y-1">
                        {[
                          ...disablePut.map(r => ({ symbol: r.symbol, dir: 'PUT' as const, wr: r.putWinRate, pnl: r.putPnl, trades: r.putTrades })),
                          ...disableCall.map(r => ({ symbol: r.symbol, dir: 'CALL' as const, wr: r.callWinRate, pnl: r.callPnl, trades: r.callTrades })),
                        ].sort((a, b) => (a.wr ?? 100) - (b.wr ?? 100)).map(r => (
                          <div key={`${r.symbol}:${r.dir}`} className="flex items-center justify-between gap-2 py-1 border-b border-gray-50 dark:border-zinc-800/50 last:border-0">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className={`text-[9px] font-bold shrink-0 ${r.dir === 'PUT' ? 'text-rose-500' : 'text-emerald-500'}`}>{r.dir === 'PUT' ? '📉' : '📈'} {r.dir}</span>
                              <span className="text-[10px] text-gray-700 dark:text-zinc-300 font-medium truncate">{getSymbolDisplayName(r.symbol)}</span>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <WrBadge rate={r.wr ?? null} size="sm" />
                              <PnlCell val={r.pnl ?? null} compact />
                              <span className="text-[9px] text-gray-400 dark:text-zinc-600 font-mono">{r.trades}t</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="px-4 py-3 space-y-2">
                    <p className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-wide">🟢 Keep — Profitable Directions</p>
                    {keepCall.length === 0 && keepPut.length === 0 ? (
                      <p className="text-[10px] text-gray-400 dark:text-zinc-600">No directions above {BREAKEVEN_PCT}% breakeven with ≥30 trades yet</p>
                    ) : (
                      <div className="space-y-1">
                        {[
                          ...keepCall.map(r => ({ symbol: r.symbol, dir: 'CALL' as const, wr: r.callWinRate, pnl: r.callPnl, trades: r.callTrades })),
                          ...keepPut.map(r => ({ symbol: r.symbol, dir: 'PUT' as const, wr: r.putWinRate, pnl: r.putPnl, trades: r.putTrades })),
                        ].sort((a, b) => (b.wr ?? 0) - (a.wr ?? 0)).map(r => (
                          <div key={`${r.symbol}:${r.dir}`} className="flex items-center justify-between gap-2 py-1 border-b border-gray-50 dark:border-zinc-800/50 last:border-0">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className={`text-[9px] font-bold shrink-0 ${r.dir === 'CALL' ? 'text-emerald-500' : 'text-rose-500'}`}>{r.dir === 'CALL' ? '📈' : '📉'} {r.dir}</span>
                              <span className="text-[10px] text-gray-700 dark:text-zinc-300 font-medium truncate">{getSymbolDisplayName(r.symbol)}</span>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <WrBadge rate={r.wr ?? null} size="sm" />
                              <PnlCell val={r.pnl ?? null} compact />
                              <span className="text-[9px] text-gray-400 dark:text-zinc-600 font-mono">{r.trades}t</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })()}

          {/* ── Direction Trend Table: CALL vs PUT × 7d / 30d / 90d ─────────── */}
          <div className="bg-white dark:bg-zinc-900 border border-gray-100 dark:border-zinc-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 dark:border-zinc-800">
              <span className="text-[11px] font-bold text-gray-700 dark:text-zinc-300 uppercase tracking-wide">📊 Direction Trends — CALL vs PUT × 7d / 30d / 90d</span>
              <span className="ml-2 text-[10px] text-gray-400 dark:text-zinc-600">the system's edge is directional, not symbol-wide</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs min-w-[860px]">
                <thead>
                  <tr className="border-b border-gray-100 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-900/60">
                    <th className="px-4 py-2 text-left text-[10px] font-semibold text-gray-500 dark:text-zinc-500 uppercase tracking-wide">Symbol</th>
                    <th className="px-3 py-2 text-center text-[10px] font-semibold text-emerald-600 dark:text-emerald-500 uppercase tracking-wide">📈 CALL 7d</th>
                    <th className="px-3 py-2 text-center text-[10px] font-semibold text-emerald-600 dark:text-emerald-500 uppercase tracking-wide">CALL 30d</th>
                    <th className="px-3 py-2 text-center text-[10px] font-semibold text-emerald-600 dark:text-emerald-500 uppercase tracking-wide">CALL 90d</th>
                    <th className="px-1 py-2 text-center text-gray-200 dark:text-zinc-800">│</th>
                    <th className="px-3 py-2 text-center text-[10px] font-semibold text-rose-600 dark:text-rose-500 uppercase tracking-wide">📉 PUT 7d</th>
                    <th className="px-3 py-2 text-center text-[10px] font-semibold text-rose-600 dark:text-rose-500 uppercase tracking-wide">PUT 30d</th>
                    <th className="px-3 py-2 text-center text-[10px] font-semibold text-rose-600 dark:text-rose-500 uppercase tracking-wide">PUT 90d</th>
                    <th className="px-3 py-2 text-center text-[10px] font-semibold text-gray-500 dark:text-zinc-500 uppercase tracking-wide">Edge (all-time)</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.map(s => {
                    const dt  = dirTrendMap.get(s.symbol);
                    const dst = dirStats.find(r => r.symbol === s.symbol);
                    const edge = (dst?.callWinRate ?? 0) - (dst?.putWinRate ?? 0);
                    return (
                      <tr key={s.symbol} className="border-b border-gray-50 dark:border-zinc-800/50 hover:bg-gray-50 dark:hover:bg-zinc-800/30 transition-colors">
                        <td className="px-4 py-2.5">
                          <span className="text-[11px] font-semibold text-gray-800 dark:text-zinc-200">{getSymbolDisplayName(s.symbol)}</span>
                          <span className="ml-1.5 text-[9px] text-gray-400 dark:text-zinc-600 font-mono hidden sm:inline">{s.symbol}</span>
                        </td>
                        <td className="px-3 py-2.5 text-center"><WrBadge rate={dt?.call.wr7  ?? null} size="sm" /></td>
                        <td className="px-3 py-2.5 text-center"><WrBadge rate={dt?.call.wr30 ?? null} size="sm" /></td>
                        <td className="px-3 py-2.5 text-center"><WrBadge rate={dt?.call.wr90 ?? null} size="sm" /></td>
                        <td className="px-0 py-2.5 text-center text-gray-200 dark:text-zinc-800 text-lg select-none">│</td>
                        <td className="px-3 py-2.5 text-center"><WrBadge rate={dt?.put.wr7  ?? null} size="sm" /></td>
                        <td className="px-3 py-2.5 text-center"><WrBadge rate={dt?.put.wr30 ?? null} size="sm" /></td>
                        <td className="px-3 py-2.5 text-center"><WrBadge rate={dt?.put.wr90 ?? null} size="sm" /></td>
                        <td className="px-3 py-2.5 text-center">
                          {dst?.callWinRate != null && dst?.putWinRate != null ? (
                            <span className={`font-mono font-bold text-[11px] tabular-nums ${edge >= 10 ? 'text-emerald-500 dark:text-emerald-400' : edge >= 0 ? 'text-blue-500 dark:text-blue-400' : 'text-rose-500 dark:text-rose-400'}`}>
                              {edge >= 0 ? '+' : ''}{edge.toFixed(1)}pp
                            </span>
                          ) : <span className="text-gray-300 dark:text-zinc-700 text-[9px]">—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-[9px] text-gray-400 dark:text-zinc-600 px-4 py-2 border-t border-gray-100 dark:border-zinc-800">
              Identical 7d / 30d / 90d = all trades are recent (&lt;7 days old). Edge = all-time CALL WR − PUT WR. Colors: green ≥58%, blue 52–58%, amber 48–52%, red &lt;48%.
            </p>
          </div>

          {/* ── P&L Trend Table ───────────────────────────────────────────────── */}
          <div className="bg-white dark:bg-zinc-900 border border-gray-100 dark:border-zinc-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 dark:border-zinc-800">
              <span className="text-[11px] font-bold text-gray-700 dark:text-zinc-300 uppercase tracking-wide">💰 P&L Trends — 7d / 30d / 90d with Direction Split</span>
              <span className="ml-2 text-[10px] text-gray-400 dark:text-zinc-600">profit trend is more actionable than WR alone</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs min-w-[820px]">
                <thead>
                  <tr className="border-b border-gray-100 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-900/60">
                    <th className="px-4 py-2 text-left text-[10px] font-semibold text-gray-500 dark:text-zinc-500 uppercase tracking-wide">Symbol</th>
                    <th className="px-3 py-2 text-center text-[10px] font-semibold text-gray-500 dark:text-zinc-500 uppercase tracking-wide">7d P&L</th>
                    <th className="px-3 py-2 text-center text-[10px] font-semibold text-gray-500 dark:text-zinc-500 uppercase tracking-wide">30d P&L</th>
                    <th className="px-3 py-2 text-center text-[10px] font-semibold text-gray-500 dark:text-zinc-500 uppercase tracking-wide">90d P&L</th>
                    <th className="px-1 py-2 text-center text-gray-200 dark:text-zinc-800">│</th>
                    <th className="px-3 py-2 text-center text-[10px] font-semibold text-emerald-600 dark:text-emerald-500 uppercase tracking-wide">📈 CALL 7d P&L</th>
                    <th className="px-3 py-2 text-center text-[10px] font-semibold text-rose-600 dark:text-rose-500 uppercase tracking-wide">📉 PUT 7d P&L</th>
                    <th className="px-3 py-2 text-center text-[10px] font-semibold text-gray-500 dark:text-zinc-500 uppercase tracking-wide">P&L Trend</th>
                  </tr>
                </thead>
                <tbody>
                  {[...stats]
                    .map(s => ({ s, tw: trendMap.get(s.symbol), dt: dirTrendMap.get(s.symbol) }))
                    .sort((a, b) => (a.tw?.pnl7 ?? 0) - (b.tw?.pnl7 ?? 0))
                    .map(({ s, tw, dt }) => {
                      const pnl7  = tw?.pnl7  ?? 0;
                      const pnl30 = tw?.pnl30 ?? 0;
                      const pnl90 = tw?.pnl90 ?? 0;
                      const weeklyRate30 = tw && tw.trades30 >= 5 ? pnl30 / 4 : null;
                      const pnlTrend = weeklyRate30 != null && tw && tw.trades7 >= 5
                        ? (pnl7 >= weeklyRate30 + 5 ? 'IMPROVING' : pnl7 <= weeklyRate30 - 5 ? 'DETERIORATING' : 'STABLE')
                        : null;
                      return (
                        <tr key={s.symbol} className="border-b border-gray-50 dark:border-zinc-800/50 hover:bg-gray-50 dark:hover:bg-zinc-800/30 transition-colors">
                          <td className="px-4 py-2.5">
                            <span className="text-[11px] font-semibold text-gray-800 dark:text-zinc-200">{getSymbolDisplayName(s.symbol)}</span>
                            <span className="ml-1.5 text-[9px] text-gray-400 dark:text-zinc-600 font-mono hidden sm:inline">{s.symbol}</span>
                          </td>
                          <td className="px-3 py-2.5 text-center"><PnlCell val={tw?.trades7  && tw.trades7  > 0 ? pnl7  : null} compact /></td>
                          <td className="px-3 py-2.5 text-center"><PnlCell val={tw?.trades30 && tw.trades30 > 0 ? pnl30 : null} compact /></td>
                          <td className="px-3 py-2.5 text-center"><PnlCell val={tw?.trades90 && tw.trades90 > 0 ? pnl90 : null} compact /></td>
                          <td className="px-0 py-2.5 text-center text-gray-200 dark:text-zinc-800 text-lg select-none">│</td>
                          <td className="px-3 py-2.5 text-center"><PnlCell val={dt?.call.trades7 && dt.call.trades7 > 0 ? dt.call.pnl7 : null} compact /></td>
                          <td className="px-3 py-2.5 text-center"><PnlCell val={dt?.put.trades7  && dt.put.trades7  > 0 ? dt.put.pnl7  : null} compact /></td>
                          <td className="px-3 py-2.5 text-center">
                            {pnlTrend ? (
                              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                                pnlTrend === 'IMPROVING'     ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' :
                                pnlTrend === 'DETERIORATING' ? 'bg-rose-500/15 text-rose-600 dark:text-rose-400' :
                                'bg-gray-100 dark:bg-zinc-800 text-gray-500 dark:text-zinc-400'
                              }`}>
                                {pnlTrend === 'IMPROVING' ? '↑ Improving' : pnlTrend === 'DETERIORATING' ? '↓ Deteriorating' : '→ Stable'}
                              </span>
                            ) : <span className="text-[9px] text-gray-300 dark:text-zinc-700 font-mono">—</span>}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
            <p className="text-[9px] text-gray-400 dark:text-zinc-600 px-4 py-2 border-t border-gray-100 dark:border-zinc-800">
              Sorted by worst 7d P&L. Trend = current 7d rate vs 30d average weekly rate (±$5 threshold, min 5 trades per window). CALL/PUT 7d shows directional contribution to this week's P&L.
            </p>
          </div>

          {/* Symbol cards grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {stats.map(sym => {
              const tw = trendMap.get(sym.symbol);
              const dt = dirTrendMap.get(sym.symbol);
              const sparkPts = sparklineMap.get(sym.symbol) ?? [];
              const trend = tw?.trend ?? 'INSUFFICIENT';
              const borderColor =
                trend === 'IMPROVING' ? 'border-emerald-400 dark:border-emerald-600' :
                trend === 'DECLINING' ? 'border-rose-400 dark:border-rose-600' :
                'border-gray-100 dark:border-zinc-800';
              const headerBg =
                trend === 'IMPROVING' ? 'bg-emerald-50 dark:bg-emerald-950/30' :
                trend === 'DECLINING' ? 'bg-rose-50 dark:bg-rose-950/30' :
                'bg-gray-50 dark:bg-zinc-900/60';
              return (
                <div key={sym.symbol} className={`bg-white dark:bg-zinc-900 border-2 rounded-xl overflow-hidden flex flex-col ${borderColor}`}>
                  {/* Card header */}
                  <div className={`px-4 py-3 border-b border-gray-100 dark:border-zinc-800 flex items-center justify-between ${headerBg}`}>
                    <div>
                      <p className="text-[12px] font-bold text-gray-800 dark:text-zinc-200 leading-tight">{getSymbolDisplayName(sym.symbol)}</p>
                      <p className="text-[9px] text-gray-400 dark:text-zinc-600 font-mono mt-0.5">{sym.symbol}</p>
                    </div>
                    <TrendBadge trend={trend} />
                  </div>

                  {/* Sparkline */}
                  <div className="px-4 py-3 border-b border-gray-100 dark:border-zinc-800 flex flex-col gap-1">
                    <p className="text-[9px] text-gray-400 dark:text-zinc-600 font-medium uppercase tracking-wide">Weekly WR — last 12 weeks</p>
                    <WrSparkline points={sparkPts} w={220} h={44} />
                    {tw?.wr7prev != null && tw?.wr7 != null && (
                      <p className="text-[9px] text-gray-400 dark:text-zinc-500 font-mono">
                        Prev 7d: <span className="font-bold text-gray-600 dark:text-zinc-400">{tw.wr7prev.toFixed(1)}%</span>
                        <span className="mx-1 text-gray-300 dark:text-zinc-700">→</span>
                        Now: <span className={`font-bold ${tw.wr7 >= 54 ? 'text-emerald-500' : tw.wr7 >= 48 ? 'text-amber-500' : 'text-rose-500'}`}>{tw.wr7.toFixed(1)}%</span>
                        {tw.wr7 - tw.wr7prev >= 0
                          ? <span className="ml-1 text-emerald-500">↑{(tw.wr7 - tw.wr7prev).toFixed(1)}pp</span>
                          : <span className="ml-1 text-rose-500">↓{Math.abs(tw.wr7 - tw.wr7prev).toFixed(1)}pp</span>
                        }
                      </p>
                    )}
                  </div>

                  {/* Overall three windows */}
                  <div className="grid grid-cols-3 divide-x divide-gray-100 dark:divide-zinc-800 border-b border-gray-100 dark:border-zinc-800">
                    {([
                      { label: '7d',  wr: tw?.wr7,  pnl: tw?.pnl7,  trades: tw?.trades7  },
                      { label: '30d', wr: tw?.wr30, pnl: tw?.pnl30, trades: tw?.trades30 },
                      { label: '90d', wr: tw?.wr90, pnl: tw?.pnl90, trades: tw?.trades90 },
                    ] as const).map(win => (
                      <div key={win.label} className="px-2 py-2.5 flex flex-col items-center gap-1">
                        <span className="text-[8px] text-gray-400 dark:text-zinc-600 font-semibold uppercase tracking-wide">{win.label} overall</span>
                        {win.wr != null ? (
                          <>
                            <span className={`font-mono font-bold text-[14px] tabular-nums leading-none ${
                              win.wr >= 58 ? 'text-emerald-500 dark:text-emerald-400' :
                              win.wr >= 52 ? 'text-blue-500 dark:text-blue-400' :
                              win.wr >= 48 ? 'text-amber-500 dark:text-amber-400' :
                              'text-rose-500 dark:text-rose-400'
                            }`}>{win.wr.toFixed(1)}%</span>
                            <PnlCell val={win.pnl ?? null} compact />
                          </>
                        ) : (
                          <span className="text-[9px] text-gray-400 dark:text-zinc-600 font-mono mt-1">—</span>
                        )}
                      </div>
                    ))}
                  </div>

                  {/* CALL vs PUT direction rows */}
                  <div className="border-b border-gray-100 dark:border-zinc-800">
                    {/* Column headers */}
                    <div className="grid grid-cols-[72px_1fr_1fr_1fr] border-b border-gray-50 dark:border-zinc-800/60 bg-gray-50/50 dark:bg-zinc-900/30">
                      <div className="px-2 py-1" />
                      {(['7d', '30d', '90d'] as const).map(l => (
                        <div key={l} className="py-1 text-center text-[8px] text-gray-400 dark:text-zinc-600 font-semibold uppercase tracking-wide">{l}</div>
                      ))}
                    </div>
                    {/* CALL row */}
                    <div className="grid grid-cols-[72px_1fr_1fr_1fr] items-center border-b border-gray-50 dark:border-zinc-800/60">
                      <div className="px-2 py-2 flex items-center">
                        <span className="text-[9px] font-bold text-emerald-600 dark:text-emerald-400">📈 CALL</span>
                      </div>
                      <div className="py-2 flex flex-col items-center gap-0.5">
                        <WrBadge rate={dt?.call.wr7  ?? null} size="sm" />
                        {dt && dt.call.trades7  > 0 && <PnlCell val={dt.call.pnl7}  compact />}
                      </div>
                      <div className="py-2 flex flex-col items-center gap-0.5">
                        <WrBadge rate={dt?.call.wr30 ?? null} size="sm" />
                        {dt && dt.call.trades30 > 0 && <PnlCell val={dt.call.pnl30} compact />}
                      </div>
                      <div className="py-2 flex flex-col items-center gap-0.5">
                        <WrBadge rate={dt?.call.wr90 ?? null} size="sm" />
                        {dt && dt.call.trades90 > 0 && <PnlCell val={dt.call.pnl90} compact />}
                      </div>
                    </div>
                    {/* PUT row */}
                    <div className="grid grid-cols-[72px_1fr_1fr_1fr] items-center">
                      <div className="px-2 py-2 flex items-center">
                        <span className="text-[9px] font-bold text-rose-600 dark:text-rose-400">📉 PUT</span>
                      </div>
                      <div className="py-2 flex flex-col items-center gap-0.5">
                        <WrBadge rate={dt?.put.wr7  ?? null} size="sm" />
                        {dt && dt.put.trades7  > 0 && <PnlCell val={dt.put.pnl7}  compact />}
                      </div>
                      <div className="py-2 flex flex-col items-center gap-0.5">
                        <WrBadge rate={dt?.put.wr30 ?? null} size="sm" />
                        {dt && dt.put.trades30 > 0 && <PnlCell val={dt.put.pnl30} compact />}
                      </div>
                      <div className="py-2 flex flex-col items-center gap-0.5">
                        <WrBadge rate={dt?.put.wr90 ?? null} size="sm" />
                        {dt && dt.put.trades90 > 0 && <PnlCell val={dt.put.pnl90} compact />}
                      </div>
                    </div>
                  </div>

                  {/* All-time bar */}
                  <div className="px-4 py-2 flex items-center gap-2">
                    <span className="text-[9px] text-gray-400 dark:text-zinc-600 whitespace-nowrap">All-time:</span>
                    <WrBar wr={sym.winRate} />
                    <span className="text-[9px] font-mono font-semibold text-gray-600 dark:text-zinc-400 whitespace-nowrap">
                      {sym.winRate?.toFixed(1) ?? '—'}% ({sym.trades}t)
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Trend summary table */}
          <div className="bg-white dark:bg-zinc-900 border border-gray-100 dark:border-zinc-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 dark:border-zinc-800">
              <span className="text-[11px] font-bold text-gray-700 dark:text-zinc-300 uppercase tracking-wide">📊 Trend Summary</span>
              <span className="ml-2 text-[10px] text-gray-400 dark:text-zinc-600">All symbols at a glance — sorted by 7-day WR</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-100 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-900/60">
                    <th className="px-4 py-2 text-left text-[10px] font-semibold text-gray-500 dark:text-zinc-500 uppercase tracking-wide">Symbol</th>
                    <th className="px-4 py-2 text-center text-[10px] font-semibold text-gray-500 dark:text-zinc-500 uppercase tracking-wide">Trend</th>
                    <th className="px-4 py-2 text-center text-[10px] font-semibold text-gray-500 dark:text-zinc-500 uppercase tracking-wide">7d WR</th>
                    <th className="px-4 py-2 text-center text-[10px] font-semibold text-gray-500 dark:text-zinc-500 uppercase tracking-wide">30d WR</th>
                    <th className="px-4 py-2 text-center text-[10px] font-semibold text-gray-500 dark:text-zinc-500 uppercase tracking-wide">90d WR</th>
                    <th className="px-4 py-2 text-center text-[10px] font-semibold text-gray-500 dark:text-zinc-500 uppercase tracking-wide">7d P&L</th>
                    <th className="px-4 py-2 text-center text-[10px] font-semibold text-gray-500 dark:text-zinc-500 uppercase tracking-wide">30d P&L</th>
                    <th className="px-4 py-2 text-center text-[10px] font-semibold text-gray-500 dark:text-zinc-500 uppercase tracking-wide">All-time WR</th>
                  </tr>
                </thead>
                <tbody>
                  {[...stats]
                    .map(s => ({ s, tw: trendMap.get(s.symbol) }))
                    .sort((a, b) => (b.tw?.wr7 ?? -1) - (a.tw?.wr7 ?? -1))
                    .map(({ s, tw }) => (
                      <tr key={s.symbol} className="border-b border-gray-50 dark:border-zinc-800/50 hover:bg-gray-50 dark:hover:bg-zinc-800/30 transition-colors">
                        <td className="px-4 py-2.5">
                          <span className="text-[11px] font-semibold text-gray-800 dark:text-zinc-200">{getSymbolDisplayName(s.symbol)}</span>
                          <span className="ml-1.5 text-[9px] text-gray-400 dark:text-zinc-600 font-mono">{s.symbol}</span>
                        </td>
                        <td className="px-4 py-2.5 text-center"><TrendBadge trend={tw?.trend ?? 'INSUFFICIENT'} /></td>
                        <td className="px-4 py-2.5 text-center"><WrBadge rate={tw?.wr7  ?? null} size="sm" /></td>
                        <td className="px-4 py-2.5 text-center"><WrBadge rate={tw?.wr30 ?? null} size="sm" /></td>
                        <td className="px-4 py-2.5 text-center"><WrBadge rate={tw?.wr90 ?? null} size="sm" /></td>
                        <td className="px-4 py-2.5 text-center"><PnlCell val={tw?.pnl7  ?? null} compact /></td>
                        <td className="px-4 py-2.5 text-center"><PnlCell val={tw?.pnl30 ?? null} compact /></td>
                        <td className="px-4 py-2.5 text-center"><WrBadge rate={s.winRate} size="sm" /></td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            <p className="text-[9px] text-gray-400 dark:text-zinc-600 px-4 py-2 border-t border-gray-100 dark:border-zinc-800">
              Trend: current 7d WR vs previous 7 days (±3pp, min 5 trades per window).
              Amber dashes in sparklines = {BREAKEVEN_PCT}% breakeven. Direction trends above are time-filtered independently.
            </p>
          </div>
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* RECS TAB                                                            */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {activeTab === 'recs' && (
        <>
          {/* Summary bar */}
          <div className="bg-white dark:bg-zinc-900 border border-gray-100 dark:border-zinc-800 rounded-xl px-5 py-4">
            <div className="flex flex-col sm:flex-row sm:items-start gap-4">
              <div className="flex-1">
                <h2 className="text-sm font-bold text-gray-800 dark:text-zinc-200 mb-1">🤖 Recommendation Engine</h2>
                <p className="text-[11px] text-gray-500 dark:text-zinc-500 leading-relaxed">
                  Advisory only — no automatic changes. Every action requires explicit human approval.
                  Confidence is based on sample size: <strong>HIGH</strong> ≥ 100 trades, <strong>MEDIUM</strong> 50–99, <strong>LOW</strong> 30–49.
                  DISABLE is never suggested below {HC_MIN_TRADES} trades, regardless of WR.
                  P&amp;L and trend direction are factored into the reason text.
                </p>
              </div>
              {/* Summary counts */}
              <div className="flex gap-3 flex-wrap shrink-0">
                {recCounts.disable > 0 && (
                  <div className="text-center px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/20">
                    <p className="text-[18px] font-bold text-rose-600 dark:text-rose-400 leading-none">{recCounts.disable}</p>
                    <p className="text-[9px] text-rose-600/70 dark:text-rose-500/70 font-semibold mt-0.5">DISABLE</p>
                  </div>
                )}
                {recCounts.watch > 0 && (
                  <div className="text-center px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
                    <p className="text-[18px] font-bold text-amber-600 dark:text-amber-400 leading-none">{recCounts.watch}</p>
                    <p className="text-[9px] text-amber-600/70 dark:text-amber-500/70 font-semibold mt-0.5">WATCH</p>
                  </div>
                )}
                {recCounts.keep > 0 && (
                  <div className="text-center px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                    <p className="text-[18px] font-bold text-emerald-600 dark:text-emerald-400 leading-none">{recCounts.keep}</p>
                    <p className="text-[9px] text-emerald-600/70 dark:text-emerald-500/70 font-semibold mt-0.5">KEEP</p>
                  </div>
                )}
                {recCounts.insufficient > 0 && (
                  <div className="text-center px-3 py-2 rounded-lg bg-gray-100 dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700">
                    <p className="text-[18px] font-bold text-gray-500 dark:text-zinc-400 leading-none">{recCounts.insufficient}</p>
                    <p className="text-[9px] text-gray-500/70 dark:text-zinc-500/70 font-semibold mt-0.5">INSUFF.</p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* ── Currently Suppressed — always visible at top if any ──────────── */}
          {(() => {
            const suppressed = symbolConfigs.flatMap(c => [
              ...(c.callEnabled === false ? [{ symbol: c.symbol, dir: 'CALL' as const, since: c.updatedAt }] : []),
              ...(c.putEnabled  === false ? [{ symbol: c.symbol, dir: 'PUT'  as const, since: c.updatedAt }] : []),
            ]);
            if (suppressed.length === 0) return null;
            return (
              <div className="bg-white dark:bg-zinc-900 border border-amber-200 dark:border-amber-900/50 rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-amber-100 dark:border-amber-900/30 bg-amber-50/60 dark:bg-amber-950/20 flex items-center justify-between">
                  <div>
                    <span className="text-[11px] font-bold text-amber-700 dark:text-amber-400 uppercase tracking-wide">🔒 Currently Suppressed Directions ({suppressed.length})</span>
                    <span className="ml-2 text-[10px] text-amber-600/70 dark:text-amber-500/70">Click a direction badge to re-enable it instantly</span>
                  </div>
                </div>
                <div className="divide-y divide-gray-50 dark:divide-zinc-800/60">
                  {suppressed.map(({ symbol, dir, since }) => {
                    const ds = dirStats.find(r => r.symbol === symbol);
                    const wr  = dir === 'CALL' ? ds?.callWinRate  : ds?.putWinRate;
                    const pnl = dir === 'CALL' ? ds?.callPnl      : ds?.putPnl;
                    const t   = dir === 'CALL' ? ds?.callTrades   : ds?.putTrades;
                    return (
                      <div key={`${symbol}:${dir}`} className="px-4 py-3 flex items-center gap-4 flex-wrap sm:flex-nowrap">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`text-[10px] font-bold ${dir === 'CALL' ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                              {dir === 'CALL' ? '📈' : '📉'} {dir}
                            </span>
                            <span className="text-[12px] font-semibold text-gray-800 dark:text-zinc-200">{getSymbolDisplayName(symbol)}</span>
                            <span className="text-[9px] font-mono text-gray-400 dark:text-zinc-600">{symbol}</span>
                          </div>
                          <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                            {wr != null && <WrBadge rate={wr} size="sm" />}
                            {pnl != null && <PnlCell val={pnl} compact />}
                            {t != null && <span className="text-[9px] font-mono text-gray-400 dark:text-zinc-600">{t} trades (all-time)</span>}
                            {since && <span className="text-[9px] text-gray-400 dark:text-zinc-600">suppressed {since.toLocaleDateString()}</span>}
                          </div>
                        </div>
                        <div className="shrink-0">
                          <DirectionToggle symbol={symbol} direction={dir} enabled={false} />
                        </div>
                      </div>
                    );
                  })}
                </div>
                <p className="text-[9px] text-amber-600/70 dark:text-amber-500/70 px-4 py-2 border-t border-amber-100 dark:border-amber-900/30 bg-amber-50/30 dark:bg-amber-950/10">
                  The trading bot refreshes its config within 60 seconds of any change. Re-enabling restores normal signal processing for that direction.
                </p>
              </div>
            );
          })()}

          {/* ── DISABLE section — interactive ──────────────────────────────────── */}
          {recCounts.disable > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] font-bold text-rose-600 dark:text-rose-400 uppercase tracking-wide px-1">
                🔴 Disable Recommendations
              </p>
              <RecommendationApproval disableRecs={disableRecs} />
            </div>
          )}

          {/* ── WATCH section — informational ──────────────────────────────────── */}
          {recCounts.watch > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] font-bold text-amber-600 dark:text-amber-400 uppercase tracking-wide px-1">
                🟡 Watch — Monitor Before Acting
              </p>
              {recs.filter(r => r.action === 'WATCH').map(r => (
                <div key={`${r.symbol}:${r.direction}`} className="bg-white dark:bg-zinc-900 border border-amber-200 dark:border-amber-900/40 rounded-xl px-4 py-3">
                  <div className="flex flex-col sm:flex-row sm:items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1.5">
                        <span className={`text-[11px] font-bold px-2 py-0.5 rounded border ${
                          r.direction === 'PUT'
                            ? 'bg-rose-500/15 border-rose-500/30 text-rose-700 dark:text-rose-400'
                            : 'bg-emerald-500/15 border-emerald-500/30 text-emerald-700 dark:text-emerald-400'
                        }`}>
                          {r.direction === 'CALL' ? '📈' : '📉'} {r.direction}
                        </span>
                        <span className="text-[12px] font-bold text-gray-800 dark:text-zinc-200">{getSymbolDisplayName(r.symbol)}</span>
                        <span className="text-[9px] text-gray-400 dark:text-zinc-600 font-mono">{r.symbol}</span>
                        {r.confidence && (
                          <span className={`text-[9px] px-1.5 py-0.5 rounded border font-bold ${
                            r.confidence === 'HIGH'   ? 'bg-amber-500/15 border-amber-500/30 text-amber-700 dark:text-amber-400' :
                            r.confidence === 'MEDIUM' ? 'bg-amber-500/10 border-amber-500/20 text-amber-600 dark:text-amber-500' :
                            'bg-gray-100 border-gray-200 dark:bg-zinc-800 dark:border-zinc-700 text-gray-500 dark:text-zinc-400'
                          }`}>{r.confidence} confidence</span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 flex-wrap mb-1.5">
                        <span className="font-mono tabular-nums font-bold text-amber-600 dark:text-amber-400 text-[13px]">
                          {r.wr?.toFixed(1)}% WR
                        </span>
                        <span className="text-[11px] text-gray-500 dark:text-zinc-500 font-mono">{r.trades} trades</span>
                        {r.pnl != null && (
                          <span className={`text-[11px] font-mono font-semibold ${r.pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                            {r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(0)} P&amp;L
                          </span>
                        )}
                      </div>
                      <p className="text-[10px] text-gray-500 dark:text-zinc-500 leading-relaxed">{r.reason}</p>
                    </div>
                    <div className="shrink-0 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-[10px] font-bold text-amber-700 dark:text-amber-400 self-start">
                      👁 Monitor
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ── KEEP section — informational ───────────────────────────────────── */}
          {recCounts.keep > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-wide px-1">
                🟢 Keep — Performing Well
              </p>
              <div className="bg-white dark:bg-zinc-900 border border-gray-100 dark:border-zinc-800 rounded-xl overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-gray-100 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-900/60">
                      <th className="px-4 py-2 text-left text-[10px] font-semibold text-gray-500 dark:text-zinc-500 uppercase tracking-wide">Symbol</th>
                      <th className="px-4 py-2 text-center text-[10px] font-semibold text-gray-500 dark:text-zinc-500 uppercase tracking-wide">Dir</th>
                      <th className="px-4 py-2 text-center text-[10px] font-semibold text-gray-500 dark:text-zinc-500 uppercase tracking-wide">WR</th>
                      <th className="px-4 py-2 text-center text-[10px] font-semibold text-gray-500 dark:text-zinc-500 uppercase tracking-wide">Trades</th>
                      <th className="px-4 py-2 text-center text-[10px] font-semibold text-gray-500 dark:text-zinc-500 uppercase tracking-wide">P&amp;L</th>
                      <th className="px-4 py-2 text-center text-[10px] font-semibold text-gray-500 dark:text-zinc-500 uppercase tracking-wide">Confidence</th>
                      <th className="px-4 py-2 text-left text-[10px] font-semibold text-gray-500 dark:text-zinc-500 uppercase tracking-wide hidden sm:table-cell">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recs.filter(r => r.action === 'KEEP').map(r => (
                      <tr key={`${r.symbol}:${r.direction}`} className="border-b border-gray-50 dark:border-zinc-800/50 hover:bg-gray-50 dark:hover:bg-zinc-800/30 transition-colors">
                        <td className="px-4 py-2.5">
                          <span className="text-[11px] font-semibold text-gray-800 dark:text-zinc-200">{getSymbolDisplayName(r.symbol)}</span>
                          <span className="ml-1.5 text-[9px] text-gray-400 dark:text-zinc-600 font-mono hidden sm:inline">{r.symbol}</span>
                        </td>
                        <td className="px-4 py-2.5 text-center">
                          <span className={`text-[10px] font-bold ${r.direction === 'CALL' ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                            {r.direction === 'CALL' ? '📈' : '📉'} {r.direction}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-center"><WrBadge rate={r.wr} size="sm" /></td>
                        <td className="px-4 py-2.5 text-center">
                          <span className="font-mono text-[10px] text-gray-600 dark:text-zinc-400">{r.trades}</span>
                        </td>
                        <td className="px-4 py-2.5 text-center"><PnlCell val={r.pnl} compact /></td>
                        <td className="px-4 py-2.5 text-center">
                          {r.confidence ? (
                            <span className={`text-[9px] px-1.5 py-0.5 rounded border font-bold ${
                              r.confidence === 'HIGH'   ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-700 dark:text-emerald-400' :
                              r.confidence === 'MEDIUM' ? 'bg-blue-500/15 border-blue-500/30 text-blue-700 dark:text-blue-400' :
                              'bg-gray-100 border-gray-200 dark:bg-zinc-800 dark:border-zinc-700 text-gray-500 dark:text-zinc-400'
                            }`}>{r.confidence}</span>
                          ) : <span className="text-gray-300 dark:text-zinc-700 text-[9px]">—</span>}
                        </td>
                        <td className="px-4 py-2.5 hidden sm:table-cell">
                          <p className="text-[9px] text-gray-400 dark:text-zinc-600 leading-relaxed max-w-xs truncate" title={r.reason}>{r.reason}</p>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── INSUFFICIENT section — informational ────────────────────────────── */}
          {recCounts.insufficient > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] font-semibold text-gray-400 dark:text-zinc-600 uppercase tracking-wide px-1">
                ⏳ Insufficient Data — More Trades Needed
              </p>
              <div className="bg-white dark:bg-zinc-900 border border-gray-100 dark:border-zinc-800 rounded-xl overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-gray-100 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-900/60">
                      <th className="px-4 py-2 text-left text-[10px] font-semibold text-gray-500 dark:text-zinc-500 uppercase tracking-wide">Symbol</th>
                      <th className="px-4 py-2 text-center text-[10px] font-semibold text-gray-500 dark:text-zinc-500 uppercase tracking-wide">Dir</th>
                      <th className="px-4 py-2 text-center text-[10px] font-semibold text-gray-500 dark:text-zinc-500 uppercase tracking-wide">Trades so far</th>
                      <th className="px-4 py-2 text-center text-[10px] font-semibold text-gray-500 dark:text-zinc-500 uppercase tracking-wide">Need</th>
                      <th className="px-4 py-2 text-left text-[10px] font-semibold text-gray-500 dark:text-zinc-500 uppercase tracking-wide hidden sm:table-cell">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recs.filter(r => r.action === 'INSUFFICIENT').map(r => {
                      const needed = Math.max(0, MIN_DISPLAY_TRADES - r.trades);
                      return (
                        <tr key={`${r.symbol}:${r.direction}`} className="border-b border-gray-50 dark:border-zinc-800/50">
                          <td className="px-4 py-2.5">
                            <span className="text-[11px] font-semibold text-gray-700 dark:text-zinc-300">{getSymbolDisplayName(r.symbol)}</span>
                            <span className="ml-1.5 text-[9px] text-gray-400 dark:text-zinc-600 font-mono hidden sm:inline">{r.symbol}</span>
                          </td>
                          <td className="px-4 py-2.5 text-center">
                            <span className={`text-[10px] font-bold ${r.direction === 'CALL' ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                              {r.direction === 'CALL' ? '📈' : '📉'} {r.direction}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-center">
                            <span className="font-mono text-[11px] font-bold text-gray-600 dark:text-zinc-400">{r.trades}</span>
                          </td>
                          <td className="px-4 py-2.5 text-center">
                            <span className="font-mono text-[10px] text-gray-400 dark:text-zinc-600">
                              {needed > 0 ? `+${needed} more` : '—'}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 hidden sm:table-cell">
                            <p className="text-[9px] text-gray-400 dark:text-zinc-600 leading-relaxed">{r.reason}</p>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <p className="text-[10px] text-gray-400 dark:text-zinc-600 text-center">
            Thresholds: DISABLE requires ≥{HC_MIN_TRADES} trades + WR &lt;{WEAK_WR}% ·
            WATCH: WR {WEAK_WR}–{WATCH_WR_MAX}% or sample &lt;{HC_MIN_TRADES} trades ·
            Breakeven: {BREAKEVEN_PCT}% (from {(DERIV_PAYOUT_RATE * 100).toFixed(0)}% Deriv payout rate) ·
            All thresholds configurable in <code className="font-mono">lib/trading-config.ts</code>
          </p>
        </>
      )}
    </div>
  );
}
