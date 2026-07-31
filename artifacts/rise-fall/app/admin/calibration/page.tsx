import { db } from '@workspace/db';
import { tradeLogsTable } from '@workspace/db/schema';
import { eq, and, ne, count, sql } from 'drizzle-orm';
import { AdminLoginForm } from '../quant/login-form';
import { isAdminAuthorized } from '../quant/admin-auth';
import { logoutAction } from '../quant/actions';
import { AdminNav } from '../admin-nav';
import { AutoRefresh } from '../auto-refresh';
import CalibrationAISuggest from './calibration-client';
import RegimeSuggestClient from './regime-suggest-client';

export const dynamic = 'force-dynamic';

const BUCKETS = [
  { label: '0.00–0.10', min: 0,    max: 0.10 },
  { label: '0.10–0.20', min: 0.10, max: 0.20 },
  { label: '0.20–0.30', min: 0.20, max: 0.30 },
  { label: '0.30–0.40', min: 0.30, max: 0.40 },
  { label: '0.40–0.60', min: 0.40, max: 0.60 },
  { label: '0.60+',     min: 0.60, max: Infinity },
];

function getBucketLabel(er: number): string {
  return (BUCKETS.find(b => er >= b.min && er < b.max) ?? BUCKETS[BUCKETS.length - 1]).label;
}

type BucketRow = { label: string; total: number; wins: number; losses: number; winRate: number | null };

function buildBucketTable(rows: { er: number; status: string }[]): BucketRow[] {
  const map = new Map<string, { wins: number; losses: number }>();
  for (const b of BUCKETS) map.set(b.label, { wins: 0, losses: 0 });
  for (const r of rows) {
    const cell = map.get(getBucketLabel(r.er))!;
    if (r.status === 'WIN') cell.wins++;
    else if (r.status === 'LOSS') cell.losses++;
  }
  return BUCKETS.map((b) => {
    const cell = map.get(b.label)!;
    const total = cell.wins + cell.losses;
    return { label: b.label, total, wins: cell.wins, losses: cell.losses, winRate: total > 0 ? (cell.wins / total) * 100 : null };
  });
}

export default async function CalibrationPage() {

  if (!await isAdminAuthorized()) {
    return <AdminLoginForm />;
  }

  const [resolvedGhosts, dupeCheck] = await Promise.all([
    db.select({ noiseAtEntry: tradeLogsTable.noiseAtEntry, direction: tradeLogsTable.direction, status: tradeLogsTable.status })
      .from(tradeLogsTable)
      .where(and(eq(tradeLogsTable.executionType, 'GHOST'), ne(tradeLogsTable.status, 'PENDING'))),
    db.select({ dupeGroups: count() })
      .from(
        db.select({
          grp: sql<string>`date_trunc('second', ${tradeLogsTable.createdAt}) || '|' || ${tradeLogsTable.symbol}`.as('grp'),
          n: count().as('n'),
        })
        .from(tradeLogsTable)
        .where(eq(tradeLogsTable.executionType, 'GHOST'))
        .groupBy(sql`date_trunc('second', ${tradeLogsTable.createdAt})`, tradeLogsTable.symbol)
        .as('grouped')
      )
      .where(sql`grouped.n > 1`),
  ]);

  const allRows = resolvedGhosts.map(r => ({ er: parseFloat(r.noiseAtEntry), direction: r.direction, status: r.status }));
  const overallBuckets = buildBucketTable(allRows);
  const callBuckets    = buildBucketTable(allRows.filter(r => r.direction === 'CALL'));
  const putBuckets     = buildBucketTable(allRows.filter(r => r.direction === 'PUT'));
  const totalResolved  = allRows.length;
  const totalCall      = allRows.filter(r => r.direction === 'CALL').length;
  const totalPut       = allRows.filter(r => r.direction === 'PUT').length;
  const dupeGroupCount = Number(dupeCheck[0]?.dupeGroups ?? 0);
  const cliffBucket    = overallBuckets.find(b => b.winRate != null && b.winRate >= 50);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-[#0a0a0f] text-gray-900 dark:text-zinc-100 p-4 sm:p-6 space-y-6">

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-lg sm:text-xl font-bold tracking-tight text-gray-900 dark:text-white">
            🔬 Calibration Lab
          </h1>
          <p className="text-xs text-gray-500 dark:text-zinc-500 mt-0.5">ER Bucket Analysis · Gate Calibration · CALL vs PUT Asymmetry</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] bg-rose-500/20 text-rose-500 dark:text-rose-400 border border-rose-500/30 px-2.5 py-1 rounded-full font-mono uppercase tracking-wider">
            ADMIN ONLY
          </span>
          <AutoRefresh intervalSeconds={30} />
          <form action={logoutAction}>
            <button type="submit" className="text-[11px] text-gray-500 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300 border border-gray-200 dark:border-zinc-800 hover:border-gray-300 dark:hover:border-zinc-700 px-3 py-1.5 rounded-lg transition-colors bg-white dark:bg-transparent">
              Sign out
            </button>
          </form>
        </div>
      </div>

      {/* Nav */}
      <AdminNav />

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
        <MiniCard label="Resolved Ghosts" value={String(totalResolved)} color="text-violet-500 dark:text-violet-400" />
        <MiniCard label="CALL Trades" value={String(totalCall)} color="text-emerald-500 dark:text-emerald-400" />
        <MiniCard label="PUT Trades" value={String(totalPut)} color="text-rose-500 dark:text-rose-400" />
        <MiniCard
          label="Same-Second Dupes"
          value={String(dupeGroupCount)}
          color={dupeGroupCount > 0 ? 'text-amber-500 dark:text-amber-400' : 'text-emerald-500 dark:text-emerald-400'}
          sub={dupeGroupCount > 0 ? 'debounce needs tuning' : 'signals unique ✓'}
        />
      </div>

      {/* Cliff callout */}
      {cliffBucket ? (
        <div className="rounded-xl border border-violet-500/30 bg-violet-500/10 px-4 sm:px-5 py-4">
          <p className="text-sm font-bold text-violet-600 dark:text-violet-300">
            📍 Profitability Cliff Found: ER ≥ {cliffBucket.label.split('–')[0].replace('+', '')}
          </p>
          <p className="text-xs text-gray-600 dark:text-zinc-400 mt-1">
            Ghost trades in <span className="text-violet-600 dark:text-violet-300 font-semibold">{cliffBucket.label}</span> hit{' '}
            <span className="text-violet-600 dark:text-violet-300 font-semibold">{cliffBucket.winRate!.toFixed(1)}%</span> win rate
            ({cliffBucket.wins}W / {cliffBucket.losses}L). This is your data-driven gate floor.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-900/60 px-4 sm:px-5 py-4">
          <p className="text-sm text-gray-500 dark:text-zinc-400">
            No bucket has crossed 50% win rate yet. Collect more resolved trades to identify the profitability cliff.
          </p>
        </div>
      )}

      {/* AI Suggest — static ER gate calibration */}
      <CalibrationAISuggest
        overallBuckets={overallBuckets}
        callBuckets={callBuckets}
        putBuckets={putBuckets}
      />

      {/* Regime-Adaptive Threshold Suggestions */}
      <RegimeSuggestClient />

      {/* Overall bucket table */}
      <BucketSection title="Overall ER Bucket Analysis" subtitle="All resolved GHOST trades — CALL + PUT combined" icon="📊" buckets={overallBuckets} total={totalResolved} />

      {/* Direction split */}
      <div>
        <div className="flex items-center gap-3 mb-5">
          <span className="text-lg">⚖️</span>
          <div>
            <h2 className="text-sm font-bold text-gray-900 dark:text-white">Asymmetric Direction Split</h2>
            <p className="text-xs text-gray-500 dark:text-zinc-500">If CALL and PUT have different cliffs, asymmetric thresholds are justified by data.</p>
          </div>
          <div className="flex-1 h-px bg-gray-200 dark:bg-zinc-800 ml-2 hidden sm:block" />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
          <BucketSection title="CALL Trades Only" subtitle={`${totalCall} resolved CALL ghosts`} icon="📈" buckets={callBuckets} total={totalCall} accentColor="emerald" />
          <BucketSection title="PUT Trades Only" subtitle={`${totalPut} resolved PUT ghosts`} icon="📉" buckets={putBuckets} total={totalPut} accentColor="rose" />
        </div>
      </div>

      {/* Uniqueness note */}
      <div className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 px-4 sm:px-5 py-4 space-y-1">
        <p className="text-xs font-semibold text-gray-700 dark:text-zinc-300">🔍 Signal Uniqueness Check</p>
        <p className="text-xs text-gray-500 dark:text-zinc-500">
          Counts ghost entries where the same symbol logged more than once within the same second.
          {dupeGroupCount === 0
            ? ' No duplicates detected — debounce is working correctly.'
            : ` ${dupeGroupCount} same-second group(s) found. Consider tightening the debounce cooldown in use-autotrade.ts.`}
        </p>
      </div>
    </div>
  );
}

function MiniCard({ label, value, color, sub }: { label: string; value: string; color: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 p-3 sm:p-4 space-y-1">
      <p className="text-[10px] text-gray-500 dark:text-zinc-500 uppercase tracking-widest font-semibold">{label}</p>
      <p className={`text-xl sm:text-2xl font-bold tabular-nums ${color}`}>{value}</p>
      {sub && <p className="text-[10px] text-gray-400 dark:text-zinc-500">{sub}</p>}
    </div>
  );
}

function winRateColor(wr: number | null): string {
  if (wr == null) return 'text-gray-300 dark:text-zinc-600';
  if (wr >= 60) return 'text-emerald-500 dark:text-emerald-400';
  if (wr >= 50) return 'text-amber-500 dark:text-amber-400';
  return 'text-rose-500 dark:text-rose-400';
}

function BucketSection({ title, subtitle, icon, buckets, total, accentColor = 'violet' }: {
  title: string; subtitle: string; icon: string; buckets: BucketRow[]; total: number; accentColor?: 'violet' | 'emerald' | 'rose';
}) {
  const border = { violet: 'border-gray-200 dark:border-zinc-800', emerald: 'border-emerald-500/20', rose: 'border-rose-500/20' }[accentColor];
  const header = { violet: '', emerald: 'bg-emerald-500/5', rose: 'bg-rose-500/5' }[accentColor];
  return (
    <div className={`rounded-xl border ${border} bg-white dark:bg-zinc-900/60 overflow-hidden`}>
      <div className={`px-4 sm:px-5 py-4 border-b ${border} ${header}`}>
        <div className="flex items-center gap-2">
          <span>{icon}</span>
          <div>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{title}</h3>
            <p className="text-[10px] text-gray-500 dark:text-zinc-500">{subtitle}</p>
          </div>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs min-w-[400px]">
          <thead>
            <tr className="border-b border-gray-100 dark:border-zinc-800 text-gray-400 dark:text-zinc-500 text-[10px] uppercase tracking-widest">
              <th className="px-4 py-2.5 text-left">ER Range</th>
              <th className="px-4 py-2.5 text-right">Trades</th>
              <th className="px-4 py-2.5 text-right">Wins</th>
              <th className="px-4 py-2.5 text-right">Losses</th>
              <th className="px-4 py-2.5 text-right">Win Rate</th>
              <th className="px-4 py-2.5 text-right">Share</th>
            </tr>
          </thead>
          <tbody>
            {total === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400 dark:text-zinc-600">No resolved trades yet.</td></tr>}
            {buckets.map((row) => {
              const share = total > 0 ? (row.total / total) * 100 : 0;
              return (
                <tr key={row.label} className="border-b border-gray-50 dark:border-zinc-800/50 hover:bg-gray-50 dark:hover:bg-zinc-800/20 transition-colors">
                  <td className="px-4 py-3 font-mono text-gray-700 dark:text-zinc-300 text-[11px]">{row.label}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-600 dark:text-zinc-400">{row.total}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-emerald-600 dark:text-emerald-400 font-semibold">
                    {row.wins > 0 ? row.wins : <span className="text-gray-300 dark:text-zinc-700">0</span>}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-rose-600 dark:text-rose-400 font-semibold">
                    {row.losses > 0 ? row.losses : <span className="text-gray-300 dark:text-zinc-700">0</span>}
                  </td>
                  <td className={`px-4 py-3 text-right tabular-nums font-bold font-mono ${winRateColor(row.winRate)}`}>
                    {row.winRate != null ? `${row.winRate.toFixed(1)}%` : '—'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div className="w-12 sm:w-16 h-1.5 bg-gray-200 dark:bg-zinc-800 rounded-full overflow-hidden">
                        <div className="h-full rounded-full bg-violet-400/60 dark:bg-violet-500/60" style={{ width: `${share}%` }} />
                      </div>
                      <span className="text-gray-400 dark:text-zinc-600 tabular-nums text-[10px] w-7 text-right">{share.toFixed(0)}%</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
