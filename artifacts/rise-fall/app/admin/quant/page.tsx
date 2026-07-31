import { db } from '@workspace/db';
import { tradeLogsTable, systemSettingsTable } from '@workspace/db/schema';
import { eq, and, ne, desc, avg, count, sql } from 'drizzle-orm';
import { DERIV_PAYOUT_RATE } from '@/lib/trading-config';
import { AdminLoginForm } from './login-form';
import { isAdminAuthorized } from './admin-auth';
import { logoutAction } from './actions';
import { AdminNav } from '../admin-nav';
import { AutoRefresh } from '../auto-refresh';
import { getSymbolDisplayName } from '@/lib/active-symbols-display-names';

export const dynamic = 'force-dynamic';

const ML_TARGET = parseInt(process.env.ML_DATASET_TARGET ?? '5000', 10);

function fmt(n: number | null | undefined, decimals = 2) {
  if (n == null) return '—';
  return n.toFixed(decimals);
}

function erColor(er: number, trending = 0.65, ranging = 0.45) {
  if (er >= trending) return 'text-emerald-400';
  if (er < ranging) return 'text-rose-400';
  return 'text-blue-400';
}

export default async function QuantAdminPage() {

  if (!await isAdminAuthorized()) {
    return <AdminLoginForm />;
  }

  let totalRows: { total: number }[];
  let resolvedRows: { status: string; n: number }[];
  let erByOutcome: { status: string; avgNoise: string | null; avgZScore: unknown; n: number }[];
  let hypotheticalPnl: { status: string; stake: string | null }[];
  let recentGhosts: (typeof tradeLogsTable.$inferSelect)[];
  let liveTotalRows: { total: number }[];
  let liveResolvedRows: { status: string; n: number }[];
  let recentLive: (typeof tradeLogsTable.$inferSelect)[];
  let dbSettingsRows: (typeof systemSettingsTable.$inferSelect)[];

  try {
    [
      totalRows,
      resolvedRows,
      erByOutcome,
      hypotheticalPnl,
      recentGhosts,
      liveTotalRows,
      liveResolvedRows,
      recentLive,
      dbSettingsRows,
    ] = await Promise.all([
      db.select({ total: count() }).from(tradeLogsTable).where(eq(tradeLogsTable.executionType, 'GHOST')),
      db.select({ status: tradeLogsTable.status, n: count() }).from(tradeLogsTable).where(and(eq(tradeLogsTable.executionType, 'GHOST'), ne(tradeLogsTable.status, 'PENDING'))).groupBy(tradeLogsTable.status),
      db.select({ status: tradeLogsTable.status, avgNoise: avg(tradeLogsTable.noiseAtEntry), avgZScore: avg(sql`ABS(${tradeLogsTable.zScoreAtEntry})`), n: count() }).from(tradeLogsTable).where(and(eq(tradeLogsTable.executionType, 'GHOST'), ne(tradeLogsTable.status, 'PENDING'))).groupBy(tradeLogsTable.status),
      db.select({ status: tradeLogsTable.status, stake: tradeLogsTable.stake }).from(tradeLogsTable).where(and(eq(tradeLogsTable.executionType, 'GHOST'), ne(tradeLogsTable.status, 'PENDING'))),
      db.select().from(tradeLogsTable).where(eq(tradeLogsTable.executionType, 'GHOST')).orderBy(desc(tradeLogsTable.createdAt)).limit(50),
      db.select({ total: count() }).from(tradeLogsTable).where(eq(tradeLogsTable.executionType, 'LIVE')),
      db.select({ status: tradeLogsTable.status, n: count() }).from(tradeLogsTable).where(and(eq(tradeLogsTable.executionType, 'LIVE'), ne(tradeLogsTable.status, 'PENDING'))).groupBy(tradeLogsTable.status),
      db.select().from(tradeLogsTable).where(eq(tradeLogsTable.executionType, 'LIVE')).orderBy(desc(tradeLogsTable.createdAt)).limit(50),
      db.select().from(systemSettingsTable).limit(1),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const cause = err instanceof Error ? (err as { cause?: unknown }).cause : undefined;
    const causeMsg = cause instanceof Error ? cause.message : '';
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-[#0a0a0f] p-6">
        <AdminNav />
        <div className="max-w-xl mx-auto py-16 text-center space-y-4">
          <div className="text-4xl">🗄️</div>
          <h2 className="text-lg font-bold text-red-600 dark:text-red-400">Database not connected</h2>
          <p className="text-sm text-gray-600 dark:text-zinc-400">
            Add <code className="bg-gray-100 dark:bg-zinc-800 px-1 rounded font-mono text-xs">NEON_DATABASE_URL</code> to your Render environment variables (pointing to the Neon PostgreSQL instance) and redeploy.
          </p>
          {causeMsg && (
            <pre className="text-left text-[10px] bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 rounded-lg p-3 overflow-auto text-red-700 dark:text-red-400 whitespace-pre-wrap break-all">{causeMsg}</pre>
          )}
          <pre className="text-left text-[10px] bg-gray-100 dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 rounded-lg p-3 overflow-auto text-gray-500 dark:text-zinc-400 whitespace-pre-wrap break-all">{msg}</pre>
        </div>
      </div>
    );
  }

  const totalGhosts = Number(totalRows[0]?.total ?? 0);
  const winRow = resolvedRows.find(r => r.status === 'WIN');
  const lossRow = resolvedRows.find(r => r.status === 'LOSS');
  const totalResolved = Number(winRow?.n ?? 0) + Number(lossRow?.n ?? 0);
  const ghostWinRate = totalResolved > 0 ? (Number(winRow?.n ?? 0) / totalResolved) * 100 : null;
  const hypotheticalTotal = hypotheticalPnl.reduce((sum, row) => {
    const stake = parseFloat(row.stake ?? '1');
    return sum + (row.status === 'WIN' ? stake * DERIV_PAYOUT_RATE : -stake);
  }, 0);
  const erWin = erByOutcome.find(r => r.status === 'WIN');
  const erLoss = erByOutcome.find(r => r.status === 'LOSS');
  const avgErWin = erWin?.avgNoise != null ? parseFloat(erWin.avgNoise) : null;
  const avgErLoss = erLoss?.avgNoise != null ? parseFloat(erLoss.avgNoise) : null;
  const avgZWin = erWin?.avgZScore != null ? parseFloat(String(erWin.avgZScore)) : null;
  const avgZLoss = erLoss?.avgZScore != null ? parseFloat(String(erLoss.avgZScore)) : null;
  const dbSettings = dbSettingsRows[0] ?? null;
  const SNIPER_NOISE_MIN = dbSettings ? parseFloat(String(dbSettings.sniperPutErMin)) : 0.60;
  const erTrending = dbSettings ? parseFloat(String(dbSettings.autoErTrending)) : 0.65;
  const erRanging  = dbSettings ? parseFloat(String(dbSettings.autoErRanging))  : 0.45;
  const calibrationHint = avgErWin != null
    ? avgErWin > SNIPER_NOISE_MIN
      ? `Ghost wins avg ER ${avgErWin.toFixed(3)} > SNIPER PUT gate ${SNIPER_NOISE_MIN.toFixed(2)} → gate may be over-filtering`
      : `Ghost wins avg ER ${avgErWin.toFixed(3)} < SNIPER PUT gate ${SNIPER_NOISE_MIN.toFixed(2)} → gate is correctly positioned`
    : null;

  const totalLive = Number(liveTotalRows[0]?.total ?? 0);
  const liveWinRow = liveResolvedRows.find(r => r.status === 'WIN');
  const liveLossRow = liveResolvedRows.find(r => r.status === 'LOSS');
  const totalLiveResolved = Number(liveWinRow?.n ?? 0) + Number(liveLossRow?.n ?? 0);
  const liveWinRate = totalLiveResolved > 0 ? (Number(liveWinRow?.n ?? 0) / totalLiveResolved) * 100 : null;
  const totalDataset = totalLive + totalGhosts;
  const datasetPct = Math.min((totalDataset / ML_TARGET) * 100, 100);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-[#0a0a0f] text-gray-900 dark:text-zinc-100 p-4 sm:p-6 space-y-6">

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-lg sm:text-xl font-bold tracking-tight text-gray-900 dark:text-white">
            ⚗️ Quant Admin Terminal
          </h1>
          <p className="text-xs text-gray-500 dark:text-zinc-500 mt-0.5">Shadow Execution Analytics · Live vs Ghost Cross-Reference</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] bg-rose-500/20 text-rose-500 dark:text-rose-400 border border-rose-500/30 px-2.5 py-1 rounded-full font-mono uppercase tracking-wider">
            ADMIN ONLY
          </span>
          <AutoRefresh intervalSeconds={30} />
          <form action={logoutAction}>
            <button
              type="submit"
              className="text-[11px] text-gray-500 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300 border border-gray-200 dark:border-zinc-800 hover:border-gray-300 dark:hover:border-zinc-700 px-3 py-1.5 rounded-lg transition-colors bg-white dark:bg-transparent"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>

      {/* Nav */}
      <AdminNav />

      {/* Ghost section label */}
      <SectionLabel icon="👻" title="Ghost Metrics" subtitle="Trades suppressed by your gates — selection bias signal" />

      {/* Ghost cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
        <MetricCard label="Total Ghosts Suppressed" value={String(totalGhosts)} sub={`${totalResolved} resolved · ${totalGhosts - totalResolved} pending`} color="text-violet-500 dark:text-violet-400" />
        <MetricCard
          label="Ghost Win Rate"
          value={ghostWinRate != null ? `${ghostWinRate.toFixed(1)}%` : '—'}
          sub={ghostWinRate != null ? ghostWinRate >= 50 ? 'Gates may be over-suppressing' : 'Gates are protective' : 'Awaiting resolved trades'}
          color={ghostWinRate != null ? (ghostWinRate >= 50 ? 'text-amber-500 dark:text-amber-400' : 'text-emerald-500 dark:text-emerald-400') : 'text-gray-400 dark:text-zinc-500'}
        />
        <MetricCard
          label="Hypothetical Missed P&L"
          value={`${hypotheticalTotal >= 0 ? '+' : ''}$${hypotheticalTotal.toFixed(2)}`}
          sub="@ 85% Deriv payout estimate"
          color={hypotheticalTotal >= 0 ? 'text-emerald-500 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}
        />
      </div>

      {/* Live section label */}
      <SectionLabel icon="💰" title="Live Execution Metrics" subtitle="Real money trades — your ultimate profitability signal" />

      {/* Live cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
        <MetricCard label="Live Trades Logged" value={String(totalLive)} sub={`${totalLiveResolved} resolved · ${totalLive - totalLiveResolved} pending`} color="text-sky-500 dark:text-sky-400" />
        <MetricCard
          label="Live Win Rate"
          value={liveWinRate != null ? `${liveWinRate.toFixed(1)}%` : '—'}
          sub={liveWinRate != null
            ? liveWinRate >= 55 ? 'Above breakeven — strategy is profitable'
            : liveWinRate >= 50 ? 'Near breakeven — monitor closely'
            : 'Below breakeven — review gate config'
            : 'Awaiting resolved live trades'}
          color={liveWinRate != null
            ? liveWinRate >= 55 ? 'text-emerald-500 dark:text-emerald-400'
            : liveWinRate >= 50 ? 'text-amber-500 dark:text-amber-400'
            : 'text-rose-500 dark:text-rose-400'
            : 'text-gray-400 dark:text-zinc-500'}
        />
        {/* ML Dataset progress card */}
        <div className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 p-4 sm:p-5 space-y-3">
          <p className="text-[10px] text-gray-500 dark:text-zinc-500 uppercase tracking-widest font-semibold">ML Dataset Size</p>
          <p className="text-2xl sm:text-3xl font-bold tabular-nums text-amber-500 dark:text-amber-400">
            {totalDataset.toLocaleString()}
            <span className="text-sm text-gray-400 dark:text-zinc-500 font-normal ml-1">/ {ML_TARGET.toLocaleString()}</span>
          </p>
          <div className="space-y-1.5">
            <div className="flex justify-between text-[10px] text-gray-400 dark:text-zinc-500">
              <span>{totalLive} live · {totalGhosts} ghost</span>
              <span>{datasetPct.toFixed(1)}% to ML-ready</span>
            </div>
            <div className="h-2 rounded-full bg-gray-200 dark:bg-zinc-800 overflow-hidden">
              <div className="h-full rounded-full bg-gradient-to-r from-amber-500 to-amber-300 transition-all" style={{ width: `${datasetPct}%` }} />
            </div>
            <p className="text-[10px] text-gray-400 dark:text-zinc-600">
              {totalDataset >= ML_TARGET ? '✓ XGBoost-ready' : totalDataset >= 1000 ? `${(ML_TARGET - totalDataset).toLocaleString()} rows to sweet spot` : `${(1000 - Math.min(totalDataset, 1000)).toLocaleString()} rows to statistical minimum`}
            </p>
          </div>
        </div>
      </div>

      {/* Selection Bias */}
      <div className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 p-4 sm:p-5 space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Ghost Selection Bias Analysis</h2>
          <p className="text-xs text-gray-500 dark:text-zinc-500 mt-0.5">Average Efficiency Ratio (ER) at entry for ghost WINS vs LOSSES.</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-4 space-y-3">
            <p className="text-[10px] font-semibold text-emerald-500 dark:text-emerald-400 uppercase tracking-widest">Ghost WINS ({erWin?.n ?? 0})</p>
            <div className="space-y-2">
              <BiasRow label="Avg ER at Entry" value={fmt(avgErWin, 4)} hint={avgErWin != null ? erColor(avgErWin, erTrending, erRanging) : ''} />
              <BiasRow label="Avg |Z-Score| at Entry" value={fmt(avgZWin, 3)} hint="text-gray-700 dark:text-zinc-300" />
            </div>
            {avgErWin != null && (
              <p className="text-[11px] text-gray-600 dark:text-zinc-400 border-t border-emerald-500/15 pt-2">
                Vetoed trades avg ER <span className={`font-bold ${erColor(avgErWin, erTrending, erRanging)}`}>{avgErWin.toFixed(4)}</span>.{' '}
                {avgErWin < SNIPER_NOISE_MIN ? `Below SNIPER gate (${SNIPER_NOISE_MIN}) — correctly suppressed.` : `Above SNIPER gate (${SNIPER_NOISE_MIN}) — gate may be over-filtering.`}
              </p>
            )}
          </div>
          <div className="rounded-lg border border-rose-500/25 bg-rose-500/5 p-4 space-y-3">
            <p className="text-[10px] font-semibold text-rose-500 dark:text-rose-400 uppercase tracking-widest">Ghost LOSSES ({erLoss?.n ?? 0})</p>
            <div className="space-y-2">
              <BiasRow label="Avg ER at Entry" value={fmt(avgErLoss, 4)} hint={avgErLoss != null ? erColor(avgErLoss, erTrending, erRanging) : ''} />
              <BiasRow label="Avg |Z-Score| at Entry" value={fmt(avgZLoss, 3)} hint="text-gray-700 dark:text-zinc-300" />
            </div>
            {avgErLoss != null && (
              <p className="text-[11px] text-gray-600 dark:text-zinc-400 border-t border-rose-500/15 pt-2">
                Suppressed losers avg ER <span className={`font-bold ${erColor(avgErLoss, erTrending, erRanging)}`}>{avgErLoss.toFixed(4)}</span>.{' '}
                {avgErLoss < SNIPER_NOISE_MIN ? `Below gate — suppression correct (saved capital).` : `Above gate — correctly blocked despite higher ER.`}
              </p>
            )}
          </div>
        </div>
        {calibrationHint && (
          <div className="rounded-lg bg-amber-500/10 border border-amber-500/25 px-4 py-3">
            <p className="text-[11px] text-amber-600 dark:text-amber-300"><span className="font-bold">Gate Calibration Signal: </span>{calibrationHint}</p>
            <p className="text-[10px] text-gray-500 dark:text-zinc-500 mt-1">
              {dbSettings
                ? `SNIPER call≥${parseFloat(String(dbSettings.sniperCallErMin)).toFixed(2)}/put≥${parseFloat(String(dbSettings.sniperPutErMin)).toFixed(2)} · BALANCED call≥${parseFloat(String(dbSettings.balancedCallErMin)).toFixed(2)}/put≥${parseFloat(String(dbSettings.balancedPutErMin)).toFixed(2)} · AGGRESSIVE call≥${parseFloat(String(dbSettings.aggressiveCallErMin)).toFixed(2)}/put≥${parseFloat(String(dbSettings.aggressivePutErMin)).toFixed(2)}`
                : 'SNIPER call≥0.00/put≥0.60 · BALANCED call≥0.10/put≥0.40 · AGGRESSIVE call≥0.20/put≥0.30'
              }
            </p>
          </div>
        )}
      </div>

      {/* Recent Live table */}
      <div className="rounded-xl border border-sky-500/20 bg-white dark:bg-zinc-900/60 overflow-hidden">
        <div className="px-4 sm:px-5 py-4 border-b border-sky-500/20 flex items-center justify-between bg-sky-500/5">
          <div>
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Recent Live Executions</h2>
            <p className="text-[10px] text-gray-500 dark:text-zinc-500 mt-0.5">Real capital — last 50 trades</p>
          </div>
          <div className="flex items-center gap-2">
            {liveWinRate != null && (
              <span className={`text-[10px] font-bold px-2 py-1 rounded-full border hidden sm:block ${liveWinRate >= 55 ? 'bg-emerald-500/15 text-emerald-500 dark:text-emerald-400 border-emerald-500/30' : liveWinRate >= 50 ? 'bg-amber-500/15 text-amber-500 dark:text-amber-400 border-amber-500/30' : 'bg-rose-500/15 text-rose-500 dark:text-rose-400 border-rose-500/30'}`}>
                {liveWinRate.toFixed(1)}% WIN RATE
              </span>
            )}
            <span className="text-[10px] text-gray-500 dark:text-zinc-500">{recentLive.length} rows</span>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[600px]">
            <thead>
              <tr className="border-b border-gray-100 dark:border-zinc-800 text-gray-400 dark:text-zinc-500 text-[10px] uppercase tracking-widest">
                <th className="px-4 py-2.5 text-left">Time</th>
                <th className="px-4 py-2.5 text-left">Symbol</th>
                <th className="px-4 py-2.5 text-left">Dir</th>
                <th className="px-4 py-2.5 text-left">Dur</th>
                <th className="px-4 py-2.5 text-right">Entry</th>
                <th className="px-4 py-2.5 text-right">Exit</th>
                <th className="px-4 py-2.5 text-right">Stake</th>
                <th className="px-4 py-2.5 text-right">P&L</th>
                <th className="px-4 py-2.5 text-center">Result</th>
              </tr>
            </thead>
            <tbody>
              {recentLive.length === 0 && (
                <tr><td colSpan={9} className="px-4 py-8 text-center text-gray-400 dark:text-zinc-600">No live trades yet. Real-capital executions appear here.</td></tr>
              )}
              {recentLive.map((row) => {
                const pnl = row.pnl != null ? parseFloat(row.pnl) : null;
                return (
                  <tr key={row.id} className="border-b border-gray-50 dark:border-zinc-800/60 hover:bg-gray-50 dark:hover:bg-zinc-800/30 transition-colors">
                    <td className="px-4 py-2.5 text-gray-400 dark:text-zinc-500 tabular-nums whitespace-nowrap">{row.createdAt.toISOString().replace('T', ' ').slice(0, 19)}</td>
                    <td className="px-4 py-2.5 text-gray-700 dark:text-zinc-300 text-[10px]" title={row.symbol}>{getSymbolDisplayName(row.symbol)}</td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold ${row.direction === 'CALL' ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-rose-500/15 text-rose-600 dark:text-rose-400'}`}>{row.direction}</span>
                    </td>
                    <td className="px-4 py-2.5 text-gray-600 dark:text-zinc-400 tabular-nums">{row.durationTarget}{row.durationUnit}</td>
                    <td className="px-4 py-2.5 text-right text-gray-700 dark:text-zinc-300 font-mono tabular-nums">{parseFloat(row.entryPrice).toFixed(4)}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-gray-600 dark:text-zinc-400">{row.exitPrice != null ? parseFloat(row.exitPrice).toFixed(4) : '—'}</td>
                    <td className="px-4 py-2.5 text-right text-gray-600 dark:text-zinc-400 tabular-nums">${parseFloat(row.stake ?? '1').toFixed(2)}</td>
                    <td className={`px-4 py-2.5 text-right tabular-nums font-mono font-bold ${pnl == null ? 'text-gray-300 dark:text-zinc-600' : pnl > 0 ? 'text-emerald-500 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400'}`}>
                      {pnl != null ? `${pnl > 0 ? '+' : ''}$${pnl.toFixed(2)}` : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      {row.status === 'PENDING' && <span className="text-[10px] text-gray-400 dark:text-zinc-500 bg-gray-100 dark:bg-zinc-800 px-2 py-0.5 rounded">PENDING</span>}
                      {row.status === 'WIN' && <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-500/15 px-2 py-0.5 rounded">WIN</span>}
                      {row.status === 'LOSS' && <span className="text-[10px] font-bold text-rose-600 dark:text-rose-400 bg-rose-500/15 px-2 py-0.5 rounded">LOSS</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Recent Ghost table */}
      <div className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 overflow-hidden">
        <div className="px-4 sm:px-5 py-4 border-b border-gray-100 dark:border-zinc-800 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Recent Ghost Trades</h2>
            <p className="text-[10px] text-gray-500 dark:text-zinc-500 mt-0.5">Suppressed signals — last 50</p>
          </div>
          <span className="text-[10px] text-gray-400 dark:text-zinc-500">{recentGhosts.length} rows</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[580px]">
            <thead>
              <tr className="border-b border-gray-100 dark:border-zinc-800 text-gray-400 dark:text-zinc-500 text-[10px] uppercase tracking-widest">
                <th className="px-4 py-2.5 text-left">Time</th>
                <th className="px-4 py-2.5 text-left">Symbol</th>
                <th className="px-4 py-2.5 text-left">Dir</th>
                <th className="px-4 py-2.5 text-left">Dur</th>
                <th className="px-4 py-2.5 text-left">Mode</th>
                <th className="px-4 py-2.5 text-right">ER</th>
                <th className="px-4 py-2.5 text-right">Z</th>
                <th className="px-4 py-2.5 text-right">Stake</th>
                <th className="px-4 py-2.5 text-center">Result</th>
              </tr>
            </thead>
            <tbody>
              {recentGhosts.length === 0 && (
                <tr><td colSpan={9} className="px-4 py-8 text-center text-gray-400 dark:text-zinc-600">No ghost trades yet.</td></tr>
              )}
              {recentGhosts.map((row) => {
                const er = parseFloat(row.noiseAtEntry);
                const z = parseFloat(row.zScoreAtEntry);
                return (
                  <tr key={row.id} className="border-b border-gray-50 dark:border-zinc-800/60 hover:bg-gray-50 dark:hover:bg-zinc-800/30 transition-colors">
                    <td className="px-4 py-2.5 text-gray-400 dark:text-zinc-500 tabular-nums whitespace-nowrap">{row.createdAt.toISOString().replace('T', ' ').slice(0, 19)}</td>
                    <td className="px-4 py-2.5 text-gray-700 dark:text-zinc-300 text-[10px]" title={row.symbol}>{getSymbolDisplayName(row.symbol)}</td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold ${row.direction === 'CALL' ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-rose-500/15 text-rose-600 dark:text-rose-400'}`}>{row.direction}</span>
                    </td>
                    <td className="px-4 py-2.5 text-gray-600 dark:text-zinc-400 tabular-nums">{row.durationTarget}{row.durationUnit}</td>
                    <td className="px-4 py-2.5">
                      <span className={`text-[10px] font-semibold ${row.effectiveMode === 'SNIPER' ? 'text-violet-500 dark:text-violet-400' : row.effectiveMode === 'AGGRESSIVE' ? 'text-orange-500 dark:text-orange-400' : 'text-blue-500 dark:text-blue-400'}`}>{row.effectiveMode}</span>
                    </td>
                    <td className={`px-4 py-2.5 text-right tabular-nums font-mono ${erColor(er, erTrending, erRanging)}`}>{er.toFixed(4)}</td>
                    <td className={`px-4 py-2.5 text-right tabular-nums font-mono ${Math.abs(z) > 1.5 ? 'text-amber-500 dark:text-amber-400' : 'text-gray-600 dark:text-zinc-400'}`}>{z >= 0 ? '+' : ''}{z.toFixed(3)}</td>
                    <td className="px-4 py-2.5 text-right text-gray-600 dark:text-zinc-400 tabular-nums">${parseFloat(row.stake ?? '1').toFixed(2)}</td>
                    <td className="px-4 py-2.5 text-center">
                      {row.status === 'PENDING' && <span className="text-[10px] text-gray-400 dark:text-zinc-500 bg-gray-100 dark:bg-zinc-800 px-2 py-0.5 rounded">PENDING</span>}
                      {row.status === 'WIN' && <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-500/15 px-2 py-0.5 rounded">WIN</span>}
                      {row.status === 'LOSS' && <span className="text-[10px] font-bold text-rose-600 dark:text-rose-400 bg-rose-500/15 px-2 py-0.5 rounded">LOSS</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function SectionLabel({ icon, title, subtitle }: { icon: string; title: string; subtitle: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-lg">{icon}</span>
      <div>
        <h2 className="text-sm font-bold text-gray-900 dark:text-white tracking-tight">{title}</h2>
        <p className="text-[10px] text-gray-500 dark:text-zinc-500">{subtitle}</p>
      </div>
      <div className="flex-1 h-px bg-gray-200 dark:bg-zinc-800 ml-2" />
    </div>
  );
}

function MetricCard({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 p-4 sm:p-5 space-y-1">
      <p className="text-[10px] text-gray-500 dark:text-zinc-500 uppercase tracking-widest font-semibold">{label}</p>
      <p className={`text-2xl sm:text-3xl font-bold tabular-nums ${color}`}>{value}</p>
      <p className="text-[11px] text-gray-500 dark:text-zinc-500">{sub}</p>
    </div>
  );
}

function BiasRow({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[11px] text-gray-500 dark:text-zinc-500">{label}</span>
      <span className={`text-sm font-bold tabular-nums font-mono ${hint}`}>{value}</span>
    </div>
  );
}
