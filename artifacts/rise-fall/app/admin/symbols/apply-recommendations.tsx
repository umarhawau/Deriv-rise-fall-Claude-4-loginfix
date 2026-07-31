'use client';

import { useState, useTransition } from 'react';
import { applyHighConfidenceDisablesAction } from './actions';
import { type HighConfidenceCandidate } from './constants';
import { getSymbolDisplayName } from '@/lib/active-symbols-display-names';

interface Props {
  candidates: HighConfidenceCandidate[];
}

export function ApplyRecommendations({ candidates }: Props) {
  const [showPreview, setShowPreview] = useState(false);
  const [result, setResult]           = useState<{ applied: number } | null>(null);
  const [error, setError]             = useState<string | null>(null);
  const [isPending, startTransition]  = useTransition();

  if (candidates.length === 0) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-1.5 font-medium">
        ✅ All high-confidence directions are healthy — no action needed
      </div>
    );
  }

  const callCount = candidates.filter(c => c.direction === 'CALL').length;
  const putCount  = candidates.filter(c => c.direction === 'PUT').length;

  function handleApply() {
    setError(null);
    startTransition(async () => {
      const res = await applyHighConfidenceDisablesAction(candidates);
      if (res.ok) {
        setResult({ applied: res.applied });
        setShowPreview(false);
      } else {
        setError(res.error ?? 'Unknown error');
      }
    });
  }

  if (result) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-violet-600 dark:text-violet-400 bg-violet-500/10 border border-violet-500/20 rounded-lg px-3 py-1.5 font-medium">
        ✅ Applied — {result.applied} direction{result.applied !== 1 ? 's' : ''} disabled. Bot filters refresh within 60 s.
      </div>
    );
  }

  return (
    <>
      {/* Trigger button */}
      <button
        onClick={() => setShowPreview(true)}
        className="flex items-center gap-1.5 text-[11px] font-semibold bg-rose-500/15 hover:bg-rose-500/25 text-rose-600 dark:text-rose-400 border border-rose-500/30 px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
      >
        <span className="text-sm">🛡</span>
        Preview High-Confidence Disables
        <span className="bg-rose-500 text-white text-[9px] font-bold rounded-full px-1.5 py-px ml-0.5">
          {candidates.length}
        </span>
      </button>

      {/* Preview Modal */}
      {showPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden">

            {/* Header */}
            <div className="px-5 py-4 border-b border-gray-100 dark:border-zinc-800 flex items-start justify-between gap-3">
              <div>
                <h2 className="font-bold text-gray-900 dark:text-white text-sm">Preview: High-Confidence Disables</h2>
                <p className="text-[11px] text-gray-500 dark:text-zinc-400 mt-0.5">
                  Only directions with ≥50 trades <strong>AND</strong> WR &lt;45% are included.
                  Whole-symbol kills are never applied automatically.
                </p>
              </div>
              <button
                onClick={() => setShowPreview(false)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-zinc-200 text-lg leading-none shrink-0"
              >×</button>
            </div>

            {/* Candidate list */}
            <div className="px-5 py-3 space-y-2 max-h-72 overflow-y-auto">
              {candidates.map((c, i) => (
                <div key={i} className="flex items-center justify-between gap-3 rounded-lg bg-rose-500/5 border border-rose-500/15 px-3 py-2">
                  <div>
                    <p className="font-semibold text-gray-900 dark:text-zinc-100 text-[12px] leading-tight">
                      {getSymbolDisplayName(c.symbol)}
                    </p>
                    <p className="text-[10px] text-gray-400 dark:text-zinc-600 font-mono">{c.symbol}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`text-[11px] font-bold px-2 py-0.5 rounded border ${
                      c.direction === 'PUT'
                        ? 'bg-rose-500/15 border-rose-500/30 text-rose-600 dark:text-rose-400'
                        : 'bg-amber-500/15 border-amber-500/30 text-amber-600 dark:text-amber-400'
                    }`}>
                      {c.direction === 'CALL' ? '📈' : '📉'} {c.direction} → <span className="line-through opacity-60">ON</span> OFF
                    </span>
                    <span className="text-[10px] text-gray-500 dark:text-zinc-500 font-mono tabular-nums">
                      {c.winRate.toFixed(1)}% WR · {c.trades} trades
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {/* Summary */}
            <div className="px-5 py-3 bg-gray-50 dark:bg-zinc-800/60 border-t border-gray-100 dark:border-zinc-800 text-[11px] text-gray-500 dark:text-zinc-400 space-y-0.5">
              <p>
                <span className="font-semibold text-gray-700 dark:text-zinc-200">
                  {candidates.length} direction{candidates.length !== 1 ? 's' : ''} will be disabled:
                </span>{' '}
                {callCount > 0 && <span className="text-amber-600 dark:text-amber-400 font-medium">{callCount} CALL{callCount > 1 ? 's' : ''}</span>}
                {callCount > 0 && putCount > 0 && ' · '}
                {putCount > 0  && <span className="text-rose-600 dark:text-rose-400 font-medium">{putCount} PUT{putCount > 1 ? 's' : ''}</span>}
              </p>
              <p>Bot filters refresh within 60 s. You can re-enable any direction individually at any time.</p>
            </div>

            {/* Error */}
            {error && (
              <div className="px-5 py-2 bg-rose-500/10 border-t border-rose-500/20 text-[11px] text-rose-600 dark:text-rose-400">
                ⚠️ {error}
              </div>
            )}

            {/* Footer actions */}
            <div className="px-5 py-4 border-t border-gray-100 dark:border-zinc-800 flex items-center justify-end gap-2">
              <button
                onClick={() => setShowPreview(false)}
                disabled={isPending}
                className="text-[12px] text-gray-500 dark:text-zinc-400 hover:text-gray-700 dark:hover:text-zinc-200 border border-gray-200 dark:border-zinc-700 px-4 py-2 rounded-lg transition-colors bg-white dark:bg-transparent disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleApply}
                disabled={isPending}
                className="text-[12px] font-bold bg-rose-600 hover:bg-rose-700 disabled:opacity-60 text-white px-5 py-2 rounded-lg transition-colors flex items-center gap-1.5"
              >
                {isPending ? (
                  <><span className="animate-spin inline-block w-3 h-3 border-2 border-white/30 border-t-white rounded-full" />Applying…</>
                ) : (
                  <>🛡 Confirm &amp; Apply {candidates.length} Disable{candidates.length !== 1 ? 's' : ''}</>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
