'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis,
  Tooltip, ResponsiveContainer, ReferenceLine, Cell,
} from 'recharts';
import { useDerivWSContext } from '@/components/custom/deriv-ws-provider';
import { useLogoSrc } from '@/components/custom/logo-src-provider';
import { Header } from '@/components/custom/header';
import { ThemeToggle } from '@/components/custom/theme-toggle';
import { Footer } from '@/components/custom/footer';

// ── Data types ────────────────────────────────────────────────────────────────

interface NeonTrade {
  id: number;
  executionType: 'LIVE' | 'GHOST';
  status: 'WIN' | 'LOSS' | 'PENDING';
  direction: 'CALL' | 'PUT';
  symbol: string;
  effectiveMode: 'SNIPER' | 'BALANCED' | 'AGGRESSIVE';
  durationTarget: number;
  durationUnit: string;
  stake: string | null;
  pnl: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

interface TradeRecord {
  id: string;
  timestamp: number;
  symbol: string;
  direction: 'CALL' | 'PUT';
  stake: number;
  pnl: number;
  tier: string | null;
  outcome: 'WIN' | 'LOSS';
}

function mapNeonTrade(t: NeonTrade): TradeRecord {
  return {
    id: String(t.id),
    timestamp: new Date(t.createdAt).getTime(),
    symbol: t.symbol,
    direction: t.direction,
    stake: parseFloat(t.stake ?? '0'),
    pnl: parseFloat(t.pnl ?? '0'),
    tier: t.effectiveMode,
    outcome: t.status as 'WIN' | 'LOSS',
  };
}

type SortKey = 'timestamp' | 'pnl' | 'stake' | 'symbol' | 'direction' | 'outcome';
type SortDir = 'asc' | 'desc';

const PAGE_SIZE = 20;

function computeStreaks(records: TradeRecord[]) {
  let maxWin = 0, maxLoss = 0, curWin = 0, curLoss = 0;
  for (const r of records) {
    if (r.outcome === 'WIN') { curWin++; curLoss = 0; maxWin = Math.max(maxWin, curWin); }
    else { curLoss++; curWin = 0; maxLoss = Math.max(maxLoss, curLoss); }
  }
  const current = records.length === 0 ? null
    : records[records.length - 1]!.outcome === 'WIN'
      ? { type: 'WIN' as const, count: curWin }
      : { type: 'LOSS' as const, count: curLoss };
  return { maxWin, maxLoss, current };
}

function computeMaxDrawdown(records: TradeRecord[]) {
  let peak = 0, maxDD = 0, cumPnl = 0;
  for (const r of records) {
    cumPnl += r.pnl;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

function exportCSV(records: TradeRecord[]) {
  const header = 'Date,Time,Symbol,Direction,Stake,P&L,Outcome,Tier';
  const rows = records.map(r => {
    const d = new Date(r.timestamp);
    return [
      d.toLocaleDateString(),
      d.toLocaleTimeString(),
      r.symbol,
      r.direction,
      r.stake.toFixed(2),
      r.pnl.toFixed(2),
      r.outcome,
      r.tier ?? '',
    ].join(',');
  });
  const csv = [header, ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pulseedge-trades-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Stat card ─────────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, positive }: { label: string; value: string; sub?: string; positive?: boolean }) {
  const color = positive === undefined ? '' : positive ? 'text-green-500' : 'text-red-500';
  return (
    <div className="rounded-xl border border-border bg-card p-4 flex flex-col gap-1">
      <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">{label}</span>
      <span className={`text-2xl font-bold tabular-nums ${color}`}>{value}</span>
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
    </div>
  );
}

// ── Streak badge ──────────────────────────────────────────────────────────────
function StreakBadge({ label, count, type }: { label: string; count: number; type: 'WIN' | 'LOSS' | 'neutral' }) {
  const color = type === 'WIN' ? 'bg-green-500/10 text-green-500 border-green-500/20'
    : type === 'LOSS' ? 'bg-red-500/10 text-red-500 border-red-500/20'
    : 'bg-muted text-muted-foreground border-border';
  return (
    <div className={`rounded-xl border p-4 flex flex-col gap-1 ${color}`}>
      <span className="text-xs font-medium uppercase tracking-wide opacity-70">{label}</span>
      <span className="text-3xl font-bold tabular-nums">{count}</span>
      <span className="text-xs opacity-60">{type === 'neutral' ? '—' : `${type} trades`}</span>
    </div>
  );
}

// ── Custom tooltip for equity curve ──────────────────────────────────────────
function EquityTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: { tradeNum: number; cumPnl: number; pnl: number } }> }) {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload;
  const sign = d.cumPnl >= 0 ? '+' : '';
  const trSign = d.pnl >= 0 ? '+' : '';
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-xl">
      <div className="font-semibold text-foreground">Trade #{d.tradeNum}</div>
      <div className={d.cumPnl >= 0 ? 'text-green-500' : 'text-red-500'}>Cumulative: {sign}${d.cumPnl.toFixed(2)}</div>
      <div className={d.pnl >= 0 ? 'text-green-400' : 'text-red-400'}>This trade: {trSign}${d.pnl.toFixed(2)}</div>
    </div>
  );
}

// ── Bar tooltip ───────────────────────────────────────────────────────────────
function BarTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number }>; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-xl">
      <div className="font-semibold text-foreground mb-1">{label}</div>
      {payload.map(p => (
        <div key={p.name} className={p.name === 'Wins' ? 'text-green-500' : 'text-red-500'}>
          {p.name}: {p.value}
        </div>
      ))}
    </div>
  );
}

export default function ReportsPage() {
  const logoSrc = useLogoSrc();
  const router = useRouter();
  const { auth } = useDerivWSContext();
  const { authState, accounts, activeAccount, login, signUp, logout, switchAccount } = auth;

  const [tab, setTab] = useState<'LIVE' | 'GHOST'>('LIVE');
  const [records, setRecords] = useState<TradeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>('timestamp');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [page, setPage] = useState(1);

  useEffect(() => {
    if (authState === 'unauthenticated' || authState === 'error') {
      router.replace('/');
    }
  }, [authState, router]);

  const load = useCallback(async () => {
    const accountId = activeAccount?.account_id;
    if (!accountId) {
      setRecords([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/trade-logs?accountId=${encodeURIComponent(accountId)}&executionType=${tab}`);
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json() as { trades: NeonTrade[] };
      setRecords((data.trades ?? []).map(mapNeonTrade));
    } catch {
      setRecords([]);
    } finally {
      setLoading(false);
    }
  }, [activeAccount?.account_id, tab]);

  useEffect(() => { void load(); }, [load]);

  // ── Derived analytics ──────────────────────────────────────────────────────
  const totalPnl = useMemo(() => records.reduce((s, r) => s + r.pnl, 0), [records]);
  const wins = useMemo(() => records.filter(r => r.outcome === 'WIN').length, [records]);
  const winRate = records.length ? ((wins / records.length) * 100) : 0;
  const maxDrawdown = useMemo(() => computeMaxDrawdown(records), [records]);
  const streaks = useMemo(() => computeStreaks(records), [records]);

  const equityCurve = useMemo(() => {
    let cum = 0;
    return records.map((r, i) => {
      cum += r.pnl;
      return { tradeNum: i + 1, pnl: r.pnl, cumPnl: parseFloat(cum.toFixed(2)) };
    });
  }, [records]);

  const symbolStats = useMemo(() => {
    const map: Record<string, { symbol: string; Wins: number; Losses: number }> = {};
    for (const r of records) {
      if (!map[r.symbol]) map[r.symbol] = { symbol: r.symbol, Wins: 0, Losses: 0 };
      if (r.outcome === 'WIN') map[r.symbol]!.Wins++;
      else map[r.symbol]!.Losses++;
    }
    return Object.values(map).sort((a, b) => (b.Wins + b.Losses) - (a.Wins + a.Losses));
  }, [records]);

  // ── Sorted + paginated table ───────────────────────────────────────────────
  const sorted = useMemo(() => {
    return [...records].sort((a, b) => {
      let av: string | number, bv: string | number;
      if (sortKey === 'timestamp') { av = a.timestamp; bv = b.timestamp; }
      else if (sortKey === 'pnl') { av = a.pnl; bv = b.pnl; }
      else if (sortKey === 'stake') { av = a.stake; bv = b.stake; }
      else { av = (a as unknown as Record<string, unknown>)[sortKey] as string; bv = (b as unknown as Record<string, unknown>)[sortKey] as string; }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
  }, [records, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageSlice = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
    setPage(1);
  };

  if (authState !== 'authenticated') {
    return (
      <main className="flex flex-col bg-background items-center justify-center min-h-dvh">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </main>
    );
  }

  const pnlPositive = totalPnl >= 0;
  const pnlSign = pnlPositive ? '+' : '';

  return (
    <main className="flex flex-col bg-background min-h-dvh">
      <Header
        authState={authState}
        accounts={accounts}
        activeAccount={activeAccount}
        onLogin={login}
        onSignUp={signUp}
        onLogout={logout}
        onSwitchAccount={switchAccount}
        logoSrc={logoSrc}
        actions={<ThemeToggle />}
      />
      <div className="h-[76px] shrink-0" />

      <div className="flex-1 w-full max-w-7xl mx-auto px-3 py-4 sm:px-6 sm:py-6 pb-16">

        {/* ── Header row ── */}
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
              <span className="text-base leading-none">←</span>
              <span>Trading</span>
            </Link>
            <span className="text-muted-foreground/40">/</span>
            <h1 className="text-lg font-bold text-foreground">Trade Analytics</h1>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => void load()}
              disabled={loading}
              className="text-xs px-3 py-1.5 rounded-lg border border-border bg-card hover:bg-accent text-foreground disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? 'Loading…' : '↻ Refresh'}
            </button>
            <button
              onClick={() => exportCSV(records)}
              disabled={records.length === 0}
              className="text-xs px-3 py-1.5 rounded-lg border border-border bg-card hover:bg-accent text-foreground disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Export CSV
            </button>
          </div>
        </div>

        {/* ── LIVE / GHOST tab switcher ── */}
        <div className="flex items-center gap-1 mb-5 p-1 rounded-xl bg-muted/50 border border-border w-fit">
          <button
            onClick={() => { setTab('LIVE'); setPage(1); }}
            className={`text-xs px-4 py-1.5 rounded-lg font-semibold transition-all ${
              tab === 'LIVE'
                ? 'bg-background text-foreground shadow-sm border border-border'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            ⚡ Live Trades
          </button>
          <button
            onClick={() => { setTab('GHOST'); setPage(1); }}
            className={`text-xs px-4 py-1.5 rounded-lg font-semibold transition-all ${
              tab === 'GHOST'
                ? 'bg-background text-foreground shadow-sm border border-border'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            👻 Ghost / Suppressed
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        ) : records.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 gap-3 text-center">
            <div className="text-4xl">{tab === 'GHOST' ? '👻' : '📊'}</div>
            <p className="text-muted-foreground text-sm">
              {tab === 'GHOST' ? 'No ghost trades recorded yet.' : 'No trade history yet.'}
            </p>
            <p className="text-muted-foreground/60 text-xs">
              {tab === 'GHOST'
                ? 'Suppressed signals are tracked here as ghost trades. Enable the bot — every blocked signal will appear.'
                : 'Enable the Auto Trade Bot and close some trades to see your analytics here.'}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-6">

            {/* ── 4 Stat Cards ── */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <StatCard
                label="Total P/L"
                value={`${pnlSign}$${Math.abs(totalPnl).toFixed(2)}`}
                sub={`${records.length} closed trade${records.length !== 1 ? 's' : ''}`}
                positive={pnlPositive}
              />
              <StatCard
                label="Win Rate"
                value={`${winRate.toFixed(1)}%`}
                sub={`${wins}W · ${records.length - wins}L`}
                positive={winRate >= 50}
              />
              <StatCard
                label="Max Drawdown"
                value={`-$${maxDrawdown.toFixed(2)}`}
                sub="Peak-to-trough"
                positive={false}
              />
              <StatCard
                label="Total Trades"
                value={String(records.length)}
                sub={`Avg ${records.length > 0 ? (totalPnl >= 0 ? '+' : '') + '$' + (totalPnl / records.length).toFixed(2) : '$0.00'} / trade`}
              />
            </div>

            {/* ── Equity Curve ── */}
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="text-sm font-semibold text-foreground mb-4">Equity Curve</div>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={equityCurve} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <XAxis
                    dataKey="tradeNum"
                    tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
                    tickLine={false}
                    axisLine={false}
                    label={{ value: 'Trade #', position: 'insideBottomRight', fontSize: 10, fill: 'var(--muted-foreground)', dy: 4 }}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={v => `$${v}`}
                    width={52}
                  />
                  <Tooltip content={<EquityTooltip />} />
                  <ReferenceLine y={0} stroke="var(--border)" strokeDasharray="3 3" />
                  <Line
                    type="monotone"
                    dataKey="cumPnl"
                    stroke={totalPnl >= 0 ? '#22c55e' : '#ef4444'}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* ── Win/Loss by Symbol + Streaks ── */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

              {/* Symbol bar chart */}
              <div className="rounded-xl border border-border bg-card p-4">
                <div className="text-sm font-semibold text-foreground mb-4">Win / Loss by Symbol</div>
                {symbolStats.length === 0 ? (
                  <div className="h-40 flex items-center justify-center text-muted-foreground text-xs">No data</div>
                ) : (
                  <ResponsiveContainer width="100%" height={180}>
                    <BarChart data={symbolStats} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                      <XAxis dataKey="symbol" tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} tickLine={false} axisLine={false} />
                      <YAxis tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} tickLine={false} axisLine={false} allowDecimals={false} width={28} />
                      <Tooltip content={<BarTooltip />} />
                      <Bar dataKey="Wins" stackId="a" radius={[0, 0, 0, 0]}>
                        {symbolStats.map((_, i) => <Cell key={i} fill="#22c55e" fillOpacity={0.8} />)}
                      </Bar>
                      <Bar dataKey="Losses" stackId="a" radius={[4, 4, 0, 0]}>
                        {symbolStats.map((_, i) => <Cell key={i} fill="#ef4444" fillOpacity={0.8} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>

              {/* Streak cards */}
              <div className="flex flex-col gap-3">
                <div className="text-sm font-semibold text-foreground">Streaks</div>
                <div className="grid grid-cols-3 gap-3">
                  <StreakBadge label="Longest Win" count={streaks.maxWin} type="WIN" />
                  <StreakBadge label="Longest Loss" count={streaks.maxLoss} type="LOSS" />
                  <StreakBadge
                    label="Current"
                    count={streaks.current?.count ?? 0}
                    type={streaks.current?.type ?? 'neutral'}
                  />
                </div>
                {/* Quick summary */}
                <div className="rounded-xl border border-border bg-card p-3 text-xs text-muted-foreground space-y-1.5">
                  <div className="flex justify-between">
                    <span>Wins</span>
                    <span className="text-green-500 font-medium">{wins}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Losses</span>
                    <span className="text-red-500 font-medium">{records.length - wins}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Avg trade P/L</span>
                    <span className={`font-medium ${records.length > 0 && totalPnl / records.length >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                      {records.length > 0 ? `${totalPnl >= 0 ? '+' : ''}$${(totalPnl / records.length).toFixed(2)}` : '—'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Best trade</span>
                    <span className="text-green-500 font-medium">
                      {records.length > 0 ? `+$${Math.max(...records.map(r => r.pnl)).toFixed(2)}` : '—'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Worst trade</span>
                    <span className="text-red-500 font-medium">
                      {records.length > 0 ? `$${Math.min(...records.map(r => r.pnl)).toFixed(2)}` : '—'}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* ── Trade Log Table ── */}
            <div className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                <div className="text-sm font-semibold text-foreground">
                  {tab === 'GHOST' ? '👻 Ghost Signal Log' : '⚡ Trade Log'}
                </div>
                <div className="text-xs text-muted-foreground">{records.length} total · page {page} of {totalPages}</div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-muted-foreground border-b border-border">
                      {([ ['timestamp','Date / Time'], ['symbol','Symbol'], ['direction','Dir'], ['stake','Stake'], ['pnl','P&L'], ['outcome','Outcome'] ] as [SortKey, string][]).map(([key, label]) => (
                        <th
                          key={key}
                          className="px-4 py-2 text-left font-medium cursor-pointer hover:text-foreground select-none whitespace-nowrap"
                          onClick={() => toggleSort(key)}
                        >
                          {label}{' '}
                          {sortKey === key ? (sortDir === 'asc' ? '↑' : '↓') : <span className="opacity-30">↕</span>}
                        </th>
                      ))}
                      <th className="px-4 py-2 text-left font-medium whitespace-nowrap">Tier</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageSlice.map((r) => {
                      const d = new Date(r.timestamp);
                      const pnlPos = r.pnl >= 0;
                      return (
                        <tr key={r.id} className="border-b border-border/50 hover:bg-accent/30 transition-colors">
                          <td className="px-4 py-2.5 text-muted-foreground whitespace-nowrap">
                            <span>{d.toLocaleDateString()}</span>{' '}
                            <span className="opacity-60">{d.toLocaleTimeString()}</span>
                          </td>
                          <td className="px-4 py-2.5 font-mono text-foreground">{r.symbol}</td>
                          <td className="px-4 py-2.5">
                            <span className={`font-semibold ${r.direction === 'CALL' ? 'text-green-500' : 'text-red-500'}`}>
                              {r.direction === 'CALL' ? '↑ Rise' : '↓ Fall'}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 tabular-nums">${r.stake.toFixed(2)}</td>
                          <td className={`px-4 py-2.5 tabular-nums font-semibold ${pnlPos ? 'text-green-500' : 'text-red-500'}`}>
                            {pnlPos ? '+' : ''}${r.pnl.toFixed(2)}
                          </td>
                          <td className="px-4 py-2.5">
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ${r.outcome === 'WIN' ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'}`}>
                              {r.outcome === 'WIN' ? '✓ WIN' : '✗ LOSS'}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-muted-foreground">
                            {r.tier ?? '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between px-4 py-3 border-t border-border">
                  <button
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    disabled={page === 1}
                    className="text-xs px-3 py-1.5 rounded-lg border border-border bg-card hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    ← Prev
                  </button>
                  <div className="flex gap-1">
                    {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                      const p = totalPages <= 7 ? i + 1
                        : page <= 4 ? i + 1
                        : page >= totalPages - 3 ? totalPages - 6 + i
                        : page - 3 + i;
                      return (
                        <button
                          key={p}
                          onClick={() => setPage(p)}
                          className={`w-7 h-7 rounded text-xs font-medium transition-colors ${p === page ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'}`}
                        >
                          {p}
                        </button>
                      );
                    })}
                  </div>
                  <button
                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                    disabled={page === totalPages}
                    className="text-xs px-3 py-1.5 rounded-lg border border-border bg-card hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    Next →
                  </button>
                </div>
              )}
            </div>

          </div>
        )}
      </div>
      <Footer />
    </main>
  );
}
