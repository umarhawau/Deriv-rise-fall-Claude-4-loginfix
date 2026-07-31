import { db } from '@workspace/db';
import { tradeLogsTable } from '@workspace/db/schema';
import { and, ne, inArray } from 'drizzle-orm';
import { AdminLoginForm } from '../quant/login-form';
import { isAdminAuthorized } from '../quant/admin-auth';
import { logoutAction } from '../quant/actions';
import { AdminNav } from '../admin-nav';
import { AutoRefresh } from '../auto-refresh';
import LossPatternsClient from './loss-patterns-client';
import type { BreakdownRow } from '@/app/api/admin/loss-patterns/analyze/route';

export const dynamic = 'force-dynamic';

// ─── Duration normalisation (→ approximate seconds) ──────────────────────────
function toApproxSeconds(target: number, unit: string): number {
  if (unit === 't') return target * 2;   // ~2s per tick
  if (unit === 's') return target;
  if (unit === 'm') return target * 60;
  return target;
}

function durationLabel(target: number, unit: string): string {
  const secs = toApproxSeconds(target, unit);
  if (secs <= 4)  return '≤4s (ultra-short)';
  if (secs <= 15) return '5–15s (short)';
  if (secs <= 60) return '16–60s (medium)';
  if (secs <= 180) return '61–180s (long)';
  return '>180s (extended)';
}

// ─── ER bucket labels (same as Calibration Lab) ───────────────────────────────
const ER_BUCKETS = [
  { label: '0.00–0.10', min: 0,    max: 0.10 },
  { label: '0.10–0.20', min: 0.10, max: 0.20 },
  { label: '0.20–0.30', min: 0.20, max: 0.30 },
  { label: '0.30–0.40', min: 0.30, max: 0.40 },
  { label: '0.40–0.60', min: 0.40, max: 0.60 },
  { label: '0.60+',     min: 0.60, max: Infinity },
];
function erBucketLabel(er: number): string {
  return (ER_BUCKETS.find((b) => er >= b.min && er < b.max) ?? ER_BUCKETS[ER_BUCKETS.length - 1]).label;
}

// ─── Noise buckets ────────────────────────────────────────────────────────────
function noiseBucketLabel(n: number): string {
  if (n < 0.3) return 'Low (<0.30)';
  if (n < 0.7) return 'Medium (0.30–0.70)';
  return 'High (≥0.70)';
}

// ─── Hour-of-day → 4h bucket ──────────────────────────────────────────────────
function hourBucket(h: number): string {
  const start = Math.floor(h / 4) * 4;
  const end   = start + 4;
  return `${String(start).padStart(2, '0')}–${String(end).padStart(2, '0')} UTC`;
}

// ─── Generic breakdown builder ────────────────────────────────────────────────
type TradeRow = {
  status: 'WIN' | 'LOSS';
  keyFn: string;
};

function buildBreakdown(
  rows: { status: string; key: string }[],
  sortBy: 'lossRate' | 'losses' = 'lossRate',
  minTotal = 1,
): BreakdownRow[] {
  const map = new Map<string, { wins: number; losses: number }>();
  for (const r of rows) {
    const cell = map.get(r.key) ?? { wins: 0, losses: 0 };
    if (r.status === 'WIN')  cell.wins++;
    if (r.status === 'LOSS') cell.losses++;
    map.set(r.key, cell);
  }

  const result: BreakdownRow[] = [];
  for (const [label, { wins, losses }] of map.entries()) {
    const total = wins + losses;
    if (total < minTotal) continue;
    result.push({ label, wins, losses, total, lossRate: total > 0 ? (losses / total) * 100 : 0 });
  }

  if (sortBy === 'lossRate') result.sort((a, b) => b.lossRate - a.lossRate || b.total - a.total);
  if (sortBy === 'losses')   result.sort((a, b) => b.losses - a.losses);
  return result;
}

// ─── Hour order sort ──────────────────────────────────────────────────────────
const HOUR_ORDER = ['00–04 UTC', '04–08 UTC', '08–12 UTC', '12–16 UTC', '16–20 UTC', '20–24 UTC'];

export default async function LossPatternsPage() {
  if (!await isAdminAuthorized()) {
    return <AdminLoginForm />;
  }

  // ── Fetch all resolved trades ──
  const allTrades = await db
    .select({
      status:         tradeLogsTable.status,
      direction:      tradeLogsTable.direction,
      symbol:         tradeLogsTable.symbol,
      effectiveMode:  tradeLogsTable.effectiveMode,
      durationTarget: tradeLogsTable.durationTarget,
      durationUnit:   tradeLogsTable.durationUnit,
      erAtEntry:      tradeLogsTable.erAtEntry,
      noiseAtEntry:   tradeLogsTable.noiseAtEntry,
      createdAt:      tradeLogsTable.createdAt,
    })
    .from(tradeLogsTable)
    .where(
      and(
        inArray(tradeLogsTable.status, ['WIN', 'LOSS']),
        ne(tradeLogsTable.executionType, 'GHOST'), // analyse LIVE trades
      ),
    );

  // If no LIVE resolved trades, fall back to GHOST (useful during dev)
  const resolvedTrades = allTrades.length > 0 ? allTrades : await db
    .select({
      status:         tradeLogsTable.status,
      direction:      tradeLogsTable.direction,
      symbol:         tradeLogsTable.symbol,
      effectiveMode:  tradeLogsTable.effectiveMode,
      durationTarget: tradeLogsTable.durationTarget,
      durationUnit:   tradeLogsTable.durationUnit,
      erAtEntry:      tradeLogsTable.erAtEntry,
      noiseAtEntry:   tradeLogsTable.noiseAtEntry,
      createdAt:      tradeLogsTable.createdAt,
    })
    .from(tradeLogsTable)
    .where(inArray(tradeLogsTable.status, ['WIN', 'LOSS']));

  // ── Overall stats ──
  const totalResolved = resolvedTrades.length;
  const totalWins     = resolvedTrades.filter((r) => r.status === 'WIN').length;
  const totalLosses   = resolvedTrades.filter((r) => r.status === 'LOSS').length;
  const overallLossRate = totalResolved > 0 ? (totalLosses / totalResolved) * 100 : 0;

  const overall = {
    resolved: totalResolved,
    wins: totalWins,
    losses: totalLosses,
    lossRate: overallLossRate,
  };

  // ── Build each breakdown dimension ──
  const byHourRaw = buildBreakdown(
    resolvedTrades.map((r) => ({ status: r.status, key: hourBucket(r.createdAt.getUTCHours()) })),
    'lossRate', 1,
  );
  // Re-sort by time order for readability
  const byHour = [...byHourRaw].sort((a, b) => HOUR_ORDER.indexOf(a.label) - HOUR_ORDER.indexOf(b.label));

  const bySymbol = buildBreakdown(
    resolvedTrades.map((r) => ({ status: r.status, key: r.symbol })),
    'lossRate', 5,
  );

  const byMode = buildBreakdown(
    resolvedTrades.map((r) => ({ status: r.status, key: r.effectiveMode })),
    'lossRate', 1,
  );

  const byDirection = buildBreakdown(
    resolvedTrades.map((r) => ({ status: r.status, key: r.direction })),
    'lossRate', 1,
  );

  const byDuration = buildBreakdown(
    resolvedTrades.map((r) => ({
      status: r.status,
      key: durationLabel(r.durationTarget, r.durationUnit),
    })),
    'lossRate', 1,
  );

  const byErBucket = buildBreakdown(
    resolvedTrades.map((r) => ({
      status: r.status,
      key: erBucketLabel(parseFloat(r.erAtEntry ?? '0')),
    })),
    'lossRate', 1,
  );
  // Re-sort by ER bucket order
  const byErSorted = [...byErBucket].sort(
    (a, b) => ER_BUCKETS.findIndex((b2) => b2.label === a.label) - ER_BUCKETS.findIndex((b2) => b2.label === b.label),
  );

  const byNoise = buildBreakdown(
    resolvedTrades.map((r) => ({
      status: r.status,
      key: noiseBucketLabel(parseFloat(r.noiseAtEntry ?? '0')),
    })),
    'lossRate', 1,
  );

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-[#0a0a0f] text-gray-900 dark:text-zinc-100 p-4 sm:p-6 space-y-6">

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-lg sm:text-xl font-bold tracking-tight text-gray-900 dark:text-white">
            📉 Loss Pattern Insights
          </h1>
          <p className="text-xs text-gray-500 dark:text-zinc-500 mt-0.5">
            AI-powered loss analysis · 7 dimensions · Nemotron reasoning mode
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] bg-rose-500/20 text-rose-500 dark:text-rose-400 border border-rose-500/30 px-2.5 py-1 rounded-full font-mono uppercase tracking-wider">
            ADMIN ONLY
          </span>
          <AutoRefresh intervalSeconds={60} />
          <form action={logoutAction}>
            <button type="submit" className="text-[11px] text-gray-500 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300 border border-gray-200 dark:border-zinc-800 hover:border-gray-300 dark:hover:border-zinc-700 px-3 py-1.5 rounded-lg transition-colors bg-white dark:bg-transparent">
              Sign out
            </button>
          </form>
        </div>
      </div>

      {/* Nav */}
      <AdminNav />

      {totalResolved === 0 ? (
        <div className="rounded-xl border border-zinc-700 bg-zinc-900/60 px-5 py-8 text-center">
          <p className="text-sm text-zinc-400">No resolved trades in the log yet.</p>
          <p className="text-xs text-zinc-600 mt-1">Trade results will appear here once LIVE or GHOST trades are resolved.</p>
        </div>
      ) : (
        <LossPatternsClient
          overall={overall}
          byHour={byHour}
          bySymbol={bySymbol}
          byMode={byMode}
          byDirection={byDirection}
          byDuration={byDuration}
          byErBucket={byErSorted}
          byNoise={byNoise}
        />
      )}
    </div>
  );
}
