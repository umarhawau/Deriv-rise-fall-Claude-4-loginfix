import { db } from '@workspace/db';
import { tradeLogsTable } from '@workspace/db/schema';
import { eq, ne, and, sql } from 'drizzle-orm';
import { AdminLoginForm } from '../quant/login-form';
import { isAdminAuthorized } from '../quant/admin-auth';
import { AdminNav } from '../admin-nav';
import { AutoRefresh } from '../auto-refresh';
import { getSymbolDisplayName } from '@/lib/active-symbols-display-names';
import { ExpiryClient, type BestExpiryRow, type ExpiryRow } from './expiry-client';
import { systemSettingsTable } from '@workspace/db/schema';

export const dynamic = 'force-dynamic';

function formatExpiry(target: number, unit: string): string {
  if (unit === 't') return `${target}t`;
  if (unit === 's') {
    if (target < 60) return `${target}s`;
    const mins = Math.floor(target / 60);
    const secs = target % 60;
    return secs === 0 ? `${mins}m` : `${mins}m${secs}s`;
  }
  if (unit === 'm') return `${target}m`;
  return `${target}${unit}`;
}

function expirySort(expiry: string): number {
  const tMatch = expiry.match(/^(\d+)t$/);
  if (tMatch) return parseInt(tMatch[1]) * 0.1;
  const sMatch = expiry.match(/^(\d+)s$/);
  if (sMatch) return parseInt(sMatch[1]);
  const mMatch = expiry.match(/^(\d+)m$/);
  if (mMatch) return parseInt(mMatch[1]) * 60;
  const mxsMatch = expiry.match(/^(\d+)m(\d+)s$/);
  if (mxsMatch) return parseInt(mxsMatch[1]) * 60 + parseInt(mxsMatch[2]);
  return 9999;
}

const FALLBACK_MIN_SAMPLE = 30;

type ExecFilter = 'ALL' | 'LIVE' | 'GHOST';

export default async function ExpiryAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {

  if (!await isAdminAuthorized()) {
    return <AdminLoginForm />;
  }

  const params = await searchParams;
  const execFilter: ExecFilter =
    params.type === 'LIVE' ? 'LIVE' :
    params.type === 'GHOST' ? 'GHOST' :
    'ALL';

  let MIN_SAMPLE = FALLBACK_MIN_SAMPLE;
  try {
    const sRows = await db.select({ expiryMinSample: systemSettingsTable.expiryMinSample }).from(systemSettingsTable).limit(1);
    if (sRows.length > 0 && sRows[0].expiryMinSample != null) {
      MIN_SAMPLE = Number(sRows[0].expiryMinSample);
    }
  } catch {
    // use fallback
  }

  type RawRow = {
    symbol: string;
    direction: string;
    durationTarget: number;
    durationUnit: string;
    total: number;
    wins: number;
  };

  let rows: RawRow[] = [];

  try {
    const conditions = [ne(tradeLogsTable.status, 'PENDING')];
    if (execFilter === 'LIVE')  conditions.push(eq(tradeLogsTable.executionType, 'LIVE'));
    if (execFilter === 'GHOST') conditions.push(eq(tradeLogsTable.executionType, 'GHOST'));

    const raw = await db
      .select({
        symbol: tradeLogsTable.symbol,
        direction: tradeLogsTable.direction,
        durationTarget: tradeLogsTable.durationTarget,
        durationUnit: tradeLogsTable.durationUnit,
        total: sql<number>`COUNT(*)::int`,
        wins: sql<number>`COUNT(*) FILTER (WHERE ${tradeLogsTable.status} = 'WIN')::int`,
      })
      .from(tradeLogsTable)
      .where(and(...conditions))
      .groupBy(
        tradeLogsTable.symbol,
        tradeLogsTable.direction,
        tradeLogsTable.durationTarget,
        tradeLogsTable.durationUnit,
      )
      .orderBy(tradeLogsTable.symbol, tradeLogsTable.direction, tradeLogsTable.durationTarget);

    rows = raw as RawRow[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return (
      <div className="min-h-screen bg-[#0a0a0f] p-6">
        <AdminNav />
        <div className="max-w-xl mx-auto py-16 text-center space-y-4">
          <div className="text-4xl">🗄️</div>
          <h2 className="text-lg font-bold text-red-400">Database error</h2>
          <p className="text-sm text-zinc-400 font-mono break-all">{msg}</p>
        </div>
      </div>
    );
  }

  const expiryRows: ExpiryRow[] = rows.map(r => ({
    symbol: r.symbol,
    direction: r.direction as 'CALL' | 'PUT',
    expiry: formatExpiry(r.durationTarget, r.durationUnit),
    trades: r.total,
    wins: r.wins,
    wr: r.total > 0 ? (r.wins / r.total) * 100 : 0,
  }));

  const grouped = new Map<string, ExpiryRow[]>();
  for (const row of expiryRows) {
    const key = `${row.symbol}||${row.direction}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(row);
  }

  const bestExpiries: BestExpiryRow[] = [];
  for (const [key, expiries] of grouped.entries()) {
    const [symbol, direction] = key.split('||') as [string, 'CALL' | 'PUT'];
    const sorted = [...expiries].sort((a, b) => expirySort(a.expiry) - expirySort(b.expiry));
    const qualified = expiries.filter(e => e.trades >= MIN_SAMPLE);
    const best = qualified.length > 0
      ? qualified.reduce((a, b) => b.wr > a.wr ? b : a)
      : expiries.reduce((a, b) => b.trades > a.trades ? b : a);
    bestExpiries.push({
      symbol,
      direction,
      bestExpiry: best.expiry,
      bestWr: best.wr,
      bestTrades: best.trades,
      allExpiries: sorted,
    });
  }

  bestExpiries.sort((a, b) => {
    const aName = getSymbolDisplayName(a.symbol);
    const bName = getSymbolDisplayName(b.symbol);
    return aName.localeCompare(bName) || a.direction.localeCompare(b.direction);
  });

  const opportunities = expiryRows
    .filter(r => r.trades >= MIN_SAMPLE)
    .sort((a, b) => b.wr - a.wr)
    .slice(0, 20)
    .map((r, i) => ({ ...r, rank: i + 1 }));

  const totalTrades = expiryRows.reduce((s, r) => s + r.trades, 0);
  const uniqueCombos = grouped.size;
  const qualifiedCombos = [...grouped.values()].filter(arr => arr.some(e => e.trades >= MIN_SAMPLE)).length;

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white">
      <AutoRefresh intervalSeconds={60} />
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-6">

        <AdminNav />

        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-lg font-bold text-white flex items-center gap-2">
              <span>⏱️</span> Expiry Performance Analytics
            </h1>
            <p className="text-xs text-zinc-500 mt-0.5">
              Win rate breakdown by Symbol · Direction · Expiry
            </p>
          </div>

          {/* Filter toggle */}
          <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 rounded-lg p-1">
            {(['ALL', 'LIVE', 'GHOST'] as ExecFilter[]).map(f => (
              <a
                key={f}
                href={f === 'ALL' ? '/admin/expiry' : `/admin/expiry?type=${f}`}
                className={`px-3 py-1 rounded-md text-xs font-semibold transition-all ${
                  execFilter === f
                    ? 'bg-violet-600 text-white'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                {f === 'ALL' ? '📊 All' : f === 'LIVE' ? '💰 Live' : '👻 Ghost'}
              </a>
            ))}
          </div>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Trades Analysed', value: totalTrades.toLocaleString(), sub: execFilter === 'ALL' ? 'LIVE + GHOST' : execFilter, color: 'text-white' },
            { label: 'Symbol + Direction Combos', value: uniqueCombos.toString(), color: 'text-blue-400' },
            { label: 'Qualified Combos', value: qualifiedCombos.toString(), sub: `≥${MIN_SAMPLE} trades`, color: 'text-violet-400' },
            { label: 'Top Opportunities', value: opportunities.length.toString(), color: 'text-emerald-400' },
          ].map(card => (
            <div key={card.label} className="rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-3">
              <div className={`text-xl font-bold ${card.color}`}>{card.value}</div>
              <div className="text-[10px] text-zinc-500 mt-0.5">{card.label}</div>
              {card.sub && <div className="text-[9px] text-zinc-600 uppercase tracking-wide">{card.sub}</div>}
            </div>
          ))}
        </div>

        <ExpiryClient
          bestExpiries={bestExpiries}
          opportunities={opportunities}
          minSample={MIN_SAMPLE}
        />

        <p className="text-[11px] text-zinc-600 text-center pb-4">
          {execFilter === 'LIVE'
            ? 'Showing LIVE trades only.'
            : execFilter === 'GHOST'
            ? 'Showing Ghost (simulation) trades only.'
            : 'Showing all resolved trades — LIVE and Ghost combined. Use the filter above to isolate.'}
        </p>

      </div>
    </div>
  );
}
