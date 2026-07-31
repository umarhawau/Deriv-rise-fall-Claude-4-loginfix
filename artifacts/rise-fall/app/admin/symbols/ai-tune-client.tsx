"use client";

import { useState, useTransition } from "react";
import { runAiTune } from "./ai-tune-action";
import type { SymbolTuneInput, AiTuneResponse, AiTuneProposal } from "./ai-tune-action";
import { setDirectionEnabledAction } from "./actions";
import { getSymbolDisplayName } from "@/lib/active-symbols-display-names";

interface Props {
  symbols: SymbolTuneInput[];
  breakevenPct: number;
  minTrades: number;
}

type Status = "idle" | "loading" | "review" | "applying" | "done" | "error";

const CONFIDENCE_STYLES = {
  high:   { badge: "bg-rose-500/20 text-rose-400 border-rose-500/30",   label: "HIGH"   },
  medium: { badge: "bg-amber-500/20 text-amber-400 border-amber-500/30", label: "MED"    },
  low:    { badge: "bg-zinc-700 text-zinc-400 border-zinc-600",          label: "LOW"    },
};

function DirectionBadge({ dir }: { dir: "CALL" | "PUT" }) {
  return (
    <span className={`inline-flex items-center gap-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded border ${
      dir === "CALL"
        ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
        : "bg-rose-500/15 text-rose-400 border-rose-500/30"
    }`}>
      {dir === "CALL" ? "↑" : "↓"} {dir}
    </span>
  );
}

function StateBadge({ enabled, size = "sm" }: { enabled: boolean; size?: "sm" | "xs" }) {
  const base = size === "xs" ? "text-[9px] px-1 py-0.5" : "text-[10px] px-1.5 py-0.5";
  return (
    <span className={`inline-flex items-center font-bold rounded border ${base} ${
      enabled
        ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
        : "bg-zinc-700 text-zinc-500 border-zinc-600"
    }`}>
      {enabled ? "ON" : "OFF"}
    </span>
  );
}

function ProposalRow({
  proposal,
  checked,
  applied,
  error,
  onChange,
}: {
  proposal: AiTuneProposal;
  checked: boolean;
  applied: boolean;
  error: string | null;
  onChange: (v: boolean) => void;
}) {
  const conf = CONFIDENCE_STYLES[proposal.confidence];
  const isDisable = proposal.action === "DISABLE";

  return (
    <tr className={`border-b border-zinc-800/60 transition-colors ${
      applied ? "opacity-40" : checked ? "bg-violet-500/5" : ""
    }`}>
      {/* Checkbox */}
      <td className="px-3 py-3">
        <input
          type="checkbox"
          checked={checked && !applied}
          disabled={applied}
          onChange={(e) => onChange(e.target.checked)}
          className="w-3.5 h-3.5 accent-violet-500 cursor-pointer disabled:cursor-not-allowed"
        />
      </td>

      {/* Symbol */}
      <td className="px-3 py-3">
        <p className="text-xs font-semibold text-zinc-200 leading-tight">{proposal.displayName}</p>
        <p className="text-[9px] text-zinc-600 font-mono leading-tight">{proposal.symbol}</p>
      </td>

      {/* Direction */}
      <td className="px-3 py-3"><DirectionBadge dir={proposal.direction} /></td>

      {/* Current → Suggested */}
      <td className="px-3 py-3">
        <div className="flex items-center gap-1.5">
          <StateBadge enabled={proposal.currentEnabled} size="xs" />
          <span className="text-zinc-600 text-[10px]">→</span>
          <StateBadge enabled={proposal.suggestedEnabled} size="xs" />
        </div>
      </td>

      {/* Action */}
      <td className="px-3 py-3">
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${
          isDisable
            ? "bg-rose-500/20 text-rose-400 border-rose-500/30"
            : "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
        }`}>
          {isDisable ? "DISABLE" : "ENABLE"}
        </span>
      </td>

      {/* Win Rate */}
      <td className="px-3 py-3 text-right">
        <span className={`font-mono text-xs font-bold ${
          proposal.winRate == null ? "text-zinc-600"
            : isDisable ? "text-rose-400" : "text-emerald-400"
        }`}>
          {proposal.winRate != null ? `${proposal.winRate.toFixed(1)}%` : "—"}
        </span>
        <p className="text-[9px] text-zinc-600 font-mono">{proposal.trades} trades</p>
      </td>

      {/* Confidence */}
      <td className="px-3 py-3">
        <span className={`text-[9px] font-bold px-1 py-0.5 rounded border ${conf.badge}`}>{conf.label}</span>
      </td>

      {/* Rationale */}
      <td className="px-3 py-3 max-w-xs">
        <p className="text-[10px] text-zinc-400 leading-relaxed">{proposal.rationale}</p>
        {error && <p className="text-[9px] text-rose-400 mt-0.5 font-mono">⚠ {error}</p>}
        {applied && <p className="text-[9px] text-emerald-400 mt-0.5 font-mono">✓ Applied</p>}
      </td>
    </tr>
  );
}

export default function AiTuneClient({ symbols, breakevenPct, minTrades }: Props) {
  const [status, setStatus]     = useState<Status>("idle");
  const [result, setResult]     = useState<AiTuneResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [showThinking, setShowThinking] = useState(false);

  // Selection state
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [applied,  setApplied]  = useState<Set<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Map<string, string>>(new Map());
  const [, startApply] = useTransition();

  const keyOf = (p: AiTuneProposal) => `${p.symbol}:${p.direction}`;

  async function handleAnalyze() {
    setStatus("loading");
    setErrorMsg("");
    setResult(null);
    setSelected(new Set());
    setApplied(new Set());
    setRowErrors(new Map());
    setShowThinking(false);

    try {
      const result = await runAiTune({ symbols, breakevenPct, minTrades });
      if (!result.success) throw new Error(result.error);
      const r = result.data;
      setResult(r);
      // Pre-select all high-confidence proposals
      setSelected(new Set(r.proposals.filter((p) => p.confidence === "high").map(keyOf)));
      setStatus("review");
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }

  function toggleAll(check: boolean) {
    if (!result) return;
    setSelected(check ? new Set(result.proposals.filter((p) => !applied.has(keyOf(p))).map(keyOf)) : new Set());
  }

  function handleApplySelected() {
    if (!result) return;
    const toApply = result.proposals.filter((p) => selected.has(keyOf(p)) && !applied.has(keyOf(p)));
    if (toApply.length === 0) return;

    setStatus("applying");

    startApply(async () => {
      const newErrors = new Map(rowErrors);
      const newApplied = new Set(applied);

      for (const proposal of toApply) {
        const res = await setDirectionEnabledAction(
          proposal.symbol,
          proposal.direction,
          proposal.suggestedEnabled,
        );
        if (res.ok) {
          newApplied.add(keyOf(proposal));
        } else {
          newErrors.set(keyOf(proposal), res.error ?? "Failed");
        }
      }

      setApplied(newApplied);
      setRowErrors(newErrors);
      setSelected(new Set());
      setStatus("review");
    });
  }

  const pendingCount = result
    ? result.proposals.filter((p) => selected.has(keyOf(p)) && !applied.has(keyOf(p))).length
    : 0;
  const appliedCount = applied.size;
  const hasSymbolsWithEnoughData = symbols.some(
    (s) => s.callTrades >= minTrades || s.putTrades >= minTrades,
  );

  return (
    <div className="space-y-3">
      {/* ── Trigger / idle ── */}
      {(status === "idle" || status === "error") && (
        <div className="rounded-xl border border-violet-500/30 bg-violet-500/5 px-4 sm:px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-violet-300">🤖 AI Symbol Auto-Tune</p>
            <p className="text-xs text-zinc-400 mt-0.5 leading-relaxed">
              Nemotron (reasoning mode) analyses each symbol's CALL and PUT performance separately and proposes enabling or disabling directions where data is statistically significant. You review and approve each change individually — nothing is applied automatically.
            </p>
            {!hasSymbolsWithEnoughData && (
              <p className="text-[10px] text-amber-400 mt-1.5 font-mono">
                ⚠ Waiting for symbols to reach {minTrades}+ resolved trades before analysis is meaningful.
              </p>
            )}
            {status === "error" && (
              <p className="text-[10px] text-rose-400 mt-1.5 font-mono">⚠ {errorMsg}</p>
            )}
          </div>
          <button
            onClick={handleAnalyze}
            className="shrink-0 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 active:bg-violet-700 text-white text-sm font-semibold transition-colors shadow-sm"
          >
            ✨ Run Analysis
          </button>
        </div>
      )}

      {/* ── Loading ── */}
      {status === "loading" && (
        <div className="rounded-xl border border-violet-500/30 bg-violet-500/5 px-4 sm:px-5 py-5 flex items-center gap-3">
          <svg className="animate-spin h-5 w-5 text-violet-400 shrink-0" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <div>
            <p className="text-sm font-semibold text-violet-300">Nemotron is reasoning through symbol performance…</p>
            <p className="text-xs text-zinc-500 mt-0.5">Analysing {symbols.length} symbols × 2 directions against breakeven threshold.</p>
          </div>
        </div>
      )}

      {/* ── Review panel ── */}
      {(status === "review" || status === "applying") && result && (
        <div className="rounded-xl border border-violet-500/30 bg-[#0d0d14] overflow-hidden">

          {/* Header */}
          <div className="px-4 sm:px-5 py-4 border-b border-violet-500/20 flex items-center justify-between gap-3 flex-wrap">
            <div>
              <p className="text-sm font-bold text-violet-300">🤖 AI Auto-Tune Proposals</p>
              <p className="text-xs text-zinc-500 mt-0.5">
                {result.proposals.length} proposal{result.proposals.length !== 1 ? "s" : ""}
                {appliedCount > 0 ? ` · ${appliedCount} applied` : ""}
                {" · "} tick the ones you want to apply
              </p>
            </div>
            <button
              onClick={handleAnalyze}
              disabled={status === "applying"}
              className="text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 hover:border-zinc-600 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-40"
            >
              ↺ Re-run
            </button>
          </div>

          {/* Summary + Thinking */}
          <div className="px-4 sm:px-5 py-4 border-b border-zinc-800">
            <p className="text-xs font-semibold text-zinc-300 mb-1.5">💬 AI Summary</p>
            <p className="text-xs text-zinc-400 leading-relaxed">{result.summary}</p>
            {result.thinking && (
              <div className="mt-2">
                <button
                  onClick={() => setShowThinking((v) => !v)}
                  className="text-[10px] text-violet-500 hover:text-violet-300 transition-colors font-mono underline underline-offset-2"
                >
                  {showThinking ? "Hide chain-of-thought ▲" : "Show chain-of-thought ▼"}
                </button>
                {showThinking && (
                  <pre className="mt-2 text-[10px] text-zinc-500 font-mono whitespace-pre-wrap leading-relaxed max-h-56 overflow-y-auto border border-zinc-800 rounded-lg p-3 bg-zinc-900/60">
                    {result.thinking}
                  </pre>
                )}
              </div>
            )}
          </div>

          {result.proposals.length === 0 ? (
            <div className="px-4 sm:px-5 py-6 text-center">
              <p className="text-xs text-zinc-500">No proposals — all enabled directions are performing within acceptable bounds, and no disabled direction has sufficient data to justify re-enabling.</p>
            </div>
          ) : (
            <>
              {/* Proposal table */}
              <div className="overflow-x-auto">
                <table className="w-full text-xs min-w-[700px]">
                  <thead>
                    <tr className="bg-zinc-900/80 border-b border-zinc-800">
                      <th className="px-3 py-2.5 text-left w-8">
                        <input
                          type="checkbox"
                          onChange={(e) => toggleAll(e.target.checked)}
                          checked={pendingCount > 0 && pendingCount === result.proposals.filter(p => !applied.has(keyOf(p))).length}
                          className="w-3.5 h-3.5 accent-violet-500 cursor-pointer"
                        />
                      </th>
                      <th className="px-3 py-2.5 text-left text-zinc-400 font-semibold">Symbol</th>
                      <th className="px-3 py-2.5 text-left text-zinc-400 font-semibold">Dir</th>
                      <th className="px-3 py-2.5 text-left text-zinc-400 font-semibold">Change</th>
                      <th className="px-3 py-2.5 text-left text-zinc-400 font-semibold">Action</th>
                      <th className="px-3 py-2.5 text-right text-zinc-400 font-semibold">Win Rate</th>
                      <th className="px-3 py-2.5 text-left text-zinc-400 font-semibold">Conf</th>
                      <th className="px-3 py-2.5 text-left text-zinc-400 font-semibold">Rationale</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.proposals.map((proposal) => {
                      const k = keyOf(proposal);
                      return (
                        <ProposalRow
                          key={k}
                          proposal={proposal}
                          checked={selected.has(k)}
                          applied={applied.has(k)}
                          error={rowErrors.get(k) ?? null}
                          onChange={(v) => setSelected((prev) => {
                            const next = new Set(prev);
                            v ? next.add(k) : next.delete(k);
                            return next;
                          })}
                        />
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Apply bar */}
              <div className="px-4 sm:px-5 py-4 border-t border-zinc-800 flex items-center justify-between gap-3">
                <p className="text-[10px] text-zinc-500">
                  {pendingCount} selected · changes take effect within 60 s (next config refresh)
                </p>
                <button
                  onClick={handleApplySelected}
                  disabled={pendingCount === 0 || status === "applying"}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 active:bg-violet-700 text-white text-xs font-bold transition-colors shadow-sm disabled:opacity-40 disabled:cursor-not-allowed"
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
                    `✅ Apply ${pendingCount > 0 ? pendingCount : ""} Selected`
                  )}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
