'use client';

import type { SignalRecord, SignalOutcome } from '@/hooks/use-autotrade';

interface Props {
  records: SignalRecord[];
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString('en-GB', { hour12: false });
}

function fmtMs(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ─── Execution-lag badge ──────────────────────────────────────────────────────

function ExecBadge({ execMs }: { execMs: number }) {
  const colour =
    execMs < 200  ? 'text-emerald-600 dark:text-emerald-400' :
    execMs < 500  ? 'text-amber-600 dark:text-amber-400' :
                    'text-rose-500';
  return (
    <span className={`text-[8px] tabular-nums font-mono leading-none ${colour}`}>
      ⚡{execMs}ms
    </span>
  );
}

// ─── Voter icon ───────────────────────────────────────────────────────────────

function VoterDot({ v }: { v: 'CALL' | 'PUT' | 'NEUTRAL' }) {
  if (v === 'CALL') return (
    <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 text-[9px] font-bold leading-none">▲</span>
  );
  if (v === 'PUT') return (
    <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-rose-500/20 text-rose-500 text-[9px] font-bold leading-none">▼</span>
  );
  return (
    <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-muted/60 text-muted-foreground text-[9px] font-bold leading-none">—</span>
  );
}

// ─── Outcome pill ─────────────────────────────────────────────────────────────

function OutcomePill({ outcome, pnlDelta }: { outcome: SignalOutcome; pnlDelta: number }) {
  if (outcome === 'WIN') return (
    <span className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 text-[9px] font-bold whitespace-nowrap">
      ✓ WIN {pnlDelta !== 0 ? `+$${pnlDelta.toFixed(2)}` : ''}
    </span>
  );
  if (outcome === 'LOSS') return (
    <span className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 bg-rose-500/15 text-rose-500 text-[9px] font-bold whitespace-nowrap">
      ✗ LOSS {pnlDelta !== 0 ? `$${pnlDelta.toFixed(2)}` : ''}
    </span>
  );
  if (outcome === 'PENDING') return (
    <span className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 bg-amber-500/15 text-amber-600 dark:text-amber-400 text-[9px] font-bold animate-pulse whitespace-nowrap">
      ◉ LIVE
    </span>
  );
  return (
    <span className="inline-flex items-center rounded-full px-1.5 py-0.5 bg-muted/60 text-muted-foreground text-[9px] font-medium whitespace-nowrap">
      — DROP
    </span>
  );
}

// ─── Regime badge ─────────────────────────────────────────────────────────────

function RegimeBadge({ regime }: { regime: string }) {
  const cls =
    regime === 'TRENDING' ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' :
    regime === 'VOLATILE' ? 'bg-rose-500/15 text-rose-500' :
    'bg-amber-500/15 text-amber-600 dark:text-amber-400';
  const icon = regime === 'TRENDING' ? '⚡' : regime === 'VOLATILE' ? '⚠' : '↔';
  return (
    <span className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[8px] font-bold uppercase ${cls}`}>
      {icon} {regime.slice(0, 4)}
    </span>
  );
}

// ─── Gate meter — colour-coded ER / RT / Z cells ──────────────────────────────

function GateMeter({
  er,
  rTick,
  zScore,
}: {
  er: number;
  rTick: number | null;
  zScore: number | null;
}) {
  const erOk = er >= 0.40;
  const rtOk = rTick === null || (rTick >= 0.12 && rTick <= 0.88);
  const zOk  = zScore === null || Math.abs(zScore) <= 1.8;

  function Cell({ label, value, ok }: { label: string; value: string; ok: boolean }) {
    return (
      <span className={`inline-flex flex-col items-center gap-0 px-1 rounded text-[8px] leading-tight font-mono ${
        ok ? 'text-muted-foreground' : 'text-amber-600 dark:text-amber-400 font-bold'
      }`}>
        <span className="text-[7px] uppercase tracking-wide opacity-60">{label}</span>
        <span>{value}</span>
      </span>
    );
  }

  return (
    <div className="flex items-center gap-0.5">
      <Cell label="ER" value={er.toFixed(2)} ok={erOk} />
      <Cell label="RT" value={rTick !== null ? rTick.toFixed(2) : '—'} ok={rtOk} />
      <Cell label="Z"  value={zScore !== null ? Math.abs(zScore).toFixed(2) : '—'} ok={zOk} />
    </div>
  );
}

// ─── Summary stats ────────────────────────────────────────────────────────────

interface SummaryStats {
  total: number;
  pending: number;
  winRate: number | null;
  cumPnl: number;
  profitFactor: number | null;
  avgExecMs: number | null;
}

function computeSummary(records: SignalRecord[]): SummaryStats {
  const resolved  = records.filter(r => r.outcome === 'WIN' || r.outcome === 'LOSS');
  const wins      = resolved.filter(r => r.outcome === 'WIN');
  const losses    = resolved.filter(r => r.outcome === 'LOSS');
  const gross     = wins.reduce((s, r)   => s + r.pnlDelta, 0);
  const lossAmt   = losses.reduce((s, r) => s + Math.abs(r.pnlDelta), 0);
  const pf        = lossAmt > 0 ? gross / lossAmt : gross > 0 ? Infinity : null;

  // Average execution latency — only count records where executedAt was stamped
  const execSamples = records.filter(r => r.executedAt !== undefined && r.executedAt > r.timestamp);
  const avgExecMs   = execSamples.length > 0
    ? Math.round(execSamples.reduce((s, r) => s + (r.executedAt! - r.timestamp), 0) / execSamples.length)
    : null;

  return {
    total:        records.length,
    pending:      records.filter(r => r.outcome === 'PENDING').length,
    winRate:      resolved.length > 0 ? (wins.length / resolved.length) * 100 : null,
    cumPnl:       resolved.reduce((s, r) => s + r.pnlDelta, 0),
    profitFactor: pf !== null && isFinite(pf) ? pf : null,
    avgExecMs,
  };
}

// ─── Regime breakdown ─────────────────────────────────────────────────────────

function computeRegimeStats(records: SignalRecord[]) {
  const resolved = records.filter(r => r.outcome === 'WIN' || r.outcome === 'LOSS');
  const groups: Record<string, SignalRecord[]> = {};
  for (const r of resolved) {
    if (!groups[r.regime]) groups[r.regime] = [];
    groups[r.regime].push(r);
  }
  return Object.entries(groups).map(([regime, arr]) => {
    const wins    = arr.filter(r => r.outcome === 'WIN');
    const gross   = wins.reduce((s, r) => s + r.pnlDelta, 0);
    const lossAmt = arr.filter(r => r.outcome === 'LOSS').reduce((s, r) => s + Math.abs(r.pnlDelta), 0);
    const pf      = lossAmt > 0 ? gross / lossAmt : gross > 0 ? Infinity : 0;
    return {
      regime,
      vol:      arr.length,
      accuracy: ((wins.length / arr.length) * 100).toFixed(1),
      pf:       isFinite(pf) ? pf.toFixed(2) : '∞',
      pfNum:    isFinite(pf) ? pf : 999,
    };
  });
}

// ─── Inline PnL micro-bar ─────────────────────────────────────────────────────

function PnlBar({ pnl }: { pnl: number }) {
  if (pnl === 0) return null;
  const abs = Math.min(Math.abs(pnl), 20);
  const pct = (abs / 20) * 100;
  return (
    <div className="flex items-center gap-1 mt-0.5">
      {pnl > 0
        ? <div className="h-1 rounded-full bg-emerald-500/60" style={{ width: `${pct}%` }} />
        : <div className="h-1 rounded-full bg-rose-500/60 ml-auto" style={{ width: `${pct}%` }} />
      }
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function SignalHistoryPanel({ records }: Props) {
  const displayed   = [...records].reverse();
  const summary     = computeSummary(records);
  const regimes     = computeRegimeStats(records);
  const hasData     = records.length > 0;
  const hasResolved = records.some(r => r.outcome === 'WIN' || r.outcome === 'LOSS');

  // Colour coding for avg exec summary badge
  const execColour =
    summary.avgExecMs === null   ? 'text-muted-foreground' :
    summary.avgExecMs < 200      ? 'text-emerald-600 dark:text-emerald-400' :
    summary.avgExecMs < 500      ? 'text-amber-600 dark:text-amber-400' :
                                   'text-rose-500';

  return (
    <div className="space-y-3">

      {/* ── Summary header ────────────────────────────────────────────── */}
      {hasData && (
        <>
          <div className="grid grid-cols-4 gap-1.5">
            {/* Signals */}
            <div className="rounded-md border border-border/50 bg-muted/30 px-2 py-1.5 text-center">
              <p className="text-[9px] text-muted-foreground uppercase tracking-wide">Signals</p>
              <p className="text-sm font-bold tabular-nums">
                {summary.total}
                {summary.pending > 0 && (
                  <span className="text-[9px] text-amber-500 ml-0.5 font-normal">
                    +{summary.pending}
                  </span>
                )}
              </p>
            </div>

            {/* Win rate */}
            <div className="rounded-md border border-border/50 bg-muted/30 px-2 py-1.5 text-center">
              <p className="text-[9px] text-muted-foreground uppercase tracking-wide">Win %</p>
              <p className={`text-sm font-bold tabular-nums ${
                summary.winRate === null ? 'text-muted-foreground' :
                summary.winRate >= 55   ? 'text-emerald-600 dark:text-emerald-400' :
                summary.winRate < 45    ? 'text-rose-500' : ''
              }`}>
                {summary.winRate !== null ? `${summary.winRate.toFixed(0)}%` : '—'}
              </p>
            </div>

            {/* PnL */}
            <div className="rounded-md border border-border/50 bg-muted/30 px-2 py-1.5 text-center">
              <p className="text-[9px] text-muted-foreground uppercase tracking-wide">PnL</p>
              <p className={`text-sm font-bold tabular-nums ${
                summary.cumPnl > 0  ? 'text-emerald-600 dark:text-emerald-400' :
                summary.cumPnl < 0  ? 'text-rose-500' : 'text-muted-foreground'
              }`}>
                {summary.cumPnl >= 0 ? '+' : ''}${summary.cumPnl.toFixed(2)}
              </p>
            </div>

            {/* Profit Factor */}
            <div className="rounded-md border border-border/50 bg-muted/30 px-2 py-1.5 text-center">
              <p className="text-[9px] text-muted-foreground uppercase tracking-wide">PF</p>
              <p className={`text-sm font-bold tabular-nums ${
                summary.profitFactor === null ? 'text-muted-foreground' :
                summary.profitFactor >= 1.5   ? 'text-emerald-600 dark:text-emerald-400' :
                summary.profitFactor < 1.0    ? 'text-rose-500' : ''
              }`}>
                {summary.profitFactor !== null ? summary.profitFactor.toFixed(2) : '—'}
              </p>
            </div>
          </div>

          {/* Avg execution latency bar — only shown once we have exec samples */}
          {summary.avgExecMs !== null && (
            <div className="rounded-md border border-border/50 bg-muted/20 flex items-center justify-between px-3 py-1.5">
              <div className="flex items-center gap-1.5">
                <span className="text-[9px] text-muted-foreground uppercase tracking-wide font-semibold">
                  Avg Execution
                </span>
                <span className="text-[8px] text-muted-foreground/50">
                  (signal → contract open)
                </span>
              </div>
              <span className={`text-[11px] font-bold tabular-nums font-mono ${execColour}`}>
                {summary.avgExecMs < 1000
                  ? `${summary.avgExecMs}ms`
                  : `${(summary.avgExecMs / 1000).toFixed(2)}s`}
              </span>
            </div>
          )}
        </>
      )}

      {/* ── Regime breakdown ──────────────────────────────────────────── */}
      {hasResolved && regimes.length > 0 && (
        <div className="rounded-md border border-border/60 overflow-hidden">
          <div className="border-b border-border/40 bg-muted/30 grid grid-cols-4 px-2.5 py-1.5">
            <span className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wide">Regime</span>
            <span className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wide text-right">Acc.</span>
            <span className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wide text-right">Vol</span>
            <span className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wide text-right">PF</span>
          </div>
          {regimes.map(({ regime, vol, accuracy, pf, pfNum }) => (
            <div key={regime} className="grid grid-cols-4 px-2.5 py-1.5 border-b border-border/20 last:border-0">
              <span className={`text-[10px] font-medium ${
                regime === 'TRENDING' ? 'text-emerald-600 dark:text-emerald-400' :
                regime === 'VOLATILE' ? 'text-rose-500' :
                'text-amber-600 dark:text-amber-400'
              }`}>
                {regime === 'TRENDING' ? '⚡ Trend' : regime === 'VOLATILE' ? '⚠ Volatile' : '↔ Range'}
              </span>
              <span className="text-[10px] font-semibold tabular-nums text-right">{accuracy}%</span>
              <span className="text-[10px] tabular-nums text-muted-foreground text-right">{vol}</span>
              <span className={`text-[10px] font-semibold tabular-nums text-right ${
                parseFloat(pf) >= 1 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500'
              }`}>{pf}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── Signal log ────────────────────────────────────────────────── */}
      {hasData ? (
        <div className="rounded-md border border-border/60 overflow-hidden">
          {/* Header */}
          <div className="grid border-b border-border/40 bg-muted/30 px-2 py-1.5"
            style={{ gridTemplateColumns: '52px 34px 52px 1fr 36px 1fr' }}>
            <span className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wide">Time</span>
            <span className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wide">Dir</span>
            <span className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wide text-center">Engine</span>
            <span className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wide">Gates</span>
            <span className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wide text-right">$</span>
            <span className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wide text-right">Result</span>
          </div>

          {/* Rows */}
          {displayed.map((r, i) => {
            const isWin     = r.outcome === 'WIN';
            const isLoss    = r.outcome === 'LOSS';
            const isPending = r.outcome === 'PENDING';
            const execMs    = r.executedAt !== undefined ? r.executedAt - r.timestamp : null;
            const rowBg =
              isWin     ? 'bg-emerald-500/[0.04]' :
              isLoss    ? 'bg-rose-500/[0.04]'    :
              isPending ? 'bg-amber-500/[0.03]'   :
              i % 2 === 1 ? 'bg-muted/10' : '';

            return (
              <div
                key={r.id}
                className={`grid items-center border-b border-border/15 last:border-0 px-2 py-1.5 ${rowBg}`}
                style={{ gridTemplateColumns: '52px 34px 52px 1fr 36px 1fr' }}
              >
                {/* Time + regime + exec lag */}
                <div className="flex flex-col gap-0.5">
                  <span className="text-[9px] tabular-nums text-muted-foreground leading-none">
                    {fmtTime(r.timestamp)}
                  </span>
                  <RegimeBadge regime={r.regime} />
                  {execMs !== null && <ExecBadge execMs={execMs} />}
                </div>

                {/* Direction */}
                <div>
                  <span className={`text-[10px] font-black ${
                    r.direction === 'CALL'
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-rose-500'
                  }`}>
                    {r.direction === 'CALL' ? '▲' : '▼'}
                  </span>
                </div>

                {/* Voters (M / m / A) */}
                <div className="flex items-center justify-center gap-0.5">
                  <VoterDot v={r.voters.MACRO_VEL} />
                  <VoterDot v={r.voters.MICRO_VEL} />
                  <VoterDot v={r.voters.ACCEL} />
                </div>

                {/* Gate metrics */}
                <GateMeter er={r.gates.er} rTick={r.gates.rTick} zScore={r.gates.zScore} />

                {/* Stake */}
                <div className="text-right">
                  <span className="text-[9px] tabular-nums text-muted-foreground">
                    ${r.stake.toFixed(2)}
                  </span>
                </div>

                {/* Outcome + resolution time + PnL bar */}
                <div className="flex flex-col items-end gap-0.5">
                  <OutcomePill outcome={r.outcome} pnlDelta={r.pnlDelta} />
                  {r.resolvedAt && (
                    <span className="text-[8px] text-muted-foreground/50 tabular-nums">
                      {fmtMs(r.resolvedAt - r.timestamp)}
                    </span>
                  )}
                  {(isWin || isLoss) && r.pnlDelta !== 0 && (
                    <div className="w-full max-w-[56px]">
                      <PnlBar pnl={r.pnlDelta} />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-border/40 py-6 text-center">
          <p className="text-[10px] text-muted-foreground">No signals fired this session yet.</p>
          <p className="text-[9px] text-muted-foreground/50 mt-1">Enable the bot and wait for a 3/3 consensus.</p>
        </div>
      )}

      {/* ── Contract ID footer — only shown when resolved trades exist ── */}
      {hasResolved && (
        <p className="text-[8px] text-muted-foreground/40 text-right tabular-nums">
          Last contract: #{records.filter(r => r.contractId).at(-1)?.contractId ?? '—'}
        </p>
      )}
    </div>
  );
}
