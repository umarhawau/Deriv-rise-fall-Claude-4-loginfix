"use client";

import { useState } from "react";
import { runBacktestAction } from "@/app/admin/_actions/backtest-action";
import type {
  BacktestMode,
  BacktestResult,
} from "@/app/admin/_actions/backtest-action";

interface Props {
  mode: BacktestMode;
  /** Default look-back window (number of resolved GHOST trades). */
  defaultWindow?: number;
}

const WINDOW_PRESETS = [50, 100, 200, 500, 1000];

function fmt(n: number | null, decimals = 1): string {
  return n != null ? n.toFixed(decimals) : "—";
}
function fmtPnl(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}`;
}

function StatCell({
  label,
  value,
  delta,
  higherIsBetter,
  unit = "",
}: {
  label: string;
  value: string;
  delta: number | null;
  higherIsBetter: boolean;
  unit?: string;
}) {
  const hasDelta = delta != null && Math.abs(delta) >= 0.01;
  const positive = delta != null && delta > 0;
  const good     = higherIsBetter ? positive : !positive;
  const deltaColor = hasDelta
    ? good ? "text-emerald-400" : "text-rose-400"
    : "text-zinc-600";
  const deltaText = hasDelta
    ? `${positive ? "+" : ""}${delta!.toFixed(unit === "pp" ? 1 : 2)}${unit}`
    : "—";

  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[9px] uppercase tracking-widest text-zinc-500 font-semibold">{label}</span>
      <span className="text-sm font-bold font-mono text-zinc-200">{value}</span>
      <span className={`text-[10px] font-bold font-mono ${deltaColor}`}>{deltaText}</span>
    </div>
  );
}

export default function BacktestPanel({ mode, defaultWindow = 200 }: Props) {
  const [windowSize, setWindowSize] = useState(defaultWindow);
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  async function handleRun() {
    setState("loading");
    setErrorMsg("");
    const res = await runBacktestAction(mode, windowSize);
    if (!res.success) {
      setErrorMsg(res.error);
      setState("error");
      return;
    }
    setResult(res.data);
    setState("done");
  }

  const r = result;

  return (
    <div className="rounded-xl border border-sky-500/25 bg-sky-500/5 overflow-hidden">
      {/* Header row */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-sky-500/20 flex-wrap gap-y-2">
        <div className="flex items-center gap-2">
          <span className="text-sm">📊</span>
          <div>
            <p className="text-xs font-bold text-sky-300">Counterfactual Backtest</p>
            <p className="text-[10px] text-zinc-500">
              Replay proposed change against recent historical trades before applying.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Window size selector */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-zinc-500">Last</span>
            <select
              value={windowSize}
              onChange={(e) => {
                setWindowSize(Number(e.target.value));
                setState("idle");
                setResult(null);
              }}
              className="bg-zinc-800 border border-zinc-700 text-xs text-zinc-300 rounded-md px-2 py-1 focus:outline-none focus:ring-1 focus:ring-sky-500/50"
            >
              {WINDOW_PRESETS.map((n) => (
                <option key={n} value={n}>{n} trades</option>
              ))}
            </select>
          </div>

          <button
            onClick={handleRun}
            disabled={state === "loading"}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 active:bg-sky-700 text-white text-xs font-bold transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {state === "loading" ? (
              <>
                <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Running…
              </>
            ) : state === "done" ? (
              "↺ Re-run"
            ) : (
              "▶ Run Backtest"
            )}
          </button>
        </div>
      </div>

      {/* Error */}
      {state === "error" && (
        <div className="px-4 py-3">
          <p className="text-[11px] text-rose-400">⚠ {errorMsg}</p>
        </div>
      )}

      {/* Idle hint */}
      {state === "idle" && (
        <div className="px-4 py-3">
          <p className="text-[11px] text-zinc-500 italic">
            Run the backtest to see how this proposal would have performed against recent historical trades.
          </p>
        </div>
      )}

      {/* Results */}
      {state === "done" && r && (
        <div className="px-4 py-4 space-y-4">
          {/* Loosening note */}
          {r.looseningNote && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/8 px-3 py-2">
              <p className="text-[10px] text-amber-400 leading-relaxed">
                ⚠ Proposed gate is looser or unchanged — trades filtered by the current gate were never logged, so their outcomes cannot be simulated. The table below reflects existing trades only.
              </p>
            </div>
          )}

          {/* Comparison grid */}
          <div className="grid grid-cols-2 gap-3">
            {/* Current column */}
            <div className="rounded-lg border border-zinc-700/60 bg-zinc-900/60 px-4 py-3 space-y-3">
              <p className="text-[9px] uppercase tracking-widest text-zinc-500 font-bold pb-1 border-b border-zinc-800">
                Current
              </p>
              <div className="grid grid-cols-2 gap-3">
                <StatCell
                  label="Trades"
                  value={String(r.current.tradeCount)}
                  delta={null}
                  higherIsBetter={false}
                />
                <StatCell
                  label="Win Rate"
                  value={r.current.winRate != null ? `${fmt(r.current.winRate)}%` : "—"}
                  delta={null}
                  higherIsBetter={true}
                />
                <StatCell
                  label="Wins / Losses"
                  value={`${r.current.wins} / ${r.current.losses}`}
                  delta={null}
                  higherIsBetter={true}
                />
                <StatCell
                  label="Total PnL"
                  value={`$${r.current.totalPnl.toFixed(2)}`}
                  delta={null}
                  higherIsBetter={true}
                />
              </div>
            </div>

            {/* Proposed column */}
            <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 px-4 py-3 space-y-3">
              <p className="text-[9px] uppercase tracking-widest text-sky-400 font-bold pb-1 border-b border-sky-500/20">
                Proposed
              </p>
              <div className="grid grid-cols-2 gap-3">
                <StatCell
                  label="Trades"
                  value={String(r.proposed.tradeCount)}
                  delta={r.proposed.tradeCount - r.current.tradeCount}
                  higherIsBetter={false}
                />
                <StatCell
                  label="Win Rate"
                  value={r.proposed.winRate != null ? `${fmt(r.proposed.winRate)}%` : "—"}
                  delta={r.winRateDelta}
                  higherIsBetter={true}
                  unit=" pp"
                />
                <StatCell
                  label="Wins / Losses"
                  value={`${r.proposed.wins} / ${r.proposed.losses}`}
                  delta={null}
                  higherIsBetter={true}
                />
                <StatCell
                  label="Total PnL"
                  value={`$${r.proposed.totalPnl.toFixed(2)}`}
                  delta={r.pnlDelta}
                  higherIsBetter={true}
                  unit=""
                />
              </div>
            </div>
          </div>

          {/* Summary bar */}
          <div className="rounded-lg bg-zinc-900/60 border border-zinc-800 px-4 py-3 flex flex-wrap gap-4 items-center justify-between">
            <div className="flex flex-wrap gap-4">
              {/* Win rate delta pill */}
              {r.winRateDelta != null && (
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-zinc-500">Win rate:</span>
                  <span className={`text-xs font-bold font-mono ${
                    r.winRateDelta > 0.05 ? "text-emerald-400"
                    : r.winRateDelta < -0.05 ? "text-rose-400"
                    : "text-zinc-400"
                  }`}>
                    {r.winRateDelta >= 0 ? "+" : ""}{r.winRateDelta.toFixed(1)} pp
                  </span>
                </div>
              )}
              {/* PnL delta pill */}
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-zinc-500">PnL impact:</span>
                <span className={`text-xs font-bold font-mono ${
                  r.pnlDelta > 0 ? "text-emerald-400"
                  : r.pnlDelta < 0 ? "text-rose-400"
                  : "text-zinc-400"
                }`}>
                  {fmtPnl(r.pnlDelta)}
                </span>
              </div>
              {/* Affected trades */}
              {r.tradesAffected !== 0 && (
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-zinc-500">Trades affected:</span>
                  <span className="text-xs font-bold font-mono text-amber-400">
                    {r.tradesAffected > 0 ? "−" : "+"}{Math.abs(r.tradesAffected)}
                  </span>
                </div>
              )}
            </div>
            <span className="text-[9px] text-zinc-600 italic">
              Based on last {r.windowSize} resolved GHOST trades
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
