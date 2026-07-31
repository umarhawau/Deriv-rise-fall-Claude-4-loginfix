"use client";

import { useState } from "react";
import { analyzeLossPatterns } from "./analyze-action";
import type {
  BreakdownRow,
  LossPatternPayload as LossPatternRequest,
  LossPatternResponse,
  LossFinding,
} from "./analyze-action";

// ─── Shared breakdown data passed in from the server component ───────────────
interface Props {
  overall: LossPatternRequest["overall"];
  byHour:      BreakdownRow[];
  bySymbol:    BreakdownRow[];
  byMode:      BreakdownRow[];
  byDirection: BreakdownRow[];
  byDuration:  BreakdownRow[];
  byErBucket:  BreakdownRow[];
  byNoise:     BreakdownRow[];
}

// ─── Breakdown section ────────────────────────────────────────────────────────
function BreakdownTable({
  title,
  icon,
  rows,
  baselineLossRate,
  accentColor = "rose",
}: {
  title: string;
  icon: string;
  rows: BreakdownRow[];
  baselineLossRate: number;
  accentColor?: "rose" | "amber" | "violet";
}) {
  const maxRate = Math.max(...rows.map((r) => r.lossRate), 1);
  const colors = {
    rose:   { border: "border-rose-500/20",   header: "bg-rose-500/5",   bar: "bg-rose-500/50" },
    amber:  { border: "border-amber-500/20",  header: "bg-amber-500/5",  bar: "bg-amber-500/50" },
    violet: { border: "border-violet-500/20", header: "bg-violet-500/5", bar: "bg-violet-500/50" },
  }[accentColor];

  if (rows.length === 0) {
    return (
      <div className={`rounded-xl border ${colors.border} bg-white dark:bg-zinc-900/60 p-4 text-xs text-zinc-500`}>
        <span className="mr-1">{icon}</span>{title} — no data yet
      </div>
    );
  }

  return (
    <div className={`rounded-xl border ${colors.border} bg-white dark:bg-zinc-900/60 overflow-hidden`}>
      <div className={`px-4 py-3 border-b ${colors.border} ${colors.header} flex items-center gap-2`}>
        <span>{icon}</span>
        <span className="text-xs font-bold text-gray-800 dark:text-zinc-100">{title}</span>
        <span className="ml-auto text-[10px] text-zinc-500 font-mono">baseline {baselineLossRate.toFixed(1)}%</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-zinc-50 dark:bg-zinc-900/80">
              <th className="text-left px-4 py-2 text-zinc-400 font-semibold">Segment</th>
              <th className="text-right px-4 py-2 text-zinc-400 font-semibold">Total</th>
              <th className="text-right px-4 py-2 text-zinc-400 font-semibold">W / L</th>
              <th className="text-right px-4 py-2 text-zinc-400 font-semibold">Loss Rate</th>
              <th className="px-4 py-2 w-24 text-zinc-400 font-semibold">Bar</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
            {rows.map((row) => {
              const above = row.total >= 5 && row.lossRate - baselineLossRate > 8;
              const pct = (row.lossRate / maxRate) * 100;
              return (
                <tr key={row.label} className={above ? "bg-rose-500/5" : ""}>
                  <td className="px-4 py-2.5 font-medium text-zinc-800 dark:text-zinc-200">
                    {above && <span className="inline-block w-1.5 h-1.5 rounded-full bg-rose-500 mr-2 align-middle" />}
                    {row.label}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-zinc-500">{row.total}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-zinc-500">
                    <span className="text-emerald-500 dark:text-emerald-400">{row.wins}</span>
                    {" / "}
                    <span className="text-rose-500 dark:text-rose-400">{row.losses}</span>
                  </td>
                  <td className={`px-4 py-2.5 text-right font-mono font-bold ${above ? "text-rose-500 dark:text-rose-400" : "text-zinc-600 dark:text-zinc-400"}`}>
                    {row.total > 0 ? `${row.lossRate.toFixed(1)}%` : "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="w-full h-1.5 bg-zinc-200 dark:bg-zinc-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${above ? "bg-rose-500" : colors.bar}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Single AI finding card ───────────────────────────────────────────────────
function FindingCard({ f, baseline }: { f: LossFinding; baseline: number }) {
  const delta = f.lossRate - baseline;
  const sev = {
    high:   { bg: "bg-rose-500/10",   border: "border-rose-500/30",   badge: "bg-rose-500/20 text-rose-400",   label: "HIGH"   },
    medium: { bg: "bg-amber-500/10",  border: "border-amber-500/30",  badge: "bg-amber-500/20 text-amber-400",  label: "MEDIUM" },
    low:    { bg: "bg-zinc-800/60",   border: "border-zinc-700",      badge: "bg-zinc-700 text-zinc-400",       label: "LOW"    },
  }[f.severity];

  return (
    <div className={`rounded-xl border ${sev.border} ${sev.bg} px-4 py-3 space-y-1`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${sev.badge}`}>{sev.label}</span>
        <span className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider">{f.factor}</span>
        <span className="text-xs font-bold text-zinc-200">{f.label}</span>
        <span className="ml-auto font-mono text-xs font-bold text-rose-400">{f.lossRate.toFixed(1)}% loss</span>
        <span className="text-[10px] font-mono text-zinc-500">(+{delta.toFixed(1)}pp vs baseline)</span>
      </div>
      <p className="text-xs text-zinc-400 leading-relaxed">{f.finding}</p>
    </div>
  );
}

// ─── Main client component ────────────────────────────────────────────────────
type Status = "idle" | "loading" | "done" | "error";

export default function LossPatternsClient(props: Props) {
  const { overall, byHour, bySymbol, byMode, byDirection, byDuration, byErBucket, byNoise } = props;

  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<LossPatternResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [showThinking, setShowThinking] = useState(false);

  async function handleAnalyze() {
    setStatus("loading");
    setErrorMsg("");
    setResult(null);
    setShowThinking(false);

    try {
      const payload: LossPatternRequest = { overall, byHour, bySymbol, byMode, byDirection, byDuration, byErBucket, byNoise };
      const result = await analyzeLossPatterns(payload);
      if (!result.success) throw new Error(result.error);
      setResult(result.data);
      setStatus("done");
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }

  const sections = [
    { title: "Loss Rate by Time of Day (UTC)",   icon: "🕐", rows: byHour,      accentColor: "violet" as const },
    { title: "Loss Rate by Symbol",               icon: "💱", rows: bySymbol,    accentColor: "rose"   as const },
    { title: "Loss Rate by Trading Mode",         icon: "🎯", rows: byMode,      accentColor: "amber"  as const },
    { title: "Loss Rate by Direction",            icon: "⚖️", rows: byDirection, accentColor: "rose"   as const },
    { title: "Loss Rate by Trade Duration",       icon: "⏱️", rows: byDuration,  accentColor: "amber"  as const },
    { title: "Loss Rate by ER at Entry",          icon: "📈", rows: byErBucket,  accentColor: "violet" as const },
    { title: "Loss Rate by Noise at Entry",       icon: "📊", rows: byNoise,     accentColor: "rose"   as const },
  ];

  return (
    <div className="space-y-6">

      {/* ── Summary cards ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Resolved Trades", value: String(overall.resolved), color: "text-violet-400" },
          { label: "Winning Trades",  value: String(overall.wins),     color: "text-emerald-400" },
          { label: "Losing Trades",   value: String(overall.losses),   color: "text-rose-400" },
          { label: "Overall Loss Rate", value: `${overall.lossRate.toFixed(1)}%`, color: overall.lossRate > 55 ? "text-rose-400" : overall.lossRate > 45 ? "text-amber-400" : "text-emerald-400" },
        ].map(({ label, value, color }) => (
          <div key={label} className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 p-3 sm:p-4 space-y-1">
            <p className="text-[11px] text-gray-500 dark:text-zinc-500 font-medium">{label}</p>
            <p className={`text-xl font-bold tabular-nums ${color}`}>{value}</p>
          </div>
        ))}
      </div>

      {/* ── AI Analysis panel ── */}
      {status === "idle" && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 px-4 sm:px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex-1">
            <p className="text-sm font-bold text-rose-300">🤖 AI Loss Pattern Analysis</p>
            <p className="text-xs text-zinc-400 mt-0.5">
              Nemotron (reasoning mode) scans the breakdown data below to surface the most statistically significant loss patterns and explain them in plain English.
            </p>
          </div>
          <button
            onClick={handleAnalyze}
            disabled={overall.resolved < 10}
            title={overall.resolved < 10 ? "Need at least 10 resolved trades" : undefined}
            className="shrink-0 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 active:bg-rose-700 text-white text-sm font-semibold transition-colors shadow-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            🔍 Run Analysis
          </button>
        </div>
      )}

      {status === "error" && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 sm:px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex-1">
            <p className="text-sm font-bold text-rose-400">⚠ Analysis failed</p>
            <p className="text-xs text-zinc-400 font-mono mt-0.5">{errorMsg}</p>
          </div>
          <button
            onClick={handleAnalyze}
            className="shrink-0 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-sm font-semibold transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {status === "loading" && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 px-4 sm:px-5 py-5 flex items-center gap-3">
          <svg className="animate-spin h-5 w-5 text-rose-400 shrink-0" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <div>
            <p className="text-sm font-semibold text-rose-300">Nemotron is reasoning through the patterns…</p>
            <p className="text-xs text-zinc-400 mt-0.5">Scanning 7 dimensions against the {overall.losses}-trade loss dataset.</p>
          </div>
        </div>
      )}

      {status === "done" && result && (
        <div className="rounded-xl border border-rose-500/30 bg-[#0d0a0a] overflow-hidden">
          {/* Header */}
          <div className="px-4 sm:px-5 py-4 border-b border-rose-500/20 flex items-center justify-between">
            <div>
              <p className="text-sm font-bold text-rose-300">🤖 Loss Pattern Analysis Results</p>
              <p className="text-xs text-zinc-500 mt-0.5">{result.findings.length} pattern(s) identified · data breakdown below</p>
            </div>
            <button
              onClick={handleAnalyze}
              className="text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 hover:border-zinc-600 px-3 py-1.5 rounded-lg transition-colors"
            >
              ↺ Re-run
            </button>
          </div>

          {/* Summary */}
          <div className="px-4 sm:px-5 py-4 border-b border-zinc-800">
            <p className="text-xs font-semibold text-zinc-300 mb-1.5">📋 Summary</p>
            <p className="text-xs text-zinc-400 leading-relaxed">{result.summary}</p>
            {result.thinking && (
              <div className="mt-2">
                <button
                  onClick={() => setShowThinking((v) => !v)}
                  className="text-[10px] text-rose-500 hover:text-rose-300 transition-colors font-mono underline underline-offset-2"
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

          {/* Findings */}
          {result.findings.length > 0 ? (
            <div className="px-4 sm:px-5 py-4 space-y-2.5">
              <p className="text-xs font-semibold text-zinc-300 mb-3">🚩 Flagged Patterns</p>
              {result.findings.map((f, i) => (
                <FindingCard key={i} f={f} baseline={overall.lossRate} />
              ))}
            </div>
          ) : (
            <div className="px-4 sm:px-5 py-4">
              <p className="text-xs text-zinc-500">No significant patterns identified — loss distribution looks uniform across segments. Collect more data or check individual breakdowns below.</p>
            </div>
          )}
        </div>
      )}

      {/* ── Breakdown sections (always visible for manual verification) ── */}
      <div>
        <div className="flex items-center gap-3 mb-4">
          <span className="text-base">📉</span>
          <div>
            <h2 className="text-sm font-bold text-gray-900 dark:text-white">Loss Breakdown by Factor</h2>
            <p className="text-xs text-gray-500 dark:text-zinc-500">Raw data for each dimension — verify AI findings or explore manually. Red dot = loss rate &gt;8pp above baseline.</p>
          </div>
          <div className="flex-1 h-px bg-gray-200 dark:bg-zinc-800 ml-2 hidden sm:block" />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-5">
          {sections.map((s) => (
            <BreakdownTable
              key={s.title}
              title={s.title}
              icon={s.icon}
              rows={s.rows}
              baselineLossRate={overall.lossRate}
              accentColor={s.accentColor}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
