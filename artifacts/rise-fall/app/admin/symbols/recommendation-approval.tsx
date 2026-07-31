'use client';

import { useState, useTransition } from 'react';
import {
  applyHighConfidenceDisablesAction,
  applyDirectionRecommendationAction,
} from './actions';
import { type HighConfidenceCandidate } from './constants';
import { getSymbolDisplayName } from '@/lib/active-symbols-display-names';

export interface DisableRec {
  symbol: string;
  direction: 'CALL' | 'PUT';
  wr: number;
  trades: number;
  pnl: number | null;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  reason: string;
}

interface Props {
  disableRecs: DisableRec[];
}

function ConfidenceBadge({ c }: { c: 'HIGH' | 'MEDIUM' | 'LOW' }) {
  const styles = {
    HIGH:   'bg-rose-500/15 border-rose-500/30 text-rose-700 dark:text-rose-400',
    MEDIUM: 'bg-amber-500/15 border-amber-500/30 text-amber-700 dark:text-amber-400',
    LOW:    'bg-gray-200/80 border-gray-300 dark:bg-zinc-800 dark:border-zinc-700 text-gray-600 dark:text-zinc-400',
  };
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[9px] font-bold ${styles[c]}`}>
      {c} confidence
    </span>
  );
}

export function RecommendationApproval({ disableRecs }: Props) {
  const [approved, setApproved]        = useState<Set<string>>(new Set());
  const [pendingKey, setPendingKey]     = useState<string | null>(null);
  const [indivErrors, setIndivErrors]  = useState<Map<string, string>>(new Map());
  const [showPreview, setShowPreview]  = useState(false);
  const [bulkResult, setBulkResult]    = useState<number | null>(null);
  const [bulkError, setBulkError]      = useState<string | null>(null);
  const [, startBulk]                  = useTransition();

  const keyOf = (r: DisableRec) => `${r.symbol}:${r.direction}`;
  const pending_recs = disableRecs.filter(r => !approved.has(keyOf(r)));
  const highConf     = pending_recs.filter(r => r.confidence === 'HIGH');

  function handleIndividual(rec: DisableRec) {
    const k = keyOf(rec);
    setPendingKey(k);
    setIndivErrors(m => { const n = new Map(m); n.delete(k); return n; });
    void (async () => {
      const res = await applyDirectionRecommendationAction(rec.symbol, rec.direction);
      setPendingKey(null);
      if (res.ok) setApproved(a => new Set(a).add(k));
      else setIndivErrors(m => new Map(m).set(k, res.error ?? 'Unknown error'));
    })();
  }

  function handleBulkApply() {
    setBulkError(null);
    const candidates: HighConfidenceCandidate[] = highConf.map(r => ({
      symbol:   r.symbol,
      direction: r.direction,
      trades:   r.trades,
      winRate:  r.wr,
    }));
    startBulk(async () => {
      const res = await applyHighConfidenceDisablesAction(candidates);
      if (res.ok) {
        setBulkResult(res.applied);
        setShowPreview(false);
        for (const r of highConf) setApproved(a => new Set(a).add(keyOf(r)));
      } else {
        setBulkError(res.error ?? 'Unknown error');
      }
    });
  }

  if (pending_recs.length === 0 && approved.size === 0 && bulkResult == null) return null;

  return (
    <div className="space-y-3">
      {/* Bulk action bar */}
      {(highConf.length > 0 || bulkResult != null) && (
        <div className="flex items-center justify-between gap-3 bg-rose-500/5 border border-rose-500/20 rounded-xl px-4 py-3">
          <div>
            {bulkResult != null ? (
              <p className="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                ✅ Bulk applied — {bulkResult} HIGH-confidence direction{bulkResult !== 1 ? 's' : ''} disabled. Bot refreshes within 60 s.
              </p>
            ) : (
              <>
                <p className="text-[12px] font-bold text-rose-700 dark:text-rose-400">
                  {highConf.length} HIGH-confidence DISABLE recommendation{highConf.length !== 1 ? 's' : ''}
                </p>
                <p className="text-[10px] text-gray-500 dark:text-zinc-500">
                  ≥100 trades + WR &lt;{45}% — statistically strong signal
                </p>
              </>
            )}
          </div>
          {bulkResult == null && (
            <button
              onClick={() => setShowPreview(true)}
              className="shrink-0 text-[11px] font-bold bg-rose-600 hover:bg-rose-700 text-white px-4 py-2 rounded-lg transition-colors flex items-center gap-1.5"
            >
              🛡 Preview &amp; Approve All HIGH
              <span className="bg-white/20 rounded-full px-1.5 py-px text-[9px] ml-0.5">{highConf.length}</span>
            </button>
          )}
          {bulkError && (
            <p className="text-[10px] text-rose-500 dark:text-rose-400">{bulkError}</p>
          )}
        </div>
      )}

      {/* Individual DISABLE cards */}
      <div className="space-y-2">
        {pending_recs.map(rec => {
          const k = keyOf(rec);
          const isP = pendingKey === k;
          const err = indivErrors.get(k);
          const pnlStr = rec.pnl == null ? null : `${rec.pnl >= 0 ? '+' : ''}$${Math.abs(rec.pnl).toFixed(0)}`;
          return (
            <div key={k} className="bg-white dark:bg-zinc-900 border border-rose-200 dark:border-rose-900/50 rounded-xl overflow-hidden">
              <div className="px-4 py-3 flex flex-col sm:flex-row sm:items-start gap-3">
                {/* Left: symbol + direction */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1.5">
                    <span className={`text-[11px] font-bold px-2 py-0.5 rounded border ${
                      rec.direction === 'PUT'
                        ? 'bg-rose-500/15 border-rose-500/30 text-rose-700 dark:text-rose-400'
                        : 'bg-amber-500/15 border-amber-500/30 text-amber-700 dark:text-amber-400'
                    }`}>
                      {rec.direction === 'CALL' ? '📈' : '📉'} {rec.direction}
                    </span>
                    <span className="text-[12px] font-bold text-gray-800 dark:text-zinc-200">
                      {getSymbolDisplayName(rec.symbol)}
                    </span>
                    <span className="text-[9px] text-gray-400 dark:text-zinc-600 font-mono">{rec.symbol}</span>
                    <ConfidenceBadge c={rec.confidence} />
                  </div>
                  {/* Stats row */}
                  <div className="flex items-center gap-3 flex-wrap mb-2">
                    <span className="font-mono tabular-nums font-bold text-rose-600 dark:text-rose-400 text-[13px]">
                      {rec.wr.toFixed(1)}% WR
                    </span>
                    <span className="text-[11px] text-gray-500 dark:text-zinc-500 font-mono">{rec.trades} trades</span>
                    {pnlStr && (
                      <span className={`text-[11px] font-mono font-semibold ${rec.pnl! >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                        {pnlStr} P&amp;L
                      </span>
                    )}
                  </div>
                  {/* Reason */}
                  <p className="text-[10px] text-gray-500 dark:text-zinc-500 leading-relaxed">{rec.reason}</p>
                  {err && <p className="text-[10px] text-rose-500 mt-1">⚠️ {err}</p>}
                </div>
                {/* Right: approve button */}
                <button
                  onClick={() => handleIndividual(rec)}
                  disabled={isP}
                  className="shrink-0 text-[11px] font-bold px-4 py-2.5 rounded-lg transition-colors border border-rose-500/30 bg-rose-500/10 hover:bg-rose-500/20 text-rose-700 dark:text-rose-400 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap self-start"
                >
                  {isP ? (
                    <span className="flex items-center gap-1.5">
                      <span className="animate-spin inline-block w-3 h-3 border-2 border-rose-400/30 border-t-rose-500 rounded-full" />
                      Applying…
                    </span>
                  ) : '✓ Approve Disable'}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Applied stubs */}
      {approved.size > 0 && (
        <div className="space-y-1">
          {[...approved].map(k => {
            const [sym, dir] = k.split(':');
            return (
              <div key={k} className="flex items-center gap-2 px-4 py-2 bg-emerald-500/5 border border-emerald-500/20 rounded-lg">
                <span className="text-emerald-500 text-sm">✅</span>
                <span className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
                  {dir} on {getSymbolDisplayName(sym!)} — disabled. Bot refreshes within 60 s.
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Bulk preview modal */}
      {showPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100 dark:border-zinc-800 flex items-start justify-between gap-3">
              <div>
                <h2 className="font-bold text-gray-900 dark:text-white text-sm">Bulk Approve — HIGH Confidence Disables</h2>
                <p className="text-[11px] text-gray-500 dark:text-zinc-400 mt-0.5">
                  Only {highConf.length} direction{highConf.length !== 1 ? 's' : ''} with ≥100 trades <strong>AND</strong> WR &lt;45%
                  will be disabled. Whole-symbol kills are never applied.
                </p>
              </div>
              <button onClick={() => setShowPreview(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-zinc-200 text-lg leading-none shrink-0">×</button>
            </div>
            <div className="px-5 py-3 space-y-2 max-h-64 overflow-y-auto">
              {highConf.map(r => (
                <div key={keyOf(r)} className="flex items-center justify-between gap-3 rounded-lg bg-rose-500/5 border border-rose-500/15 px-3 py-2">
                  <div>
                    <p className="font-semibold text-gray-900 dark:text-zinc-100 text-[12px] leading-tight">{getSymbolDisplayName(r.symbol)}</p>
                    <p className="text-[9px] text-gray-400 dark:text-zinc-600 font-mono">{r.symbol}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`text-[11px] font-bold px-2 py-0.5 rounded border ${
                      r.direction === 'PUT'
                        ? 'bg-rose-500/15 border-rose-500/30 text-rose-700 dark:text-rose-400'
                        : 'bg-amber-500/15 border-amber-500/30 text-amber-700 dark:text-amber-400'
                    }`}>
                      {r.direction === 'CALL' ? '📈' : '📉'} {r.direction}
                    </span>
                    <span className="text-[10px] text-gray-500 dark:text-zinc-500 font-mono">
                      {r.wr.toFixed(1)}% · {r.trades}t
                    </span>
                  </div>
                </div>
              ))}
            </div>
            {bulkError && (
              <div className="px-5 py-2 bg-rose-500/10 border-t border-rose-500/20 text-[11px] text-rose-600 dark:text-rose-400">
                ⚠️ {bulkError}
              </div>
            )}
            <div className="px-5 py-4 border-t border-gray-100 dark:border-zinc-800 flex items-center justify-end gap-2">
              <button onClick={() => setShowPreview(false)} className="text-[12px] text-gray-500 border border-gray-200 dark:border-zinc-700 px-4 py-2 rounded-lg bg-white dark:bg-transparent hover:bg-gray-50 transition-colors">
                Cancel
              </button>
              <button onClick={handleBulkApply} className="text-[12px] font-bold bg-rose-600 hover:bg-rose-700 text-white px-5 py-2 rounded-lg transition-colors flex items-center gap-1.5">
                🛡 Confirm Disable {highConf.length} Direction{highConf.length !== 1 ? 's' : ''}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
