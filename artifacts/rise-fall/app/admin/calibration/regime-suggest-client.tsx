"use client";

import { useState } from "react";
import { detectRegimeAndSuggest } from "./regime-action";
import type { RegimeActionResult, RegimeThresholds } from "./regime-action";
import BacktestPanel from "@/components/admin/backtest-panel";

type Status = "idle" | "loading" | "review" | "applying" | "applied" | "error";

const REGIME_COLORS: Record<string, string> = {
  TRENDING_BULLISH:  "border-emerald-500/40 bg-emerald-500/8 text-emerald-400",
  TRENDING_BEARISH:  "border-rose-500/40 bg-rose-500/8 text-rose-400",
  RANGING:           "border-sky-500/40 bg-sky-500/8 text-sky-400",
  HIGH_VOLATILITY:   "border-amber-500/40 bg-amber-500/8 text-amber-400",
  LOW_VOLATILITY:    "border-violet-500/40 bg-violet-500/8 text-violet-400",
  REGIME_SHIFT:      "border-orange-500/40 bg-orange-500/8 text-orange-400",
  INSUFFICIENT_DATA: "border-zinc-600 bg-zinc-800/40 text-zinc-400",
};

const CONFIDENCE_STYLES: Record<string, string> = {
  high:   "bg-emerald-500/15 border-emerald-500/30 text-emerald-400",
  medium: "bg-amber-500/15 border-amber-500/30 text-amber-400",
  low:    "bg-zinc-700/40 border-zinc-600 text-zinc-400",
};

const THRESHOLD_ROWS: { key: keyof RegimeThresholds; label: string; dir: "CALL" | "PUT"; mode: string }[] = [
  { key: "sniperCallErMin",     label: "Sniper CALL",     dir: "CALL", mode: "Sniper"     },
  { key: "sniperPutErMin",      label: "Sniper PUT",      dir: "PUT",  mode: "Sniper"     },
  { key: "balancedCallErMin",   label: "Balanced CALL",   dir: "CALL", mode: "Balanced"   },
  { key: "balancedPutErMin",    label: "Balanced PUT",    dir: "PUT",  mode: "Balanced"   },
  { key: "aggressiveCallErMin", label: "Aggressive CALL", dir: "CALL", mode: "Aggressive" },
  { key: "aggressivePutErMin",  label: "Aggressive PUT",  dir: "PUT",  mode: "Aggressive" },
];

function fmt(v: number | null): string {
  return v != null ? v.toFixed(2) : "—";
}
function fmtDelta(cur: number, sug: number): string {
  const d = sug - cur;
  if (Math.abs(d) < 0.001) return "—";
  return `${d > 0 ? "+" : ""}${d.toFixed(2)}`;
}
function deltaColor(cur: number, sug: number): string {
  const d = sug - cur;
  if (Math.abs(d) < 0.001) return "text-zinc-500";
  return d > 0 ? "text-amber-400" : "text-emerald-400";
}
function pct(v: number | null): string {
  return v != null ? `${v.toFixed(1)}%` : "—";
}
function dec(v: number | null): string {
  return v != null ? v.toFixed(3) : "—";
}
function pp(v: number | null): string {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)} pp`;
}

export default function RegimeSuggestClient() {
  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<RegimeActionResult | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [showThinking, setShowThinking] = useState(false);
  const [showSignals, setShowSignals] = useState(false);

  async function handleDetect() {
    setStatus("loading");
    setErrorMsg("");
    setResult(null);
    setShowThinking(false);
    setShowSignals(false);

    const res = await detectRegimeAndSuggest();
    if (!res.success) {
      setErrorMsg(res.error);
      setStatus("error");
      return;
    }
    setResult(res.data);
    setStatus("review");
  }

  async function handleApply() {
    if (!result) return;
    setStatus("applying");
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result.proposal.suggestedThresholds),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setStatus("applied");
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }

  function handleReset() {
    setStatus("idle");
    setResult(null);
    setErrorMsg("");
    setShowThinking(false);
    setShowSignals(false);
  }

  const { signals, proposal } = result ?? {};
  const regimeColor = proposal
    ? (REGIME_COLORS[proposal.regime] ?? "border-zinc-600 bg-zinc-800/40 text-zinc-400")
    : "";

  return (
    <div className="rounded-xl border border-zinc-700/60 bg-zinc-900/70 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-4 sm:px-5 py-4 border-b border-zinc-800">
        <div className="flex items-center gap-2.5">
          <span className="text-base">🌊</span>
          <div>
            <h3 className="text-sm font-semibold text-white">Regime-Adaptive Threshold Suggestions</h3>
            <p className="text-[10px] text-zinc-500 mt-0.5">
              Detects trending / ranging / volatility regime from recent trade data · Proposes temporary ER gate adjustments
            </p>
          </div>
        </div>

        {status === "idle" || status === "error" ? (
          <button
            onClick={handleDetect}
            className="shrink-0 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white text-xs font-bold transition-colors shadow-sm"
          >
            🔍 Detect Regime
          </button>
        ) : status === "loading" ? (
          <div className="shrink-0 inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-indigo-600/40 text-indigo-300 text-xs font-bold cursor-wait">
            <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Analysing…
          </div>
        ) : status === "applied" ? (
          <button onClick={handleReset} className="shrink-0 text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 px-3 py-2 rounded-lg transition-colors">
            ↺ Re-run
          </button>
        ) : (
          <button onClick={handleReset} className="shrink-0 text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
            Dismiss
          </button>
        )}
      </div>

      {/* Applied success banner */}
      {status === "applied" && (
        <div className="px-5 py-4 bg-emerald-500/10 border-b border-emerald-500/20">
          <p className="text-[12px] font-semibold text-emerald-400">
            ✅ Regime-adaptive thresholds applied. Bot will use the updated gates within 60 s.
          </p>
        </div>
      )}

      {/* Error */}
      {status === "error" && (
        <div className="px-5 py-4 bg-rose-500/10 border-b border-rose-500/20">
          <p className="text-[11px] text-rose-400">⚠️ {errorMsg}</p>
        </div>
      )}

      {/* Results */}
      {result && proposal && signals && status !== "idle" && (
        <div className="divide-y divide-zinc-800">

          {/* Regime classification badge */}
          <div className="px-5 py-4 flex flex-wrap items-start gap-3">
            <div className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-xl border text-sm font-bold ${regimeColor}`}>
              <span>{proposal.regimeEmoji}</span>
              <span>{proposal.regime.replace(/_/g, " ")}</span>
            </div>
            <span className={`inline-flex items-center px-2 py-1 rounded border text-[10px] font-bold ${CONFIDENCE_STYLES[proposal.confidence] ?? ""}`}>
              {proposal.confidence.toUpperCase()} CONFIDENCE
            </span>
          </div>

          {/* Summary */}
          <div className="px-5 py-4">
            <p className="text-[12px] text-zinc-300 leading-relaxed">{proposal.summary}</p>
            {proposal.reasoning && (
              <p className="text-[11px] text-zinc-500 mt-2 leading-relaxed">{proposal.reasoning}</p>
            )}
          </div>

          {/* Signal windows toggle */}
          <div className="px-5 py-3">
            <button
              onClick={() => setShowSignals((v) => !v)}
              className="text-[11px] text-indigo-400 hover:text-indigo-300 transition-colors flex items-center gap-1"
            >
              {showSignals ? "▾" : "▸"} {showSignals ? "Hide" : "Show"} performance signals
            </button>
            {showSignals && (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-[11px] min-w-[480px]">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-widest text-zinc-600 border-b border-zinc-800">
                      <th className="py-2 pr-3 text-left">Window</th>
                      <th className="py-2 px-2 text-right">Resolved</th>
                      <th className="py-2 px-2 text-right">WR</th>
                      <th className="py-2 px-2 text-right">CALL WR</th>
                      <th className="py-2 px-2 text-right">PUT WR</th>
                      <th className="py-2 px-2 text-right">Avg ER</th>
                      <th className="py-2 px-2 text-right">Avg |Z|</th>
                      <th className="py-2 px-2 text-right">Avg Noise</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[signals.window7d, signals.window30d, signals.windowAll].map((w) => (
                      <tr key={w.label} className="border-b border-zinc-800/50">
                        <td className="py-2 pr-3 font-semibold text-zinc-300">{w.label}</td>
                        <td className="py-2 px-2 text-right tabular-nums text-zinc-400">{w.totalResolved}</td>
                        <td className="py-2 px-2 text-right tabular-nums text-zinc-300 font-mono">{pct(w.overallWinRate)}</td>
                        <td className="py-2 px-2 text-right tabular-nums text-emerald-400 font-mono">{pct(w.callWinRate)}</td>
                        <td className="py-2 px-2 text-right tabular-nums text-rose-400 font-mono">{pct(w.putWinRate)}</td>
                        <td className="py-2 px-2 text-right tabular-nums text-zinc-400 font-mono">{dec(w.avgErAtEntry)}</td>
                        <td className="py-2 px-2 text-right tabular-nums text-zinc-400 font-mono">{dec(w.avgAbsZScore)}</td>
                        <td className="py-2 px-2 text-right tabular-nums text-zinc-400 font-mono">{dec(w.avgNoise)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {/* Shift indicators */}
                <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {[
                    { label: "CALL−PUT WR (7d)", value: pp(signals.callPutWrDelta7d), pos: (signals.callPutWrDelta7d ?? 0) > 0 },
                    { label: "WR trend (7d vs 30d)", value: pp(signals.wrTrend), pos: (signals.wrTrend ?? 0) > 0 },
                    { label: "ER shift (7d vs 30d)", value: pp(signals.erShift != null ? signals.erShift * 100 : null), pos: (signals.erShift ?? 0) > 0 },
                    { label: "Noise shift (7d vs 30d)", value: pp(signals.noiseShift != null ? signals.noiseShift * 100 : null), pos: (signals.noiseShift ?? 0) < 0 },
                  ].map((item) => (
                    <div key={item.label} className="bg-zinc-800/40 rounded-lg px-3 py-2">
                      <p className="text-[9px] uppercase tracking-widest text-zinc-600 mb-1">{item.label}</p>
                      <p className={`text-xs font-bold font-mono ${item.value === "—" ? "text-zinc-600" : item.pos ? "text-emerald-400" : "text-rose-400"}`}>
                        {item.value}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Threshold comparison table */}
          <div className="px-5 py-4">
            <p className="text-[10px] uppercase tracking-widest text-zinc-500 mb-3 font-semibold">
              Proposed Threshold Adjustments
            </p>
            <div className="overflow-x-auto rounded-lg border border-zinc-800">
              <table className="w-full text-xs min-w-[380px]">
                <thead>
                  <tr className="text-[10px] uppercase tracking-widest text-zinc-600 border-b border-zinc-800 bg-zinc-900/40">
                    <th className="px-4 py-2.5 text-left">Threshold</th>
                    <th className="px-4 py-2.5 text-right">Current</th>
                    <th className="px-4 py-2.5 text-right">Δ Change</th>
                    <th className="px-4 py-2.5 text-right">Proposed</th>
                  </tr>
                </thead>
                <tbody>
                  {THRESHOLD_ROWS.map(({ key, label, dir }) => {
                    const cur = proposal.currentThresholds[key];
                    const sug = proposal.suggestedThresholds[key];
                    const changed = Math.abs(sug - cur) > 0.001;
                    return (
                      <tr key={key} className={`border-b border-zinc-800/50 ${changed ? "bg-indigo-500/5" : ""}`}>
                        <td className="px-4 py-2.5 text-zinc-300 font-medium flex items-center gap-2">
                          <span className={`inline-block w-1.5 h-1.5 rounded-full ${dir === "CALL" ? "bg-emerald-400" : "bg-rose-400"}`} />
                          {label}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-zinc-500">{fmt(cur)}</td>
                        <td className={`px-4 py-2.5 text-right font-mono font-bold ${deltaColor(cur, sug)}`}>
                          {fmtDelta(cur, sug)}
                        </td>
                        <td className={`px-4 py-2.5 text-right font-mono font-bold ${changed ? "text-indigo-300" : "text-zinc-500"}`}>
                          {fmt(sug)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {THRESHOLD_ROWS.every(({ key }) => Math.abs(proposal.suggestedThresholds[key] - proposal.currentThresholds[key]) < 0.001) && (
              <p className="text-[11px] text-zinc-500 mt-2 italic">No threshold changes proposed — current settings are already appropriate for this regime.</p>
            )}
          </div>

          {/* Counterfactual Backtest */}
          <div className="px-5 py-4 border-t border-zinc-800">
            <BacktestPanel
              key={JSON.stringify(proposal.suggestedThresholds)}
              mode={{ kind: "er-gate", proposed: proposal.suggestedThresholds }}
              defaultWindow={200}
            />
          </div>

          {/* Thinking block */}
          {proposal.thinking && (
            <div className="px-5 py-3">
              <button
                onClick={() => setShowThinking((v) => !v)}
                className="text-[11px] text-zinc-500 hover:text-zinc-400 transition-colors flex items-center gap-1"
              >
                {showThinking ? "▾" : "▸"} {showThinking ? "Hide" : "Show"} model reasoning
              </button>
              {showThinking && (
                <pre className="mt-2 text-[10px] text-zinc-500 leading-relaxed whitespace-pre-wrap font-mono bg-zinc-950/60 rounded-lg p-3 max-h-48 overflow-y-auto border border-zinc-800">
                  {proposal.thinking}
                </pre>
              )}
            </div>
          )}

          {/* Action buttons */}
          {(status === "review" || status === "applying" || status === "error") && (
            <div className="px-5 py-4 flex items-center justify-end gap-3">
              <button
                onClick={handleReset}
                disabled={status === "applying"}
                className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors border border-zinc-700 px-4 py-2 rounded-lg bg-transparent disabled:opacity-40"
              >
                Dismiss
              </button>
              <button
                onClick={handleApply}
                disabled={
                  status === "applying" ||
                  THRESHOLD_ROWS.every(({ key }) =>
                    Math.abs(proposal.suggestedThresholds[key] - proposal.currentThresholds[key]) < 0.001
                  )
                }
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white text-xs font-bold transition-colors shadow-sm disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {status === "applying" ? (
                  <>
                    <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Applying…
                  </>
                ) : (
                  "✅ Apply Regime Adjustments"
                )}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
