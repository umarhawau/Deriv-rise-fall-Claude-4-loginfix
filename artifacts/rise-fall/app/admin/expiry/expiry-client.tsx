'use client';

import { useState } from 'react';
import { getSymbolDisplayName } from '@/lib/active-symbols-display-names';

export interface ExpiryRow {
  symbol: string;
  direction: 'CALL' | 'PUT';
  expiry: string;
  trades: number;
  wins: number;
  wr: number;
}

export interface BestExpiryRow {
  symbol: string;
  direction: 'CALL' | 'PUT';
  bestExpiry: string;
  bestWr: number;
  bestTrades: number;
  allExpiries: ExpiryRow[];
}

interface Props {
  bestExpiries: BestExpiryRow[];
  opportunities: (ExpiryRow & { rank: number })[];
  minSample: number;
}

function getWrTextColor(wr: number): string {
  if (wr >= 60) return 'text-emerald-400';
  if (wr >= 52) return 'text-blue-400';
  if (wr >= 48) return 'text-amber-400';
  return 'text-rose-400';
}

function getWrBarColor(wr: number): string {
  if (wr >= 60) return 'bg-emerald-500';
  if (wr >= 52) return 'bg-blue-500';
  if (wr >= 48) return 'bg-amber-500';
  return 'bg-rose-500';
}

function WrBadge({ wr, trades, minSample }: { wr: number; trades: number; minSample: number }) {
  if (trades < minSample) return <span className="text-xs text-zinc-400 italic">{trades} trades</span>;
  return <span className={`font-bold ${getWrTextColor(wr)}`}>{wr.toFixed(1)}%</span>;
}

function DirectionBadge({ dir }: { dir: 'CALL' | 'PUT' }) {
  return dir === 'CALL'
    ? <span className="inline-flex items-center gap-0.5 text-emerald-400 font-bold text-xs">↑ CALL</span>
    : <span className="inline-flex items-center gap-0.5 text-rose-400 font-bold text-xs">↓ PUT</span>;
}

export function ExpiryClient({ bestExpiries, opportunities, minSample }: Props) {
  const [selected, setSelected] = useState<BestExpiryRow | null>(null);
  const [search, setSearch] = useState('');

  const filtered = bestExpiries.filter(row => {
    if (!search) return true;
    const name = getSymbolDisplayName(row.symbol).toLowerCase();
    return name.includes(search.toLowerCase()) || row.symbol.toLowerCase().includes(search.toLowerCase());
  });

  return (
    <div className="space-y-8">

      {/* ── Best Opportunities ── */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <span className="text-lg">🏆</span>
          <h2 className="text-sm font-bold text-white">Best Opportunities</h2>
          <span className="text-[10px] text-zinc-500 ml-1">min {minSample} trades · sorted by win rate</span>
        </div>

        {opportunities.length === 0 ? (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 text-center text-sm text-zinc-500">
            Not enough data yet — need at least {minSample} resolved trades per Symbol + Direction + Expiry combination.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-zinc-800">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-zinc-800 bg-zinc-900/80">
                  <th className="text-left px-3 py-2.5 text-zinc-400 font-semibold">Rank</th>
                  <th className="text-left px-3 py-2.5 text-zinc-400 font-semibold">Symbol</th>
                  <th className="text-left px-3 py-2.5 text-zinc-400 font-semibold">Direction</th>
                  <th className="text-left px-3 py-2.5 text-zinc-400 font-semibold">Expiry</th>
                  <th className="text-right px-3 py-2.5 text-zinc-400 font-semibold">Win Rate</th>
                  <th className="text-right px-3 py-2.5 text-zinc-400 font-semibold">Trades</th>
                  <th className="text-right px-3 py-2.5 text-zinc-400 font-semibold">Wins</th>
                </tr>
              </thead>
              <tbody>
                {opportunities.map((row) => (
                  <tr key={`${row.symbol}-${row.direction}-${row.expiry}`}
                    className="border-b border-zinc-800/60 hover:bg-zinc-800/30 transition-colors">
                    <td className="px-3 py-2.5">
                      <span className={`font-bold ${
                        row.rank === 1 ? 'text-amber-400' :
                        row.rank === 2 ? 'text-zinc-300' :
                        row.rank === 3 ? 'text-amber-700' :
                        'text-zinc-500'
                      }`}>
                        #{row.rank}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 font-medium text-white">{getSymbolDisplayName(row.symbol)}</td>
                    <td className="px-3 py-2.5"><DirectionBadge dir={row.direction} /></td>
                    <td className="px-3 py-2.5">
                      <span className="px-2 py-0.5 rounded bg-violet-500/15 text-violet-300 font-mono font-bold text-[11px]">
                        {row.expiry}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <WrBadge wr={row.wr} trades={row.trades} minSample={minSample} />
                    </td>
                    <td className="px-3 py-2.5 text-right text-zinc-300">{row.trades}</td>
                    <td className="px-3 py-2.5 text-right text-zinc-400">{row.wins}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Best Expiry per Symbol+Direction ── */}
      <section>
        <div className="flex items-center gap-3 mb-3">
          <div className="flex items-center gap-2">
            <span className="text-lg">📊</span>
            <h2 className="text-sm font-bold text-white">Best Expiry per Symbol &amp; Direction</h2>
          </div>
          <input
            type="text"
            placeholder="Search symbol…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="ml-auto text-xs bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-1.5 text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-violet-500 w-40"
          />
        </div>
        <p className="text-[11px] text-zinc-500 mb-3">Click any row to see full expiry breakdown ↓</p>

        {filtered.length === 0 ? (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 text-center text-sm text-zinc-500">
            No resolved trades found. Start trading to see expiry analytics.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-zinc-800">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-zinc-800 bg-zinc-900/80">
                  <th className="text-left px-3 py-2.5 text-zinc-400 font-semibold">Symbol</th>
                  <th className="text-left px-3 py-2.5 text-zinc-400 font-semibold">Direction</th>
                  <th className="text-left px-3 py-2.5 text-zinc-400 font-semibold">Best Expiry</th>
                  <th className="text-right px-3 py-2.5 text-zinc-400 font-semibold">Best WR</th>
                  <th className="text-right px-3 py-2.5 text-zinc-400 font-semibold">Trades</th>
                  <th className="text-right px-3 py-2.5 text-zinc-400 font-semibold">Expiry Options</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => {
                  const isSelected = selected?.symbol === row.symbol && selected?.direction === row.direction;
                  const hasEnough = row.bestTrades >= minSample;
                  return (
                    <tr
                      key={`${row.symbol}-${row.direction}`}
                      onClick={() => setSelected(isSelected ? null : row)}
                      className={`border-b border-zinc-800/60 cursor-pointer transition-colors ${
                        isSelected
                          ? 'bg-violet-900/20 border-violet-700/40'
                          : 'hover:bg-zinc-800/30'
                      }`}
                    >
                      <td className="px-3 py-2.5 font-medium text-white">{getSymbolDisplayName(row.symbol)}</td>
                      <td className="px-3 py-2.5"><DirectionBadge dir={row.direction} /></td>
                      <td className="px-3 py-2.5">
                        {hasEnough ? (
                          <span className="px-2 py-0.5 rounded bg-violet-500/15 text-violet-300 font-mono font-bold text-[11px]">
                            {row.bestExpiry}
                          </span>
                        ) : (
                          <span className="text-zinc-500 italic text-[11px]">insufficient data</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <WrBadge wr={row.bestWr} trades={row.bestTrades} minSample={minSample} />
                      </td>
                      <td className="px-3 py-2.5 text-right text-zinc-300">{row.bestTrades}</td>
                      <td className="px-3 py-2.5 text-right text-zinc-500">{row.allExpiries.length}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Expiry Breakdown Drill-Down ── */}
      {selected && (
        <section className="rounded-xl border border-violet-700/40 bg-violet-950/10 p-4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <span className="text-base">🔍</span>
              <h2 className="text-sm font-bold text-white">
                {getSymbolDisplayName(selected.symbol)}
              </h2>
              <DirectionBadge dir={selected.direction} />
              <span className="text-zinc-500 text-xs">— Expiry Breakdown</span>
            </div>
            <button
              onClick={() => setSelected(null)}
              className="text-zinc-500 hover:text-zinc-300 text-xs transition-colors"
            >
              ✕ close
            </button>
          </div>

          <div className="overflow-x-auto rounded-lg border border-zinc-800">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-zinc-800 bg-zinc-900/80">
                  <th className="text-left px-3 py-2.5 text-zinc-400 font-semibold">Expiry</th>
                  <th className="text-right px-3 py-2.5 text-zinc-400 font-semibold">Trades</th>
                  <th className="text-right px-3 py-2.5 text-zinc-400 font-semibold">Wins</th>
                  <th className="text-right px-3 py-2.5 text-zinc-400 font-semibold">Losses</th>
                  <th className="text-right px-3 py-2.5 text-zinc-400 font-semibold">Win Rate</th>
                  <th className="text-left px-3 py-2.5 text-zinc-400 font-semibold">Bar</th>
                  <th className="text-left px-3 py-2.5 text-zinc-400 font-semibold"></th>
                </tr>
              </thead>
              <tbody>
                {[...selected.allExpiries]
                  .sort((a, b) => b.wr - a.wr)
                  .map((row, i) => {
                    const isTop = i === 0 && row.trades >= minSample;
                    return (
                      <tr key={row.expiry} className={`border-b border-zinc-800/60 ${isTop ? 'bg-emerald-950/20' : ''}`}>
                        <td className="px-3 py-2.5">
                          <span className="px-2 py-0.5 rounded bg-zinc-800 text-zinc-200 font-mono font-bold text-[11px]">
                            {row.expiry}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-right text-zinc-300">{row.trades}</td>
                        <td className="px-3 py-2.5 text-right text-emerald-400">{row.wins}</td>
                        <td className="px-3 py-2.5 text-right text-rose-400">{row.trades - row.wins}</td>
                        <td className="px-3 py-2.5 text-right">
                          <WrBadge wr={row.wr} trades={row.trades} minSample={minSample} />
                        </td>
                        <td className="px-3 py-2.5 w-32">
                          {row.trades >= minSample ? (
                            <div className="h-2 w-full bg-zinc-800 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all ${getWrBarColor(row.wr)}`}
                                style={{ width: `${Math.round(row.wr)}%` }}
                              />
                            </div>
                          ) : (
                            <span className="text-[10px] text-zinc-600 italic">need {minSample - row.trades} more</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          {isTop && (
                            <span className="text-[11px] font-bold text-amber-400">🏆 Recommended</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
