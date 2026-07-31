import { db } from '@workspace/db';
import { tradeLogsTable } from '@workspace/db/schema';
import { eq, and, desc, count } from 'drizzle-orm';
import { AdminLoginForm } from '../quant/login-form';
import { isAdminAuthorized } from '../quant/admin-auth';
import { logoutAction } from '../quant/actions';
import { AdminNav } from '../admin-nav';
import { AutoRefresh } from '../auto-refresh';
import { getSymbolDisplayName } from '@/lib/active-symbols-display-names';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

type ExType = 'ALL' | 'LIVE' | 'GHOST';
type Dir    = 'ALL' | 'CALL' | 'PUT';
type Mode   = 'ALL' | 'SNIPER' | 'BALANCED' | 'AGGRESSIVE';
type Status = 'ALL' | 'WIN' | 'LOSS' | 'PENDING';

function directionLabel(d: string) {
  return d === 'CALL'
    ? <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-bold">↑ CALL</span>
    : <span className="inline-flex items-center gap-1 text-rose-600 dark:text-rose-400 font-bold">↓ PUT</span>;
}

function statusBadge(s: string) {
  if (s === 'WIN')     return <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 font-bold text-[10px] uppercase tracking-wider">WIN</span>;
  if (s === 'LOSS')    return <span className="px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-600 dark:text-rose-400 font-bold text-[10px] uppercase tracking-wider">LOSS</span>;
  return <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 font-bold text-[10px] uppercase tracking-wider">PENDING</span>;
}

function modeBadge(m: string) {
  if (m === 'SNIPER')     return <span className="text-[10px] text-violet-600 dark:text-violet-400 font-semibold">🎯 Sniper</span>;
  if (m === 'BALANCED')   return <span className="text-[10px] text-blue-600 dark:text-blue-400 font-semibold">⚖️ Balanced</span>;
  if (m === 'AGGRESSIVE') return <span className="text-[10px] text-amber-600 dark:text-amber-400 font-semibold">⚡ Aggressive</span>;
  return <span className="text-[10px] text-gray-400">{m}</span>;
}

function typeBadge(t: string) {
  return t === 'LIVE'
    ? <span className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 text-[10px] font-mono font-bold">LIVE</span>
    : <span className="px-1.5 py-0.5 rounded bg-zinc-500/10 text-zinc-600 dark:text-zinc-400 text-[10px] font-mono font-bold">GHOST</span>;
}

function formatTime(d: Date) {
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function filterHref(params: Record<string, string>, key: string, val: string) {
  const next = { ...params, [key]: val };
  const qs = Object.entries(next).filter(([, v]) => v !== 'ALL').map(([k, v]) => `${k}=${v}`).join('&');
  return `/admin/trades${qs ? `?${qs}` : ''}`;
}

function FilterChip({ label, active, href }: { label: string; active: boolean; href: string }) {
  return (
    <Link
      href={href}
      className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-all whitespace-nowrap ${
        active
          ? 'bg-violet-600 text-white shadow-sm'
          : 'bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-zinc-400 hover:bg-gray-200 dark:hover:bg-zinc-700'
      }`}
    >
      {label}
    </Link>
  );
}

export default async function TradesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  if (!await isAdminAuthorized()) return <AdminLoginForm />;

  const sp = await searchParams;
  const exType = (sp.type  ?? 'ALL') as ExType;
  const dir    = (sp.dir   ?? 'ALL') as Dir;
  const mode   = (sp.mode  ?? 'ALL') as Mode;
  const status = (sp.status ?? 'ALL') as Status;

  const conditions = [];
  if (exType !== 'ALL') conditions.push(eq(tradeLogsTable.executionType, exType as 'LIVE' | 'GHOST'));
  if (dir    !== 'ALL') conditions.push(eq(tradeLogsTable.direction, dir as 'CALL' | 'PUT'));
  if (mode   !== 'ALL') conditions.push(eq(tradeLogsTable.effectiveMode, mode as 'SNIPER' | 'BALANCED' | 'AGGRESSIVE'));
  if (status !== 'ALL') conditions.push(eq(tradeLogsTable.status, status as 'WIN' | 'LOSS' | 'PENDING'));

  let trades: (typeof tradeLogsTable.$inferSelect)[];
  let totals: { status: string; n: number }[];

  try {
    [trades, totals] = await Promise.all([
      db.select().from(tradeLogsTable)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(tradeLogsTable.createdAt))
        .limit(150),
      db.select({ status: tradeLogsTable.status, n: count() })
        .from(tradeLogsTable)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .groupBy(tradeLogsTable.status),
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

  const wins     = Number(totals.find(r => r.status === 'WIN')?.n  ?? 0);
  const losses   = Number(totals.find(r => r.status === 'LOSS')?.n ?? 0);
  const pending  = Number(totals.find(r => r.status === 'PENDING')?.n ?? 0);
  const resolved = wins + losses;
  const winRate  = resolved > 0 ? (wins / resolved) * 100 : null;

  const params = { type: exType, dir, mode, status };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-[#0a0a0f] text-gray-900 dark:text-zinc-100 p-4 sm:p-6 space-y-5">

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-lg sm:text-xl font-bold tracking-tight text-gray-900 dark:text-white">📋 Trade Log</h1>
          <p className="text-xs text-gray-500 dark:text-zinc-500 mt-0.5">All LIVE & GHOST trades — filterable, live-refreshed</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] bg-rose-500/20 text-rose-500 dark:text-rose-400 border border-rose-500/30 px-2.5 py-1 rounded-full font-mono uppercase tracking-wider">ADMIN ONLY</span>
          <AutoRefresh intervalSeconds={30} />
          <form action={logoutAction}>
            <button type="submit" className="text-[11px] text-gray-500 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300 border border-gray-200 dark:border-zinc-800 hover:border-gray-300 dark:hover:border-zinc-700 px-3 py-1.5 rounded-lg transition-colors bg-white dark:bg-transparent">
              Sign out
            </button>
          </form>
        </div>
      </div>

      <AdminNav />

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 p-3 sm:p-4 space-y-1">
          <p className="text-[10px] text-gray-500 dark:text-zinc-500 uppercase tracking-widest font-semibold">Win Rate</p>
          <p className={`text-xl sm:text-2xl font-bold tabular-nums ${winRate == null ? 'text-gray-400' : winRate >= 55 ? 'text-emerald-500 dark:text-emerald-400' : winRate >= 50 ? 'text-amber-500 dark:text-amber-400' : 'text-rose-500 dark:text-rose-400'}`}>
            {winRate != null ? `${winRate.toFixed(1)}%` : '—'}
          </p>
          <p className="text-[10px] text-gray-400 dark:text-zinc-500">{resolved} resolved</p>
        </div>
        <div className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 p-3 sm:p-4 space-y-1">
          <p className="text-[10px] text-gray-500 dark:text-zinc-500 uppercase tracking-widest font-semibold">Wins</p>
          <p className="text-xl sm:text-2xl font-bold tabular-nums text-emerald-500 dark:text-emerald-400">{wins}</p>
        </div>
        <div className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 p-3 sm:p-4 space-y-1">
          <p className="text-[10px] text-gray-500 dark:text-zinc-500 uppercase tracking-widest font-semibold">Losses</p>
          <p className="text-xl sm:text-2xl font-bold tabular-nums text-rose-500 dark:text-rose-400">{losses}</p>
        </div>
        <div className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 p-3 sm:p-4 space-y-1">
          <p className="text-[10px] text-gray-500 dark:text-zinc-500 uppercase tracking-widest font-semibold">Pending</p>
          <p className="text-xl sm:text-2xl font-bold tabular-nums text-amber-500 dark:text-amber-400">{pending}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 px-4 py-3 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] text-gray-400 dark:text-zinc-500 uppercase tracking-widest font-semibold w-12">Type</span>
          {(['ALL', 'LIVE', 'GHOST'] as ExType[]).map(v => (
            <FilterChip key={v} label={v} active={exType === v} href={filterHref(params, 'type', v)} />
          ))}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] text-gray-400 dark:text-zinc-500 uppercase tracking-widest font-semibold w-12">Dir</span>
          {(['ALL', 'CALL', 'PUT'] as Dir[]).map(v => (
            <FilterChip key={v} label={v} active={dir === v} href={filterHref(params, 'dir', v)} />
          ))}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] text-gray-400 dark:text-zinc-500 uppercase tracking-widest font-semibold w-12">Mode</span>
          {(['ALL', 'SNIPER', 'BALANCED', 'AGGRESSIVE'] as Mode[]).map(v => (
            <FilterChip key={v} label={v === 'ALL' ? 'ALL' : v === 'SNIPER' ? '🎯 Sniper' : v === 'BALANCED' ? '⚖️ Balanced' : '⚡ Aggressive'} active={mode === v} href={filterHref(params, 'mode', v)} />
          ))}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] text-gray-400 dark:text-zinc-500 uppercase tracking-widest font-semibold w-12">Status</span>
          {(['ALL', 'WIN', 'LOSS', 'PENDING'] as Status[]).map(v => (
            <FilterChip key={v} label={v} active={status === v} href={filterHref(params, 'status', v)} />
          ))}
        </div>
      </div>

      {/* Trade table */}
      <div className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 overflow-hidden">
        <div className="px-4 sm:px-5 py-3 border-b border-gray-100 dark:border-zinc-800 flex items-center justify-between">
          <p className="text-xs font-semibold text-gray-700 dark:text-zinc-300">
            {trades.length} trade{trades.length !== 1 ? 's' : ''}{trades.length === 150 ? ' (capped at 150 — use filters to narrow)' : ''}
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[700px]">
            <thead>
              <tr className="border-b border-gray-100 dark:border-zinc-800 text-gray-400 dark:text-zinc-500 text-[10px] uppercase tracking-widest">
                <th className="px-4 py-2.5 text-left">#</th>
                <th className="px-4 py-2.5 text-left">Time</th>
                <th className="px-4 py-2.5 text-left">Type</th>
                <th className="px-4 py-2.5 text-left">Symbol</th>
                <th className="px-4 py-2.5 text-left">Direction</th>
                <th className="px-4 py-2.5 text-left">Mode</th>
                <th className="px-4 py-2.5 text-right">ER</th>
                <th className="px-4 py-2.5 text-right">Z-Score</th>
                <th className="px-4 py-2.5 text-right">Duration</th>
                <th className="px-4 py-2.5 text-right">Stake</th>
                <th className="px-4 py-2.5 text-center">Status</th>
              </tr>
            </thead>
            <tbody>
              {trades.length === 0 && (
                <tr>
                  <td colSpan={11} className="px-4 py-12 text-center text-gray-400 dark:text-zinc-600">
                    No trades match the current filters.
                  </td>
                </tr>
              )}
              {trades.map((t) => {
                const er = parseFloat(t.noiseAtEntry);
                const zs = parseFloat(t.zScoreAtEntry);
                const erColor = er >= 0.6 ? 'text-emerald-600 dark:text-emerald-400' : er >= 0.4 ? 'text-amber-600 dark:text-amber-400' : 'text-rose-600 dark:text-rose-400';
                const rowBg = t.status === 'WIN' ? 'hover:bg-emerald-50 dark:hover:bg-emerald-950/20' : t.status === 'LOSS' ? 'hover:bg-rose-50 dark:hover:bg-rose-950/20' : 'hover:bg-gray-50 dark:hover:bg-zinc-800/20';
                return (
                  <tr key={t.id} className={`border-b border-gray-50 dark:border-zinc-800/50 transition-colors ${rowBg}`}>
                    <td className="px-4 py-2.5 font-mono text-gray-400 dark:text-zinc-600 text-[10px]">#{t.id}</td>
                    <td className="px-4 py-2.5 font-mono text-gray-600 dark:text-zinc-400 text-[10px] whitespace-nowrap">
                      {formatTime(t.createdAt)}
                    </td>
                    <td className="px-4 py-2.5">{typeBadge(t.executionType)}</td>
                    <td className="px-4 py-2.5 font-semibold text-gray-800 dark:text-zinc-200 whitespace-nowrap">
                      {getSymbolDisplayName(t.symbol)}
                    </td>
                    <td className="px-4 py-2.5">{directionLabel(t.direction)}</td>
                    <td className="px-4 py-2.5">{modeBadge(t.effectiveMode)}</td>
                    <td className={`px-4 py-2.5 text-right font-mono font-bold tabular-nums ${erColor}`}>
                      {er.toFixed(4)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-gray-700 dark:text-zinc-300">
                      {zs >= 0 ? '+' : ''}{zs.toFixed(2)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-gray-600 dark:text-zinc-400">
                      {t.durationTarget}{t.durationUnit}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-gray-600 dark:text-zinc-400">
                      {t.stake ? `$${parseFloat(t.stake).toFixed(2)}` : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-center">{statusBadge(t.status)}</td>
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
