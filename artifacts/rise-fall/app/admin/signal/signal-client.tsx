'use client';

import { useState, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { getSymbolDisplayName } from '@/lib/active-symbols-display-names';

export interface ModeThresholds {
  erCall: number;
  erPut: number;
  zMax: number;
  exCall: number;
  exPut: number;
}

export interface SignalRow {
  id: number;
  symbol: string;
  direction: 'CALL' | 'PUT';
  executionType: 'LIVE' | 'GHOST';
  effectiveMode: 'SNIPER' | 'BALANCED' | 'AGGRESSIVE';
  status: 'WIN' | 'LOSS' | 'PENDING';
  er: number;
  z: number;
  noise: number;
  accel: number;
  erThresh: number;
  erPass: boolean;
  zThresh: number;
  zPass: boolean;
  exThresh: number;
  exPass: boolean;
  createdAt: string;
}

interface Props {
  signals: SignalRow[];
  thresholds: Record<string, ModeThresholds>;
  exFails: number;
}

type Mode = 'ALL' | 'SNIPER' | 'BALANCED' | 'AGGRESSIVE';
type ExecType = 'ALL' | 'LIVE' | 'GHOST';
type Direction = 'ALL' | 'CALL' | 'PUT';
type ModeKey = 'SNIPER' | 'BALANCED' | 'AGGRESSIVE';

const MODE_COLOR: Record<string, string> = {
  SNIPER:     'text-violet-400 bg-violet-500/10 border-violet-500/30',
  BALANCED:   'text-blue-400 bg-blue-500/10 border-blue-500/30',
  AGGRESSIVE: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
};
const MODE_ACCENT: Record<string, string> = {
  SNIPER: 'violet', BALANCED: 'blue', AGGRESSIVE: 'amber',
};
const MODE_ICON: Record<string, string> = {
  SNIPER: '🎯', BALANCED: '⚖️', AGGRESSIVE: '⚡',
};

function computeGates(row: SignalRow, t: ModeThresholds) {
  const erThresh = row.direction === 'CALL' ? t.erCall : t.erPut;
  const erPass   = row.er >= erThresh;
  const zPass    = row.z <= t.zMax;
  const exThresh = row.direction === 'CALL' ? t.exCall : t.exPut;
  const exPass   = row.direction === 'CALL' ? row.noise <= t.exCall : row.noise >= t.exPut;
  return { erThresh, erPass, zThresh: t.zMax, zPass, exThresh, exPass };
}

// ── Sub-components ─────────────────────────────────────────────────────────

function GateBadge({ pass, value, threshold, label, inverted = false }: {
  pass: boolean; value: number; threshold: number; label: string; inverted?: boolean;
}) {
  const margin = inverted ? threshold - value : value - threshold;
  const pct = Math.abs(margin / (Math.abs(threshold) || 1)) * 100;
  return (
    <div className={`flex flex-col items-center gap-0.5 px-2 py-1.5 rounded-lg border text-center min-w-[58px] ${
      pass ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-rose-500/30 bg-rose-500/5'
    }`}>
      <span className="text-[9px] uppercase tracking-widest text-zinc-500">{label}</span>
      <span className={`text-xs font-bold font-mono ${pass ? 'text-emerald-400' : 'text-rose-400'}`}>
        {value.toFixed(3)}
      </span>
      <span className={`text-[9px] font-mono ${pass ? 'text-emerald-600' : 'text-rose-600'}`}>
        {pass ? '✓' : '✗'} {threshold.toFixed(2)}
      </span>
      <span className={`text-[9px] font-mono ${margin >= 0 ? 'text-emerald-500/70' : 'text-rose-500/70'}`}>
        {margin >= 0 ? '+' : ''}{pct.toFixed(0)}%
      </span>
    </div>
  );
}

function FilterBtn<T extends string>({ value, active, onClick, children }: {
  value: T; active: boolean; onClick: (v: T) => void; children: React.ReactNode;
}) {
  return (
    <button
      onClick={() => onClick(value)}
      className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-all ${
        active ? 'bg-violet-600 text-white' : 'text-zinc-400 hover:text-white bg-zinc-800/50'
      }`}
    >
      {children}
    </button>
  );
}

function SimSlider({
  label, value, min, max, step, live, onChange, accentColor,
}: {
  label: string; value: number; min: number; max: number; step: number;
  live: number; onChange: (v: number) => void; accentColor: string;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  const livePct = ((live - min) / (max - min)) * 100;
  const changed = Math.abs(value - live) > step * 0.4;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[10px]">
        <span className="text-zinc-400">{label}</span>
        <div className="flex items-center gap-1.5">
          {changed && (
            <span className="text-zinc-600 font-mono line-through">{live.toFixed(2)}</span>
          )}
          <span className={`font-bold font-mono ${changed ? `text-${accentColor}-400` : 'text-zinc-300'}`}>
            {value.toFixed(2)}
          </span>
        </div>
      </div>
      <div className="relative h-5 flex items-center">
        {/* Live marker */}
        <div
          className="absolute w-0.5 h-3 bg-zinc-600 rounded-full pointer-events-none z-10"
          style={{ left: `${livePct}%` }}
          title={`Live: ${live.toFixed(2)}`}
        />
        <input
          type="range"
          min={min} max={max} step={step}
          value={value}
          onChange={e => onChange(Number(e.target.value))}
          className="w-full h-1 appearance-none rounded-full cursor-pointer bg-zinc-700 accent-violet-500"
          style={{ accentColor: accentColor === 'violet' ? '#7c3aed' : accentColor === 'blue' ? '#2563eb' : '#d97706' }}
        />
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

// Maps each ModeThresholds key → the system_settings field name for PATCH
const FIELD_MAP: Record<ModeKey, Record<keyof ModeThresholds, string>> = {
  SNIPER:     { erCall: 'sniperCallErMin',     erPut: 'sniperPutErMin',     zMax: 'sniperZMax',     exCall: 'sniperExhaustionCall',     exPut: 'sniperExhaustionPut'     },
  BALANCED:   { erCall: 'balancedCallErMin',   erPut: 'balancedPutErMin',   zMax: 'balancedZMax',   exCall: 'balancedExhaustionCall',   exPut: 'balancedExhaustionPut'   },
  AGGRESSIVE: { erCall: 'aggressiveCallErMin', erPut: 'aggressivePutErMin', zMax: 'aggressiveZMax', exCall: 'aggressiveExhaustionCall', exPut: 'aggressiveExhaustionPut' },
};

export function SignalClient({ signals, thresholds }: Props) {
  const router = useRouter();
  const [modeFilter, setModeFilter] = useState<Mode>('ALL');
  const [execFilter, setExecFilter] = useState<ExecType>('ALL');
  const [dirFilter, setDirFilter] = useState<Direction>('ALL');
  const [gateFilter, setGateFilter] = useState<'ALL' | 'PASS' | 'FAIL'>('ALL');
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(50);

  // ── Simulator state ──────────────────────────────────────────────────────
  const [simOpen, setSimOpen] = useState(true);
  const [simThresholds, setSimThresholds] = useState<Record<ModeKey, ModeThresholds>>({
    SNIPER:     { ...thresholds.SNIPER },
    BALANCED:   { ...thresholds.BALANCED },
    AGGRESSIVE: { ...thresholds.AGGRESSIVE },
  });

  const simActive = useMemo(() => {
    return (['SNIPER', 'BALANCED', 'AGGRESSIVE'] as ModeKey[]).some(m =>
      simThresholds[m].erCall  !== thresholds[m].erCall  ||
      simThresholds[m].erPut   !== thresholds[m].erPut   ||
      simThresholds[m].zMax    !== thresholds[m].zMax    ||
      simThresholds[m].exCall  !== thresholds[m].exCall  ||
      simThresholds[m].exPut   !== thresholds[m].exPut
    );
  }, [simThresholds, thresholds]);

  const updateSim = useCallback((mode: ModeKey, key: keyof ModeThresholds, val: number) => {
    setSimThresholds(prev => ({
      ...prev,
      [mode]: { ...prev[mode], [key]: val },
    }));
  }, []);

  const resetSim = useCallback(() => {
    setSimThresholds({
      SNIPER:     { ...thresholds.SNIPER },
      BALANCED:   { ...thresholds.BALANCED },
      AGGRESSIVE: { ...thresholds.AGGRESSIVE },
    });
  }, [thresholds]);

  // ── Commit simulator thresholds → system_settings ────────────────────────
  const [commitState, setCommitState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [commitError, setCommitError] = useState('');

  const handleCommit = useCallback(async () => {
    setCommitState('loading');
    setCommitError('');
    const body: Record<string, number> = {};
    for (const mode of ['SNIPER', 'BALANCED', 'AGGRESSIVE'] as ModeKey[]) {
      for (const [key, field] of Object.entries(FIELD_MAP[mode])) {
        body[field] = simThresholds[mode][key as keyof ModeThresholds];
      }
    }
    try {
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setCommitState('success');
      router.refresh(); // live thresholds card re-renders from DB
      setTimeout(() => setCommitState('idle'), 4000);
    } catch (err) {
      setCommitState('error');
      setCommitError(err instanceof Error ? err.message : 'Unknown error');
    }
  }, [simThresholds, router]);

  // ── Re-evaluate gates against live or sim thresholds ────────────────────
  const enrichedSignals = useMemo(() => {
    if (!simActive) return signals;
    return signals.map(row => ({
      ...row,
      ...computeGates(row, simThresholds[row.effectiveMode]),
    }));
  }, [signals, simActive, simThresholds]);

  // ── Simulator stats across all 300 signals ───────────────────────────────
  const livePassAll = useMemo(() =>
    signals.filter(s => s.erPass && s.zPass && s.exPass).length, [signals]);

  const simStats = useMemo(() => {
    const all = enrichedSignals;
    const passAll = all.filter(s => s.erPass && s.zPass && s.exPass).length;
    const erFail  = all.filter(s => !s.erPass).length;
    const zFail   = all.filter(s => !s.zPass).length;
    const exFail  = all.filter(s => !s.exPass).length;
    return { passAll, erFail, zFail, exFail, total: all.length };
  }, [enrichedSignals]);

  // ── Filters applied to (possibly-enriched) signal list ──────────────────
  const filtered = useMemo(() => {
    return enrichedSignals.filter(s => {
      if (modeFilter !== 'ALL' && s.effectiveMode !== modeFilter) return false;
      if (execFilter !== 'ALL' && s.executionType !== execFilter) return false;
      if (dirFilter !== 'ALL' && s.direction !== dirFilter) return false;
      if (gateFilter === 'PASS' && !(s.erPass && s.zPass && s.exPass)) return false;
      if (gateFilter === 'FAIL' && (s.erPass && s.zPass && s.exPass)) return false;
      if (search) {
        const name = getSymbolDisplayName(s.symbol).toLowerCase();
        if (!name.includes(search.toLowerCase()) && !s.symbol.toLowerCase().includes(search.toLowerCase())) return false;
      }
      return true;
    });
  }, [enrichedSignals, modeFilter, execFilter, dirFilter, gateFilter, search]);

  const displayed = filtered.slice(0, limit);

  const diff = simStats.passAll - livePassAll;

  return (
    <div className="space-y-6">

      {/* ── Live Thresholds Reference ── */}
      <section>
        <h2 className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3">
          Live Thresholds (from system_settings)
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {(['SNIPER', 'BALANCED', 'AGGRESSIVE'] as ModeKey[]).map(mode => {
            const t = thresholds[mode];
            return (
              <div key={mode} className={`rounded-xl border p-4 ${MODE_COLOR[mode]}`}>
                <div className="flex items-center gap-2 mb-3">
                  <span>{MODE_ICON[mode]}</span>
                  <span className="text-xs font-bold uppercase tracking-widest">{mode}</span>
                </div>
                <div className="grid grid-cols-2 gap-1 text-[11px] font-mono">
                  <span className="text-zinc-400">ER ↑ CALL</span>
                  <span className="text-emerald-400 font-bold">≥ {t.erCall.toFixed(4)}</span>
                  <span className="text-zinc-400">ER ↓ PUT</span>
                  <span className="text-rose-400 font-bold">≥ {t.erPut.toFixed(4)}</span>
                  <span className="text-zinc-400">|Z| max</span>
                  <span className="text-zinc-200 font-bold">≤ {t.zMax.toFixed(2)}</span>
                  <span className="text-zinc-400">Exh. CALL</span>
                  <span className="text-emerald-400/70 font-bold">≤ {t.exCall.toFixed(2)}</span>
                  <span className="text-zinc-400">Exh. PUT</span>
                  <span className="text-rose-400/70 font-bold">≥ {t.exPut.toFixed(2)}</span>
                </div>
              </div>
            );
          })}
        </div>
        <p className="text-[10px] text-zinc-600 mt-2">
          ⚠ Gate pass/fail is computed against <span className="text-zinc-400">current</span> thresholds, not the thresholds active when each trade fired.
        </p>
      </section>

      {/* ── What-If Simulator ── */}
      <section className={`rounded-xl border transition-colors ${simActive ? 'border-violet-500/40 bg-violet-950/10' : 'border-zinc-800 bg-zinc-900/30'}`}>
        {/* Header */}
        <button
          onClick={() => setSimOpen(o => !o)}
          className="w-full flex items-center justify-between px-4 py-3 text-left"
        >
          <div className="flex items-center gap-2">
            <span className="text-sm">🧪</span>
            <span className="text-sm font-bold text-white">What-If Simulator</span>
            {simActive && (
              <span className="px-2 py-0.5 rounded-full bg-violet-500/20 border border-violet-500/40 text-[10px] font-bold text-violet-400 uppercase tracking-widest">
                ACTIVE
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {simActive && (
              <>
                <button
                  onClick={e => { e.stopPropagation(); resetSim(); }}
                  className="px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-[10px] text-zinc-300 font-semibold transition-colors"
                >
                  Reset to live
                </button>
                <button
                  onClick={e => { e.stopPropagation(); void handleCommit(); }}
                  disabled={commitState === 'loading'}
                  className={`px-3 py-1 rounded-lg text-[10px] font-bold transition-all border ${
                    commitState === 'loading' ? 'bg-zinc-800 border-zinc-700 text-zinc-500 cursor-wait'
                    : commitState === 'success' ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400'
                    : commitState === 'error'   ? 'bg-rose-500/20 border-rose-500/50 text-rose-400'
                    : 'bg-violet-600 hover:bg-violet-500 border-violet-500 text-white'
                  }`}
                >
                  {commitState === 'loading' ? '⏳ Saving…'
                    : commitState === 'success' ? '✓ Saved!'
                    : commitState === 'error'   ? '✗ Failed'
                    : '💾 Commit to Settings'}
                </button>
              </>
            )}
            <span className="text-zinc-500 text-xs">{simOpen ? '▲' : '▼'}</span>
          </div>
        </button>

        {simOpen && (
          <div className="px-4 pb-4 space-y-4">

            {/* Live vs Sim summary bar */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {[
                {
                  label: 'Pass All Gates',
                  live: livePassAll,
                  sim: simStats.passAll,
                  color: 'text-emerald-400',
                  liveColor: 'text-emerald-600',
                },
                {
                  label: 'ER Fails',
                  live: signals.filter(s => !s.erPass).length,
                  sim: simStats.erFail,
                  color: 'text-rose-400',
                  liveColor: 'text-rose-600',
                },
                {
                  label: 'Z Fails',
                  live: signals.filter(s => !s.zPass).length,
                  sim: simStats.zFail,
                  color: 'text-amber-400',
                  liveColor: 'text-amber-600',
                },
                {
                  label: 'Exh. Fails',
                  live: signals.filter(s => !s.exPass).length,
                  sim: simStats.exFail,
                  color: 'text-blue-400',
                  liveColor: 'text-blue-600',
                },
              ].map(c => {
                const d = c.sim - c.live;
                return (
                  <div key={c.label} className="rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2">
                    <div className="text-[9px] text-zinc-500 uppercase tracking-widest mb-1">{c.label}</div>
                    <div className="flex items-end gap-1.5">
                      <span className={`text-lg font-bold font-mono ${simActive ? c.color : 'text-zinc-400'}`}>
                        {simActive ? c.sim : c.live}
                      </span>
                      {simActive && (
                        <span className={`text-xs font-bold font-mono mb-0.5 ${d > 0 ? 'text-emerald-500' : d < 0 ? 'text-rose-500' : 'text-zinc-600'}`}>
                          {d > 0 ? `+${d}` : d === 0 ? '=' : d}
                        </span>
                      )}
                    </div>
                    {simActive && (
                      <div className={`text-[9px] font-mono ${c.liveColor}`}>live: {c.live}</div>
                    )}
                  </div>
                );
              })}
            </div>

            {commitState === 'error' && (
              <div className="text-xs px-3 py-2 rounded-lg border border-rose-500/40 bg-rose-500/5 text-rose-400">
                ✗ Failed to save: {commitError} — check the API logs.
              </div>
            )}

            {simActive && (
              <div className={`text-xs font-semibold px-3 py-2 rounded-lg border ${
                diff > 0 ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-400'
                : diff < 0 ? 'border-rose-500/30 bg-rose-500/5 text-rose-400'
                : 'border-zinc-700 bg-zinc-800/50 text-zinc-400'
              }`}>
                {diff > 0
                  ? `✓ These thresholds would admit ${diff} more trade${diff === 1 ? '' : 's'} from the last ${simStats.total} resolved signals.`
                  : diff < 0
                  ? `✗ These thresholds would block ${Math.abs(diff)} trade${Math.abs(diff) === 1 ? '' : 's'} that currently pass.`
                  : `= No change in pass count vs live thresholds.`}
                {' '}The table below is updated live.
              </div>
            )}

            {/* Sliders per mode */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {(['SNIPER', 'BALANCED', 'AGGRESSIVE'] as ModeKey[]).map(mode => {
                const sim = simThresholds[mode];
                const live = thresholds[mode];
                const accent = MODE_ACCENT[mode];
                return (
                  <div key={mode} className={`rounded-xl border p-4 space-y-3 ${MODE_COLOR[mode]}`}>
                    <div className="flex items-center gap-2">
                      <span>{MODE_ICON[mode]}</span>
                      <span className="text-xs font-bold uppercase tracking-widest">{mode}</span>
                    </div>
                    <SimSlider
                      label="ER Floor — CALL ≥"
                      value={sim.erCall} min={0} max={1} step={0.01}
                      live={live.erCall} accentColor={accent}
                      onChange={v => updateSim(mode, 'erCall', v)}
                    />
                    <SimSlider
                      label="ER Floor — PUT ≥"
                      value={sim.erPut} min={0} max={1} step={0.01}
                      live={live.erPut} accentColor={accent}
                      onChange={v => updateSim(mode, 'erPut', v)}
                    />
                    <SimSlider
                      label="|Z| Ceiling ≤"
                      value={sim.zMax} min={0.25} max={5} step={0.05}
                      live={live.zMax} accentColor={accent}
                      onChange={v => updateSim(mode, 'zMax', v)}
                    />
                    <SimSlider
                      label="Exhaustion CALL ≤"
                      value={sim.exCall} min={0.5} max={1} step={0.01}
                      live={live.exCall} accentColor={accent}
                      onChange={v => updateSim(mode, 'exCall', v)}
                    />
                    <SimSlider
                      label="Exhaustion PUT ≥"
                      value={sim.exPut} min={0} max={0.5} step={0.01}
                      live={live.exPut} accentColor={accent}
                      onChange={v => updateSim(mode, 'exPut', v)}
                    />
                  </div>
                );
              })}
            </div>

            <p className="text-[10px] text-zinc-600">
              Gray tick on each slider marks the live value. Drag to explore — the table below and all gate counts update instantly. Use <em>Reset to live</em> to restore. Changes here do not affect system_settings.
            </p>
          </div>
        )}
      </section>

      {/* ── Filters ── */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 bg-zinc-900 border border-zinc-800 rounded-lg p-1">
          {(['ALL', 'SNIPER', 'BALANCED', 'AGGRESSIVE'] as Mode[]).map(m => (
            <FilterBtn key={m} value={m} active={modeFilter === m} onClick={setModeFilter}>
              {m === 'ALL' ? 'All Modes' : `${MODE_ICON[m]} ${m[0]+m.slice(1).toLowerCase()}`}
            </FilterBtn>
          ))}
        </div>
        <div className="flex gap-1 bg-zinc-900 border border-zinc-800 rounded-lg p-1">
          {(['ALL', 'LIVE', 'GHOST'] as ExecType[]).map(e => (
            <FilterBtn key={e} value={e} active={execFilter === e} onClick={setExecFilter}>
              {e === 'ALL' ? '📊 All' : e === 'LIVE' ? '💰 Live' : '👻 Ghost'}
            </FilterBtn>
          ))}
        </div>
        <div className="flex gap-1 bg-zinc-900 border border-zinc-800 rounded-lg p-1">
          {(['ALL', 'CALL', 'PUT'] as Direction[]).map(d => (
            <FilterBtn key={d} value={d} active={dirFilter === d} onClick={setDirFilter}>
              {d === 'ALL' ? 'Both' : d === 'CALL' ? '↑ CALL' : '↓ PUT'}
            </FilterBtn>
          ))}
        </div>
        <div className="flex gap-1 bg-zinc-900 border border-zinc-800 rounded-lg p-1">
          {(['ALL', 'PASS', 'FAIL'] as const).map(g => (
            <FilterBtn key={g} value={g} active={gateFilter === g} onClick={setGateFilter}>
              {g === 'ALL' ? 'All Gates' : g === 'PASS' ? '✓ All Pass' : '✗ Any Fail'}
            </FilterBtn>
          ))}
        </div>
        <input
          type="text"
          placeholder="Search symbol…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="text-xs bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-1.5 text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-violet-500 w-36"
        />
        <span className="text-xs text-zinc-600 ml-auto">
          {simActive && <span className="text-violet-400 font-semibold mr-1">🧪 sim</span>}
          {filtered.length} signals
        </span>
      </div>

      {/* ── Signal Table ── */}
      {displayed.length === 0 ? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-8 text-center text-sm text-zinc-500">
          No signals match the current filters.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/80">
                <th className="text-left px-3 py-2.5 text-zinc-400 font-semibold">Time</th>
                <th className="text-left px-3 py-2.5 text-zinc-400 font-semibold">Symbol</th>
                <th className="text-left px-3 py-2.5 text-zinc-400 font-semibold">Mode</th>
                <th className="text-left px-3 py-2.5 text-zinc-400 font-semibold">Result</th>
                <th className="text-center px-3 py-2.5 text-zinc-400 font-semibold">ER Gate</th>
                <th className="text-center px-3 py-2.5 text-zinc-400 font-semibold">Z Gate</th>
                <th className="text-center px-3 py-2.5 text-zinc-400 font-semibold">Exh. Gate</th>
                <th className="text-right px-3 py-2.5 text-zinc-400 font-semibold">Noise</th>
                <th className="text-right px-3 py-2.5 text-zinc-400 font-semibold">Accel</th>
                <th className="text-center px-3 py-2.5 text-zinc-400 font-semibold">Gates</th>
              </tr>
            </thead>
            <tbody>
              {displayed.map(row => {
                const allPass = row.erPass && row.zPass && row.exPass;
                return (
                  <tr key={row.id} className={`border-b border-zinc-800/60 hover:bg-zinc-800/20 transition-colors ${!allPass ? 'bg-rose-950/10' : ''}`}>

                    <td className="px-3 py-2 text-zinc-500 font-mono whitespace-nowrap">
                      {new Date(row.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      <div className="text-[9px] text-zinc-700">
                        {new Date(row.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
                      </div>
                    </td>

                    <td className="px-3 py-2">
                      <div className="font-medium text-white">{getSymbolDisplayName(row.symbol)}</div>
                      <div className={`text-[10px] font-bold ${row.direction === 'CALL' ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {row.direction === 'CALL' ? '↑ CALL' : '↓ PUT'}
                      </div>
                    </td>

                    <td className="px-3 py-2">
                      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-bold ${MODE_COLOR[row.effectiveMode]}`}>
                        {MODE_ICON[row.effectiveMode]} {row.effectiveMode[0]+row.effectiveMode.slice(1).toLowerCase()}
                      </span>
                      <div className="text-[9px] text-zinc-600 mt-0.5">{row.executionType}</div>
                    </td>

                    <td className="px-3 py-2">
                      <span className={`font-bold text-xs ${row.status === 'WIN' ? 'text-emerald-400' : row.status === 'LOSS' ? 'text-rose-400' : 'text-zinc-500'}`}>
                        {row.status === 'WIN' ? '✓ WIN' : row.status === 'LOSS' ? '✗ LOSS' : '⏳ PEND'}
                      </span>
                    </td>

                    <td className="px-3 py-2">
                      <GateBadge pass={row.erPass} value={row.er} threshold={row.erThresh} label="ER" />
                    </td>

                    <td className="px-3 py-2">
                      <GateBadge pass={row.zPass} value={row.z} threshold={row.zThresh} label="|Z|" inverted />
                    </td>

                    <td className="px-3 py-2">
                      <GateBadge
                        pass={row.exPass}
                        value={row.noise}
                        threshold={row.exThresh}
                        label="Exh."
                        inverted={row.direction === 'CALL'}
                      />
                    </td>

                    <td className="px-3 py-2 text-right font-mono text-zinc-300">
                      {row.noise.toFixed(3)}
                    </td>

                    <td className="px-3 py-2 text-right font-mono text-zinc-300">
                      {row.accel.toFixed(3)}
                    </td>

                    <td className="px-3 py-2 text-center">
                      <div className="flex gap-0.5 justify-center">
                        <span className={`w-2 h-2 rounded-full ${row.erPass ? 'bg-emerald-500' : 'bg-rose-500'}`} title="ER gate" />
                        <span className={`w-2 h-2 rounded-full ${row.zPass ? 'bg-emerald-500' : 'bg-rose-500'}`} title="Z gate" />
                        <span className={`w-2 h-2 rounded-full ${row.exPass ? 'bg-emerald-500' : 'bg-rose-500'}`} title="Exhaustion gate" />
                      </div>
                    </td>

                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {filtered.length > limit && (
        <div className="text-center">
          <button
            onClick={() => setLimit(l => l + 100)}
            className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-300 transition-colors"
          >
            Load 100 more ({filtered.length - limit} remaining)
          </button>
        </div>
      )}

      <p className="text-[10px] text-zinc-700 text-center pb-4">
        {simActive
          ? '🧪 Simulator active — gate pass/fail and counts reflect simulated thresholds. Use Reset to live to restore.'
          : 'Showing only resolved (non-pending) trades. Gate pass/fail reflects current live thresholds from system_settings.'}
      </p>
    </div>
  );
}
