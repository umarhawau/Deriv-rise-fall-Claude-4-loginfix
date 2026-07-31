"use client";

import { useState } from "react";
import { suggestThresholds } from "./suggest-action";
import type { BucketRow, SuggestResponse } from "./suggest-action";
import BacktestPanel from "@/components/admin/backtest-panel";

interface Props {
  overallBuckets: BucketRow[];
  callBuckets: BucketRow[];
  putBuckets: BucketRow[];
}

const THRESHOLD_LABELS: { key: keyof SuggestResponse["suggestions"]; label: string; mode: string; dir: string }[] = [
  { key: "sniperCallErMin",     label: "Sniper CALL",     mode: "Sniper",     dir: "CALL" },
  { key: "sniperPutErMin",      label: "Sniper PUT",      mode: "Sniper",     dir: "PUT"  },
  { key: "balancedCallErMin",   label: "Balanced CALL",   mode: "Balanced",   dir: "CALL" },
  { key: "balancedPutErMin",    label: "Balanced PUT",    mode: "Balanced",   dir: "PUT"  },
  { key: "aggressiveCallErMin", label: "Aggressive CALL", mode: "Aggressive", dir: "CALL" },
  { key: "aggressivePutErMin",  label: "Aggressive PUT",  mode: "Aggressive", dir: "PUT"  },
];

type Status = "idle" | "loading" | "review" | "applying" | "applied" | "error";

export default function CalibrationAISuggest({ overallBuckets, callBuckets, putBuckets }: Props) {
  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<SuggestResponse | null>(null);
  const [currentSettings, setCurrentSettings] = useState<Record<string, number>>({});
  const [errorMsg, setErrorMsg] = useState("");
  const [showThinking, setShowThinking] = useState(false);
  const [appliedMsg, setAppliedMsg] = useState("");

  async function handleSuggest() {
    setStatus("loading");
    setErrorMsg("");
    setResult(null);
    setShowThinking(false);

    try {
      // Fetch current settings first
      const settingsRes = await fetch("/api/settings");
      if (!settingsRes.ok) throw new Error("Failed to fetch current settings");
      const settingsData = await settingsRes.json();

      const currentSnap: { sniperCallErMin: number; sniperPutErMin: number; balancedCallErMin: number; balancedPutErMin: number; aggressiveCallErMin: number; aggressivePutErMin: number } = {
        sniperCallErMin:     parseFloat(settingsData.sniperCallErMin     ?? "0"),
        sniperPutErMin:      parseFloat(settingsData.sniperPutErMin      ?? "0"),
        balancedCallErMin:   parseFloat(settingsData.balancedCallErMin   ?? "0"),
        balancedPutErMin:    parseFloat(settingsData.balancedPutErMin    ?? "0"),
        aggressiveCallErMin: parseFloat(settingsData.aggressiveCallErMin ?? "0"),
        aggressivePutErMin:  parseFloat(settingsData.aggressivePutErMin  ?? "0"),
      };
      setCurrentSettings(currentSnap);

      // Call AI suggest route
      const result = await suggestThresholds({
        overallBuckets,
        callBuckets,
        putBuckets,
        currentSettings: currentSnap,
      });

      if (!result.success) throw new Error(result.error);
      setResult(result.data);
      setStatus("review");
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }

  async function handleApply() {
    if (!result) return;
    setStatus("applying");
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result.suggestions),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
      setAppliedMsg("Thresholds applied successfully. Reload the Settings page to confirm.");
      setStatus("applied");
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }

  function handleDismiss() {
    setStatus("idle");
    setResult(null);
    setErrorMsg("");
    setShowThinking(false);
  }

  // Determine delta arrow + colour
  function Delta({ current, suggested }: { current: number; suggested: number }) {
    const diff = suggested - current;
    if (Math.abs(diff) < 0.001) return <span className="text-gray-400 dark:text-zinc-600 font-mono text-xs">—</span>;
    const up = diff > 0;
    return (
      <span className={`font-mono text-xs font-bold ${up ? "text-amber-500 dark:text-amber-400" : "text-emerald-500 dark:text-emerald-400"}`}>
        {up ? "▲" : "▼"} {Math.abs(diff).toFixed(2)}
      </span>
    );
  }

  return (
    <div className="space-y-4">
      {/* ── Trigger button ── */}
      {(status === "idle" || status === "error") && (
        <div className="rounded-xl border border-violet-500/30 bg-violet-500/10 px-4 sm:px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex-1">
            <p className="text-sm font-bold text-violet-600 dark:text-violet-300">🤖 AI Threshold Suggestion</p>
            <p className="text-xs text-gray-500 dark:text-zinc-400 mt-0.5">
              Nemotron analyses your win-rate data and proposes optimal ER gate thresholds for each mode. Review before applying.
            </p>
            {status === "error" && (
              <p className="text-xs text-rose-500 dark:text-rose-400 mt-1.5 font-mono">⚠ {errorMsg}</p>
            )}
          </div>
          <button
            onClick={handleSuggest}
            className="shrink-0 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 active:bg-violet-700 text-white text-sm font-semibold transition-colors shadow-sm"
          >
            ✨ AI Suggest
          </button>
        </div>
      )}

      {/* ── Loading state ── */}
      {status === "loading" && (
        <div className="rounded-xl border border-violet-500/30 bg-violet-500/10 px-4 sm:px-5 py-5 flex items-center gap-3">
          <svg className="animate-spin h-5 w-5 text-violet-400 shrink-0" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <div>
            <p className="text-sm font-semibold text-violet-300">Nemotron is thinking…</p>
            <p className="text-xs text-zinc-400 mt-0.5">Analysing win-rate buckets and reasoning through optimal thresholds.</p>
          </div>
        </div>
      )}

      {/* ── Applied state ── */}
      {status === "applied" && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 sm:px-5 py-4 flex items-center justify-between gap-3">
          <p className="text-sm font-semibold text-emerald-400">✅ {appliedMsg}</p>
          <button onClick={handleDismiss} className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors">Dismiss</button>
        </div>
      )}

      {/* ── Review panel ── */}
      {(status === "review" || status === "applying") && result && (
        <div className="rounded-xl border border-violet-500/30 bg-[#0d0d14] overflow-hidden">

          {/* Header */}
          <div className="px-4 sm:px-5 py-4 border-b border-violet-500/20 flex items-center justify-between">
            <div>
              <p className="text-sm font-bold text-violet-300">🤖 AI Suggested Thresholds</p>
              <p className="text-xs text-zinc-500 mt-0.5">Review the proposal below. Changes are not applied until you confirm.</p>
            </div>
            <button
              onClick={handleDismiss}
              disabled={status === "applying"}
              className="text-zinc-500 hover:text-zinc-300 transition-colors text-lg leading-none disabled:opacity-40"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>

          {/* AI Reasoning */}
          <div className="px-4 sm:px-5 py-4 border-b border-zinc-800">
            <p className="text-xs font-semibold text-zinc-300 mb-1.5">💬 AI Reasoning</p>
            <p className="text-xs text-zinc-400 leading-relaxed">{result.reasoning}</p>

            {/* Thinking toggle — only if thinking content was returned */}
            {result.thinking && (
              <div className="mt-2">
                <button
                  onClick={() => setShowThinking((v) => !v)}
                  className="text-[10px] text-violet-500 hover:text-violet-300 transition-colors font-mono underline underline-offset-2"
                >
                  {showThinking ? "Hide chain-of-thought ▲" : "Show chain-of-thought ▼"}
                </button>
                {showThinking && (
                  <pre className="mt-2 text-[10px] text-zinc-500 font-mono whitespace-pre-wrap leading-relaxed max-h-64 overflow-y-auto border border-zinc-800 rounded-lg p-3 bg-zinc-900/60">
                    {result.thinking}
                  </pre>
                )}
              </div>
            )}
          </div>

          {/* Comparison table */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-zinc-900/80">
                  <th className="text-left px-4 py-2.5 text-zinc-400 font-semibold">Mode / Direction</th>
                  <th className="text-right px-4 py-2.5 text-zinc-400 font-semibold">Current</th>
                  <th className="text-right px-4 py-2.5 text-zinc-400 font-semibold">Suggested</th>
                  <th className="text-right px-4 py-2.5 text-zinc-400 font-semibold">Change</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {THRESHOLD_LABELS.map(({ key, label, dir }) => {
                  const cur = currentSettings[key] ?? 0;
                  const sug = result.suggestions[key] ?? 0;
                  const changed = Math.abs(sug - cur) > 0.001;
                  return (
                    <tr key={key} className={changed ? "bg-violet-500/5" : ""}>
                      <td className="px-4 py-2.5 text-zinc-200 font-medium">
                        <span className={`inline-block w-1.5 h-1.5 rounded-full mr-2 ${dir === "CALL" ? "bg-emerald-400" : "bg-rose-400"}`} />
                        {label}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-zinc-400">{cur.toFixed(2)}</td>
                      <td className={`px-4 py-2.5 text-right font-mono font-bold ${changed ? "text-violet-300" : "text-zinc-400"}`}>
                        {sug.toFixed(2)}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <Delta current={cur} suggested={sug} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Counterfactual Backtest */}
          <div className="px-4 sm:px-5 py-4 border-t border-zinc-800">
            <BacktestPanel
              key={JSON.stringify(result.suggestions)}
              mode={{ kind: "er-gate", proposed: result.suggestions }}
              defaultWindow={200}
            />
          </div>

          {/* Actions */}
          <div className="px-4 sm:px-5 py-4 border-t border-zinc-800 flex items-center justify-end gap-3">
            <button
              onClick={handleDismiss}
              disabled={status === "applying"}
              className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-40"
            >
              Dismiss
            </button>
            <button
              onClick={handleApply}
              disabled={status === "applying"}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 active:bg-violet-700 text-white text-xs font-bold transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
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
                "✅ Apply Thresholds"
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
