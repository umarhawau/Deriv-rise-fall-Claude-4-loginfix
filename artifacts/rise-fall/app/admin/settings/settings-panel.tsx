'use client';

import { useEffect, useState, useCallback } from 'react';
import { AdminNav } from '../admin-nav';

interface Settings {
  noiseMin?: string | number;
  globalDebounceSeconds: number;
  sniperCallErMin: string | number;
  sniperPutErMin: string | number;
  balancedCallErMin: string | number;
  balancedPutErMin: string | number;
  aggressiveCallErMin: string | number;
  aggressivePutErMin: string | number;
  sniperZMax: string | number;
  balancedZMax: string | number;
  aggressiveZMax: string | number;
  autoErTrending: number;
  autoErRanging: number;
  sniperExhaustionCall: number;
  sniperExhaustionPut: number;
  balancedExhaustionCall: number;
  balancedExhaustionPut: number;
  aggressiveExhaustionCall: number;
  aggressiveExhaustionPut: number;
  sniperRequiredVotes: number;
  balancedRequiredVotes: number;
  aggressiveRequiredVotes: number;
  // Confidence / Stake-Sizing Engine
  confidenceErFloor: number;
  confidenceErCeiling: number;
  confidenceZExtreme: number;
  // Duration Sizer — Sniper Strike
  sniperStrikeErFloor: number;
  sniperStrikeErCeiling: number;
  sniperStrikeAccelMin: number;
  sniperStrikeMaxTicks: number;
  // Duration Sizer — Momentum Ride
  momentumRideErFloor: number;
  momentumRideErMedium: number;
  momentumRideErLow: number;
  // Analytics
  expiryMinSample: number;
}

const DEFAULTS: Settings = {
  globalDebounceSeconds: 15,
  sniperCallErMin: '0.00',
  sniperPutErMin: '0.60',
  balancedCallErMin: '0.10',
  balancedPutErMin: '0.40',
  aggressiveCallErMin: '0.20',
  aggressivePutErMin: '0.30',
  sniperZMax: '1.5',
  balancedZMax: '2.0',
  aggressiveZMax: '2.5',
  autoErTrending: 0.65,
  autoErRanging: 0.45,
  sniperExhaustionCall: 0.75,
  sniperExhaustionPut: 0.25,
  balancedExhaustionCall: 0.80,
  balancedExhaustionPut: 0.20,
  aggressiveExhaustionCall: 0.90,
  aggressiveExhaustionPut: 0.10,
  sniperRequiredVotes: 3,
  balancedRequiredVotes: 3,
  aggressiveRequiredVotes: 2,
  confidenceErFloor: 0.40,
  confidenceErCeiling: 0.80,
  confidenceZExtreme: 2.50,
  sniperStrikeErFloor: 0.70,
  sniperStrikeErCeiling: 1.00,
  sniperStrikeAccelMin: 1.50,
  sniperStrikeMaxTicks: 10,
  momentumRideErFloor: 0.50,
  momentumRideErMedium: 0.65,
  momentumRideErLow: 0.55,
  expiryMinSample: 30,
};

function p(v: string | number | undefined, fallback = 0) {
  if (v === undefined) return fallback;
  return typeof v === 'number' ? v : parseFloat(v);
}

function settingsEqual(a: Settings, b: Settings) {
  const keys = Object.keys(DEFAULTS) as (keyof Settings)[];
  return keys.every(k => {
    if (k === 'globalDebounceSeconds' || k === 'sniperRequiredVotes' || k === 'balancedRequiredVotes' || k === 'aggressiveRequiredVotes' || k === 'sniperStrikeMaxTicks' || k === 'expiryMinSample') return a[k] === b[k];
    return p(a[k] as string | number) === p(b[k] as string | number);
  });
}

type Mode = 'SNIPER' | 'BALANCED' | 'AGGRESSIVE';
const MODES: Mode[] = ['SNIPER', 'BALANCED', 'AGGRESSIVE'];

const MODE_META: Record<Mode, { label: string; icon: string; color: string; border: string; bg: string }> = {
  SNIPER:     { label: 'Sniper',     icon: '🎯', color: 'text-violet-600 dark:text-violet-400', border: 'border-violet-500/30', bg: 'bg-violet-500/5' },
  BALANCED:   { label: 'Balanced',   icon: '⚖️', color: 'text-blue-600 dark:text-blue-400',    border: 'border-blue-500/30',   bg: 'bg-blue-500/5'   },
  AGGRESSIVE: { label: 'Aggressive', icon: '⚡', color: 'text-amber-600 dark:text-amber-400',  border: 'border-amber-500/30', bg: 'bg-amber-500/5'  },
};

const ER_KEY: Record<Mode, { call: keyof Settings; put: keyof Settings }> = {
  SNIPER:     { call: 'sniperCallErMin',     put: 'sniperPutErMin'     },
  BALANCED:   { call: 'balancedCallErMin',   put: 'balancedPutErMin'   },
  AGGRESSIVE: { call: 'aggressiveCallErMin', put: 'aggressivePutErMin' },
};
const Z_KEY: Record<Mode, keyof Settings> = {
  SNIPER: 'sniperZMax', BALANCED: 'balancedZMax', AGGRESSIVE: 'aggressiveZMax',
};
const EX_CALL_KEY: Record<Mode, keyof Settings> = {
  SNIPER: 'sniperExhaustionCall', BALANCED: 'balancedExhaustionCall', AGGRESSIVE: 'aggressiveExhaustionCall',
};
const EX_PUT_KEY: Record<Mode, keyof Settings> = {
  SNIPER: 'sniperExhaustionPut', BALANCED: 'balancedExhaustionPut', AGGRESSIVE: 'aggressiveExhaustionPut',
};
const VOTES_KEY: Record<Mode, keyof Settings> = {
  SNIPER: 'sniperRequiredVotes', BALANCED: 'balancedRequiredVotes', AGGRESSIVE: 'aggressiveRequiredVotes',
};

function MatrixSlider({ value, min, max, step, color, onChange }: {
  value: number; min: number; max: number; step: number; color: string; onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <span className={`block text-xl font-bold font-mono tabular-nums ${color}`}>
        {value.toFixed(step < 0.1 ? 2 : 1)}
      </span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-violet-500 bg-gray-200 dark:bg-zinc-700"
      />
      <div className="flex justify-between text-[9px] text-gray-400 dark:text-zinc-600">
        <span>{min.toFixed(step < 0.1 ? 2 : 1)}</span>
        <span>{max.toFixed(step < 0.1 ? 2 : 1)}</span>
      </div>
    </div>
  );
}

function SimpleSlider({ label, hint, value, min, max, step, unit, color, onChange }: {
  label: string; hint?: string; value: number; min: number; max: number; step: number;
  unit?: string; color?: string; onChange: (v: number) => void;
}) {
  const decimals = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-gray-700 dark:text-zinc-300">{label}</p>
        <span className={`text-lg font-bold font-mono tabular-nums ${color ?? 'text-violet-600 dark:text-violet-400'}`}>
          {value.toFixed(decimals)}{unit}
        </span>
      </div>
      {hint && <p className="text-[10px] text-gray-400 dark:text-zinc-500">{hint}</p>}
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-violet-500 bg-gray-200 dark:bg-zinc-700" />
      <div className="flex justify-between text-[9px] text-gray-400 dark:text-zinc-600">
        <span>{min.toFixed(decimals)}{unit}</span><span>{max.toFixed(decimals)}{unit}</span>
      </div>
    </div>
  );
}

function validationWarning(draft: Settings): string | null {
  if (draft.autoErRanging >= draft.autoErTrending) {
    return `AUTO tier conflict: Ranging (${draft.autoErRanging.toFixed(2)}) must be < Trending (${draft.autoErTrending.toFixed(2)})`;
  }
  const sp = p(draft.sniperPutErMin);
  const bp = p(draft.balancedPutErMin);
  const ap = p(draft.aggressivePutErMin);
  if (!(ap <= bp && bp <= sp)) {
    return `PUT column: Aggressive (${ap.toFixed(2)}) should be ≤ Balanced (${bp.toFixed(2)}) ≤ Sniper (${sp.toFixed(2)})`;
  }
  if (draft.confidenceErFloor >= draft.confidenceErCeiling) {
    return `Confidence engine: ER Floor (${draft.confidenceErFloor.toFixed(2)}) must be < ER Ceiling (${draft.confidenceErCeiling.toFixed(2)})`;
  }
  if (draft.sniperStrikeErFloor >= draft.sniperStrikeErCeiling) {
    return `Sniper Strike: ER Floor (${draft.sniperStrikeErFloor.toFixed(2)}) must be < ER Ceiling (${draft.sniperStrikeErCeiling.toFixed(2)})`;
  }
  if (draft.momentumRideErLow >= draft.momentumRideErMedium) {
    return `Momentum Ride: ER Low (${draft.momentumRideErLow.toFixed(2)}) must be < ER Medium (${draft.momentumRideErMedium.toFixed(2)})`;
  }
  return null;
}

function parseSettings(raw: Record<string, unknown>): Settings {
  const n = (v: unknown, fb: number) => {
    if (v === undefined || v === null) return fb;
    const parsed = typeof v === 'number' ? v : parseFloat(String(v));
    return isNaN(parsed) ? fb : parsed;
  };
  const ni = (v: unknown, fb: number) => Math.round(n(v, fb));
  return {
    globalDebounceSeconds:    ni(raw.globalDebounceSeconds,    DEFAULTS.globalDebounceSeconds),
    sniperCallErMin:          n(raw.sniperCallErMin,           p(DEFAULTS.sniperCallErMin)),
    sniperPutErMin:           n(raw.sniperPutErMin,            p(DEFAULTS.sniperPutErMin)),
    balancedCallErMin:        n(raw.balancedCallErMin,         p(DEFAULTS.balancedCallErMin)),
    balancedPutErMin:         n(raw.balancedPutErMin,          p(DEFAULTS.balancedPutErMin)),
    aggressiveCallErMin:      n(raw.aggressiveCallErMin,       p(DEFAULTS.aggressiveCallErMin)),
    aggressivePutErMin:       n(raw.aggressivePutErMin,        p(DEFAULTS.aggressivePutErMin)),
    sniperZMax:               n(raw.sniperZMax,                p(DEFAULTS.sniperZMax)),
    balancedZMax:             n(raw.balancedZMax,              p(DEFAULTS.balancedZMax)),
    aggressiveZMax:           n(raw.aggressiveZMax,            p(DEFAULTS.aggressiveZMax)),
    autoErTrending:           n(raw.autoErTrending,            DEFAULTS.autoErTrending),
    autoErRanging:            n(raw.autoErRanging,             DEFAULTS.autoErRanging),
    sniperExhaustionCall:     n(raw.sniperExhaustionCall,      DEFAULTS.sniperExhaustionCall),
    sniperExhaustionPut:      n(raw.sniperExhaustionPut,       DEFAULTS.sniperExhaustionPut),
    balancedExhaustionCall:   n(raw.balancedExhaustionCall,    DEFAULTS.balancedExhaustionCall),
    balancedExhaustionPut:    n(raw.balancedExhaustionPut,     DEFAULTS.balancedExhaustionPut),
    aggressiveExhaustionCall: n(raw.aggressiveExhaustionCall,  DEFAULTS.aggressiveExhaustionCall),
    aggressiveExhaustionPut:  n(raw.aggressiveExhaustionPut,   DEFAULTS.aggressiveExhaustionPut),
    sniperRequiredVotes:      ni(raw.sniperRequiredVotes,      DEFAULTS.sniperRequiredVotes),
    balancedRequiredVotes:    ni(raw.balancedRequiredVotes,    DEFAULTS.balancedRequiredVotes),
    aggressiveRequiredVotes:  ni(raw.aggressiveRequiredVotes,  DEFAULTS.aggressiveRequiredVotes),
    confidenceErFloor:        n(raw.confidenceErFloor,         DEFAULTS.confidenceErFloor),
    confidenceErCeiling:      n(raw.confidenceErCeiling,       DEFAULTS.confidenceErCeiling),
    confidenceZExtreme:       n(raw.confidenceZExtreme,        DEFAULTS.confidenceZExtreme),
    sniperStrikeErFloor:      n(raw.sniperStrikeErFloor,       DEFAULTS.sniperStrikeErFloor),
    sniperStrikeErCeiling:    n(raw.sniperStrikeErCeiling,     DEFAULTS.sniperStrikeErCeiling),
    sniperStrikeAccelMin:     n(raw.sniperStrikeAccelMin,      DEFAULTS.sniperStrikeAccelMin),
    sniperStrikeMaxTicks:     ni(raw.sniperStrikeMaxTicks,     DEFAULTS.sniperStrikeMaxTicks),
    momentumRideErFloor:      n(raw.momentumRideErFloor,       DEFAULTS.momentumRideErFloor),
    momentumRideErMedium:     n(raw.momentumRideErMedium,      DEFAULTS.momentumRideErMedium),
    momentumRideErLow:        n(raw.momentumRideErLow,         DEFAULTS.momentumRideErLow),
    expiryMinSample:          ni(raw.expiryMinSample,          DEFAULTS.expiryMinSample),
  };
}

export function SettingsPanel() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/settings');
      const raw = await res.json() as Record<string, unknown>;
      const merged = parseSettings(raw);
      setSettings(merged);
      setDraft(merged);
    } catch {
      setError('Failed to load settings');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const set = useCallback((key: keyof Settings, val: number) => {
    setDraft(d => d ? { ...d, [key]: val } : d);
  }, []);

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true); setError(null); setSaved(false);
    try {
      const body = {
        globalDebounceSeconds:    draft.globalDebounceSeconds,
        sniperCallErMin:          p(draft.sniperCallErMin),
        sniperPutErMin:           p(draft.sniperPutErMin),
        balancedCallErMin:        p(draft.balancedCallErMin),
        balancedPutErMin:         p(draft.balancedPutErMin),
        aggressiveCallErMin:      p(draft.aggressiveCallErMin),
        aggressivePutErMin:       p(draft.aggressivePutErMin),
        sniperZMax:               p(draft.sniperZMax),
        balancedZMax:             p(draft.balancedZMax),
        aggressiveZMax:           p(draft.aggressiveZMax),
        autoErTrending:           draft.autoErTrending,
        autoErRanging:            draft.autoErRanging,
        sniperExhaustionCall:     draft.sniperExhaustionCall,
        sniperExhaustionPut:      draft.sniperExhaustionPut,
        balancedExhaustionCall:   draft.balancedExhaustionCall,
        balancedExhaustionPut:    draft.balancedExhaustionPut,
        aggressiveExhaustionCall: draft.aggressiveExhaustionCall,
        aggressiveExhaustionPut:  draft.aggressiveExhaustionPut,
        sniperRequiredVotes:      draft.sniperRequiredVotes,
        balancedRequiredVotes:    draft.balancedRequiredVotes,
        aggressiveRequiredVotes:  draft.aggressiveRequiredVotes,
        confidenceErFloor:        draft.confidenceErFloor,
        confidenceErCeiling:      draft.confidenceErCeiling,
        confidenceZExtreme:       draft.confidenceZExtreme,
        sniperStrikeErFloor:      draft.sniperStrikeErFloor,
        sniperStrikeErCeiling:    draft.sniperStrikeErCeiling,
        sniperStrikeAccelMin:     draft.sniperStrikeAccelMin,
        sniperStrikeMaxTicks:     draft.sniperStrikeMaxTicks,
        momentumRideErFloor:      draft.momentumRideErFloor,
        momentumRideErMedium:     draft.momentumRideErMedium,
        momentumRideErLow:        draft.momentumRideErLow,
        expiryMinSample:          draft.expiryMinSample,
      };
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const bd = await res.json() as { error?: string };
        throw new Error(bd.error ?? 'Save failed');
      }
      const rawUpdated = await res.json() as Record<string, unknown>;
      const merged = parseSettings(rawUpdated);
      setSettings(merged); setDraft(merged);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const warn = draft ? validationWarning(draft) : null;
  const isDirty = draft && settings && !settingsEqual(draft, settings);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-[#0a0a0f] text-gray-900 dark:text-zinc-100 p-4 sm:p-6 space-y-6">

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-lg sm:text-xl font-bold tracking-tight text-gray-900 dark:text-white">⚙️ Global Parameters</h1>
          <p className="text-xs text-gray-500 dark:text-zinc-500 mt-0.5">Live threshold control — changes apply immediately to the trading engine</p>
        </div>
        <span className="text-[10px] bg-rose-500/20 text-rose-500 dark:text-rose-400 border border-rose-500/30 px-2.5 py-1 rounded-full font-mono uppercase tracking-wider self-start sm:self-auto">
          ADMIN ONLY
        </span>
      </div>

      <AdminNav />

      {error && !draft && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-500 font-semibold">
          {error}
          <button onClick={() => { setError(null); void load(); }} className="ml-3 underline text-xs">Retry</button>
        </div>
      )}

      {!draft && !error ? (
        <div className="flex items-center justify-center py-16">
          <div className="text-sm text-gray-400 dark:text-zinc-500 animate-pulse">Loading settings…</div>
        </div>
      ) : draft ? (
        <>
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 flex items-start gap-3">
            <span className="text-base mt-0.5">⚡</span>
            <div>
              <p className="text-xs font-semibold text-amber-600 dark:text-amber-300">Real-Time Tuning — No Redeploy Required</p>
              <p className="text-[11px] text-amber-700/80 dark:text-amber-400/70 mt-0.5">
                All thresholds are fetched live every 60 s. Changes take effect on the next refresh cycle — no redeploy needed.
              </p>
            </div>
          </div>

          {/* ── Consensus Engine Calibration ── */}
          <div className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-200 dark:border-zinc-800">
              <h2 className="text-sm font-bold text-gray-900 dark:text-white">Consensus Engine Calibration</h2>
              <p className="text-[11px] text-gray-500 dark:text-zinc-500 mt-0.5">Direction-aware ER gates per mode. CALL and PUT are tuned independently.</p>
            </div>
            <div className="grid grid-cols-4 gap-0 border-b border-gray-100 dark:border-zinc-800 px-5 py-2.5">
              <div />
              <div className="text-center"><span className="inline-flex items-center gap-1.5 text-[10px] font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-widest"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />CALL ↑ ER Min</span></div>
              <div className="text-center"><span className="inline-flex items-center gap-1.5 text-[10px] font-bold text-rose-600 dark:text-rose-400 uppercase tracking-widest"><span className="w-1.5 h-1.5 rounded-full bg-rose-500 inline-block" />PUT ↓ ER Min</span></div>
              <div className="text-center"><span className="text-[10px] font-bold text-gray-500 dark:text-zinc-400 uppercase tracking-widest">Z-Score Max</span></div>
            </div>
            {MODES.map(mode => {
              const meta = MODE_META[mode];
              return (
                <div key={mode} className={`grid grid-cols-4 gap-0 px-5 py-4 border-b border-gray-50 dark:border-zinc-800/50 ${meta.bg}`}>
                  <div className="flex flex-col justify-center gap-0.5 pr-3">
                    <div className="flex items-center gap-1.5"><span>{meta.icon}</span><span className={`text-xs font-bold ${meta.color}`}>{meta.label}</span></div>
                    <span className={`text-[9px] uppercase tracking-widest font-mono border rounded-full px-1.5 py-0.5 self-start ${meta.border} ${meta.color} opacity-70`}>{mode}</span>
                  </div>
                  <div className="px-3 border-l border-gray-100 dark:border-zinc-800">
                    <MatrixSlider value={p(draft[ER_KEY[mode].call])} min={0} max={1} step={0.01} color="text-emerald-600 dark:text-emerald-400" onChange={v => set(ER_KEY[mode].call, v)} />
                  </div>
                  <div className="px-3 border-l border-gray-100 dark:border-zinc-800">
                    <MatrixSlider value={p(draft[ER_KEY[mode].put])} min={0} max={1} step={0.01} color="text-rose-600 dark:text-rose-400" onChange={v => set(ER_KEY[mode].put, v)} />
                  </div>
                  <div className="px-3 border-l border-gray-100 dark:border-zinc-800">
                    <MatrixSlider value={p(draft[Z_KEY[mode]])} min={0.5} max={5} step={0.1} color="text-gray-700 dark:text-zinc-300" onChange={v => set(Z_KEY[mode], v)} />
                  </div>
                </div>
              );
            })}
            <div className="px-5 py-3">
              {warn ? (
                <div className="flex items-start gap-2 text-[11px] text-amber-600 dark:text-amber-400"><span className="mt-0.5">⚠</span><span>Structural check: {warn}</span></div>
              ) : (
                <div className="flex items-center gap-2 text-[11px] text-emerald-600 dark:text-emerald-400"><span>✓</span><span>Matrix is structurally valid.</span></div>
              )}
            </div>
          </div>

          {/* ── Signal Debounce ── */}
          <div className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 p-5 sm:p-6 space-y-4">
            <div>
              <h2 className="text-sm font-bold text-gray-900 dark:text-white">Signal Debounce Lock</h2>
              <p className="text-[11px] text-gray-500 dark:text-zinc-500 mt-0.5">Minimum seconds between ghost/live trade entries for the same symbol. Prevents duplicate rows from tick-bloat.</p>
            </div>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-gray-900 dark:text-white">Debounce Window</p>
                <span className="text-2xl font-bold font-mono tabular-nums text-violet-500 dark:text-violet-400">{draft.globalDebounceSeconds}s</span>
              </div>
              <input type="range" min={1} max={120} step={1} value={draft.globalDebounceSeconds}
                onChange={e => set('globalDebounceSeconds', parseInt(e.target.value))}
                className="w-full h-2 rounded-full appearance-none cursor-pointer accent-violet-500 bg-gray-200 dark:bg-zinc-700" />
              <div className="flex justify-between text-[10px] text-gray-400 dark:text-zinc-600"><span>1s</span><span>120s</span></div>
              <p className="text-[10px] text-gray-500 dark:text-zinc-500">
                {draft.globalDebounceSeconds < 5 && '⚠ Very short — risk of duplicate ghost rows'}
                {draft.globalDebounceSeconds >= 5 && draft.globalDebounceSeconds < 20 && '✓ Standard window — good data quality'}
                {draft.globalDebounceSeconds >= 20 && draft.globalDebounceSeconds < 60 && '✓ Conservative — very clean dataset'}
                {draft.globalDebounceSeconds >= 60 && '🔒 Long lock — may miss rapid signal changes'}
              </p>
            </div>
          </div>

          {/* ── AUTO Mode Tier Thresholds ── */}
          <div className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-200 dark:border-zinc-800">
              <h2 className="text-sm font-bold text-gray-900 dark:text-white">AUTO Mode Tier Thresholds</h2>
              <p className="text-[11px] text-gray-500 dark:text-zinc-500 mt-0.5">
                When AUTO is selected, the live ER determines which mode activates. Set the ER boundaries here.
              </p>
            </div>
            <div className="px-5 py-4 grid grid-cols-1 sm:grid-cols-2 gap-6">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-gray-700 dark:text-zinc-300">Trending Threshold</p>
                  <span className="text-lg font-bold font-mono text-amber-600 dark:text-amber-400">{draft.autoErTrending.toFixed(2)}</span>
                </div>
                <p className="text-[10px] text-gray-400 dark:text-zinc-500">ER ≥ this → <span className="text-amber-500 font-semibold">AGGRESSIVE</span></p>
                <input type="range" min={0.45} max={0.95} step={0.01} value={draft.autoErTrending}
                  onChange={e => set('autoErTrending', parseFloat(e.target.value))}
                  className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-amber-500 bg-gray-200 dark:bg-zinc-700" />
                <div className="flex justify-between text-[9px] text-gray-400 dark:text-zinc-600"><span>0.45</span><span>0.95</span></div>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-gray-700 dark:text-zinc-300">Ranging Threshold</p>
                  <span className="text-lg font-bold font-mono text-violet-600 dark:text-violet-400">{draft.autoErRanging.toFixed(2)}</span>
                </div>
                <p className="text-[10px] text-gray-400 dark:text-zinc-500">ER &lt; this → <span className="text-violet-500 font-semibold">SNIPER</span></p>
                <input type="range" min={0.10} max={0.65} step={0.01} value={draft.autoErRanging}
                  onChange={e => set('autoErRanging', parseFloat(e.target.value))}
                  className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-violet-500 bg-gray-200 dark:bg-zinc-700" />
                <div className="flex justify-between text-[9px] text-gray-400 dark:text-zinc-600"><span>0.10</span><span>0.65</span></div>
              </div>
            </div>
            <div className="px-5 pb-4">
              <div className="relative h-8 rounded-lg overflow-hidden flex text-[10px] font-bold">
                <div className="flex items-center justify-center text-violet-600 dark:text-violet-400 bg-violet-500/10" style={{ width: `${draft.autoErRanging * 100}%` }}>🎯 SNIPER</div>
                <div className="flex-1 flex items-center justify-center text-blue-600 dark:text-blue-400 bg-blue-500/10 border-x border-blue-500/20">⚖️ BALANCED</div>
                <div className="flex items-center justify-center text-amber-600 dark:text-amber-400 bg-amber-500/10" style={{ width: `${(1 - draft.autoErTrending) * 100}%` }}>⚡ AGGR</div>
              </div>
              <div className="flex justify-between text-[9px] text-gray-400 dark:text-zinc-600 mt-1"><span>ER 0.00</span><span>ER 1.00</span></div>
            </div>
          </div>

          {/* ── Exhaustion Gate Calibration ── */}
          <div className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-200 dark:border-zinc-800">
              <h2 className="text-sm font-bold text-gray-900 dark:text-white">Exhaustion Gate Calibration</h2>
              <p className="text-[11px] text-gray-500 dark:text-zinc-500 mt-0.5">
                Directional ratio limits. CALL Limit: if the tick ratio &gt; limit, the market is exhausted upward (VETO). PUT Limit: if ratio &lt; limit, exhausted downward (VETO).
              </p>
            </div>
            <div className="grid grid-cols-3 gap-0 border-b border-gray-100 dark:border-zinc-800 px-5 py-2.5">
              <div />
              <div className="text-center"><span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-widest">CALL Limit ↑</span></div>
              <div className="text-center"><span className="text-[10px] font-bold text-rose-600 dark:text-rose-400 uppercase tracking-widest">PUT Limit ↓</span></div>
            </div>
            {MODES.map(mode => {
              const meta = MODE_META[mode];
              return (
                <div key={mode} className={`grid grid-cols-3 gap-0 px-5 py-4 border-b border-gray-50 dark:border-zinc-800/50 ${meta.bg}`}>
                  <div className="flex items-center gap-1.5 pr-3"><span>{meta.icon}</span><span className={`text-xs font-bold ${meta.color}`}>{meta.label}</span></div>
                  <div className="px-3 border-l border-gray-100 dark:border-zinc-800">
                    <MatrixSlider value={draft[EX_CALL_KEY[mode]] as number} min={0.5} max={1} step={0.01} color="text-emerald-600 dark:text-emerald-400" onChange={v => set(EX_CALL_KEY[mode], v)} />
                  </div>
                  <div className="px-3 border-l border-gray-100 dark:border-zinc-800">
                    <MatrixSlider value={draft[EX_PUT_KEY[mode]] as number} min={0} max={0.5} step={0.01} color="text-rose-600 dark:text-rose-400" onChange={v => set(EX_PUT_KEY[mode], v)} />
                  </div>
                </div>
              );
            })}
          </div>

          {/* ── Signal Consensus Votes ── */}
          <div className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-200 dark:border-zinc-800">
              <h2 className="text-sm font-bold text-gray-900 dark:text-white">Signal Consensus Votes</h2>
              <p className="text-[11px] text-gray-500 dark:text-zinc-500 mt-0.5">Minimum indicator agreement before a trade fires. Higher = fewer but higher-quality signals.</p>
            </div>
            <div className="px-5 py-4 space-y-4">
              {MODES.map(mode => {
                const meta = MODE_META[mode];
                const current = draft[VOTES_KEY[mode]] as number;
                return (
                  <div key={mode} className="flex items-center gap-4 flex-wrap">
                    <div className="flex items-center gap-2 w-32">
                      <span>{meta.icon}</span>
                      <span className={`text-xs font-semibold ${meta.color}`}>{meta.label}</span>
                    </div>
                    <div className="flex gap-1.5">
                      {[1, 2, 3].map(v => (
                        <button key={v} onClick={() => set(VOTES_KEY[mode], v)}
                          className={`w-9 h-9 rounded-lg text-sm font-bold transition-all ${current === v ? 'bg-violet-600 text-white shadow-sm shadow-violet-500/30' : 'bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-zinc-400 hover:bg-gray-200 dark:hover:bg-zinc-700'}`}>
                          {v}
                        </button>
                      ))}
                    </div>
                    <p className="text-[10px] text-gray-400 dark:text-zinc-500">
                      {current === 1 && 'Widest — any single indicator fires'}
                      {current === 2 && 'Balanced — 2 of 3 must agree'}
                      {current === 3 && 'Strictest — unanimous agreement'}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── Confidence / Stake-Sizing Engine ── */}
          <div className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-200 dark:border-zinc-800">
              <h2 className="text-sm font-bold text-gray-900 dark:text-white">💰 Confidence Stake-Sizing Engine</h2>
              <p className="text-[11px] text-gray-500 dark:text-zinc-500 mt-0.5">
                Controls how the CONFIDENCE risk engine scales stake between base and max-cap. Higher ER/lower Z = larger stake.
              </p>
            </div>
            <div className="px-5 py-5 grid grid-cols-1 sm:grid-cols-3 gap-6">
              <SimpleSlider
                label="ER Floor"
                hint="ER below this → zero ER confidence, stake = base only"
                value={draft.confidenceErFloor} min={0.10} max={0.80} step={0.01}
                color="text-violet-600 dark:text-violet-400"
                onChange={v => set('confidenceErFloor', v)}
              />
              <SimpleSlider
                label="ER Ceiling"
                hint="ER at or above this → full ER confidence, max stake reachable"
                value={draft.confidenceErCeiling} min={0.50} max={1.00} step={0.01}
                color="text-emerald-600 dark:text-emerald-400"
                onChange={v => set('confidenceErCeiling', v)}
              />
              <SimpleSlider
                label="|Z| Extreme"
                hint="|Z-score| ≥ this → zero Z confidence (punishes overextended entries)"
                value={draft.confidenceZExtreme} min={0.50} max={10.00} step={0.10}
                color="text-amber-600 dark:text-amber-400"
                onChange={v => set('confidenceZExtreme', v)}
              />
            </div>
            <div className="px-5 pb-4">
              <div className="bg-violet-500/5 border border-violet-500/20 rounded-lg px-4 py-3 text-[11px] text-violet-700 dark:text-violet-300 font-mono space-y-1">
                <p className="font-bold text-violet-600 dark:text-violet-400 mb-1">Formula preview</p>
                <p>ER confidence = (ER − {draft.confidenceErFloor.toFixed(2)}) / ({draft.confidenceErCeiling.toFixed(2)} − {draft.confidenceErFloor.toFixed(2)}) → 0–1</p>
                <p>Z  confidence = 1 − |Z| / {draft.confidenceZExtreme.toFixed(2)}   (0 when |Z| ≥ {draft.confidenceZExtreme.toFixed(2)})</p>
                <p>Stake = base + (maxCap − base) × avg(ER conf, Z conf)</p>
              </div>
            </div>
          </div>

          {/* ── Duration Sizer — Sniper Strike ── */}
          <div className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-200 dark:border-zinc-800">
              <h2 className="text-sm font-bold text-gray-900 dark:text-white">⏱ Duration Sizer — Sniper Strike</h2>
              <p className="text-[11px] text-gray-500 dark:text-zinc-500 mt-0.5">
                Activates when ER &gt; ER Floor AND |acceleration| &gt; Accel Min. Uses a parabolic formula to pick tick count — higher ER = fewer ticks (faster exit before snap-back).
              </p>
            </div>
            <div className="px-5 py-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
              <SimpleSlider
                label="ER Floor"
                hint="Minimum ER to enter Sniper Strike tier"
                value={draft.sniperStrikeErFloor} min={0.30} max={0.90} step={0.01}
                color="text-violet-600 dark:text-violet-400"
                onChange={v => set('sniperStrikeErFloor', v)}
              />
              <SimpleSlider
                label="ER Ceiling"
                hint="Theoretical max ER — maps to API minimum tick count"
                value={draft.sniperStrikeErCeiling} min={0.60} max={1.00} step={0.01}
                color="text-emerald-600 dark:text-emerald-400"
                onChange={v => set('sniperStrikeErCeiling', v)}
              />
              <SimpleSlider
                label="Accel Min"
                hint="Minimum |price acceleration| to qualify for Sniper tier"
                value={draft.sniperStrikeAccelMin} min={0.10} max={10.00} step={0.10}
                color="text-amber-600 dark:text-amber-400"
                onChange={v => set('sniperStrikeAccelMin', v)}
              />
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-gray-700 dark:text-zinc-300">Max Ticks</p>
                  <span className="text-lg font-bold font-mono text-rose-600 dark:text-rose-400">{draft.sniperStrikeMaxTicks}</span>
                </div>
                <p className="text-[10px] text-gray-400 dark:text-zinc-500">Upper tick ceiling (API limit respected)</p>
                <input type="range" min={1} max={50} step={1} value={draft.sniperStrikeMaxTicks}
                  onChange={e => set('sniperStrikeMaxTicks', parseInt(e.target.value))}
                  className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-rose-500 bg-gray-200 dark:bg-zinc-700" />
                <div className="flex justify-between text-[9px] text-gray-400 dark:text-zinc-600"><span>1</span><span>50</span></div>
              </div>
            </div>
          </div>

          {/* ── Duration Sizer — Momentum Ride ── */}
          <div className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-200 dark:border-zinc-800">
              <h2 className="text-sm font-bold text-gray-900 dark:text-white">🏄 Duration Sizer — Momentum Ride</h2>
              <p className="text-[11px] text-gray-500 dark:text-zinc-500 mt-0.5">
                Fallback when Sniper Strike does not activate. Uses ER to pick a seconds multiplier — noisier trend = more time to breathe.
              </p>
            </div>
            <div className="px-5 py-5 grid grid-cols-1 sm:grid-cols-3 gap-6">
              <SimpleSlider
                label="ER Floor"
                hint="ER below this → falls through to Macro Hold (minutes)"
                value={draft.momentumRideErFloor} min={0.10} max={0.70} step={0.01}
                color="text-violet-600 dark:text-violet-400"
                onChange={v => set('momentumRideErFloor', v)}
              />
              <SimpleSlider
                label="ER Medium"
                hint="ER below Medium but above Low → 2× base seconds"
                value={draft.momentumRideErMedium} min={0.30} max={0.90} step={0.01}
                color="text-blue-600 dark:text-blue-400"
                onChange={v => set('momentumRideErMedium', v)}
              />
              <SimpleSlider
                label="ER Low"
                hint="ER below Low → 3× base seconds (slowest momentum)"
                value={draft.momentumRideErLow} min={0.10} max={0.70} step={0.01}
                color="text-amber-600 dark:text-amber-400"
                onChange={v => set('momentumRideErLow', v)}
              />
            </div>
            <div className="px-5 pb-4">
              <div className="bg-blue-500/5 border border-blue-500/20 rounded-lg px-4 py-3 text-[11px] text-blue-700 dark:text-blue-300 font-mono space-y-0.5">
                <p className="font-bold text-blue-600 dark:text-blue-400 mb-1">Multiplier tiers (live)</p>
                <p>ER ≥ {draft.momentumRideErMedium.toFixed(2)} → 1× seconds (tight exit)</p>
                <p>ER ≥ {draft.momentumRideErLow.toFixed(2)} → 2× seconds (medium hold)</p>
                <p>ER ≥ {draft.momentumRideErFloor.toFixed(2)} → 3× seconds (wide hold)</p>
                <p>ER &lt; {draft.momentumRideErFloor.toFixed(2)} → Macro Hold (minutes)</p>
              </div>
            </div>
          </div>

          {/* ── Analytics Settings ── */}
          <div className="rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-200 dark:border-zinc-800">
              <h2 className="text-sm font-bold text-gray-900 dark:text-white">⏱️ Expiry Analytics Settings</h2>
              <p className="text-[11px] text-gray-500 dark:text-zinc-500 mt-0.5">
                Controls the Expiry Performance Analytics page at /admin/expiry.
              </p>
            </div>
            <div className="px-5 py-5 max-w-sm">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-gray-700 dark:text-zinc-300">Min Sample Size</p>
                  <span className="text-lg font-bold font-mono text-violet-600 dark:text-violet-400">{draft.expiryMinSample} trades</span>
                </div>
                <p className="text-[10px] text-gray-400 dark:text-zinc-500">
                  Minimum resolved trades required before an expiry is considered statistically qualified for recommendations.
                </p>
                <input
                  type="range" min={5} max={500} step={5} value={draft.expiryMinSample}
                  onChange={e => set('expiryMinSample', parseInt(e.target.value))}
                  className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-violet-500 bg-gray-200 dark:bg-zinc-700"
                />
                <div className="flex justify-between text-[9px] text-gray-400 dark:text-zinc-600"><span>5</span><span>500</span></div>
                <p className="text-[10px] text-gray-400 dark:text-zinc-500">
                  {draft.expiryMinSample < 15 && '⚠ Very low — noisy results, unreliable win rates'}
                  {draft.expiryMinSample >= 15 && draft.expiryMinSample < 30 && '⚡ Low — faster qualification but more variance'}
                  {draft.expiryMinSample >= 30 && draft.expiryMinSample < 100 && '✓ Standard — good balance of confidence and data coverage'}
                  {draft.expiryMinSample >= 100 && draft.expiryMinSample < 200 && '✓ Conservative — high confidence, fewer qualified combos'}
                  {draft.expiryMinSample >= 200 && '🔒 Strict — only the most traded combos qualify'}
                </p>
              </div>
            </div>
          </div>

          {/* ── Live Preview ── */}
          <div className="rounded-xl border border-violet-500/20 bg-violet-500/5 p-4 sm:p-5">
            <h3 className="text-xs font-bold text-violet-600 dark:text-violet-400 uppercase tracking-widest mb-3">Live Config Preview</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-8 gap-y-3 font-mono text-[11px] text-gray-700 dark:text-zinc-300 mb-4">
              {MODES.map(mode => {
                const meta = MODE_META[mode];
                const rows: { label: string; val: string; saved: string | null; color: string }[] = [
                  { label: 'CALL er_min', val: p(draft[ER_KEY[mode].call]).toFixed(4), saved: settings ? p(settings[ER_KEY[mode].call]).toFixed(4) : null, color: 'text-emerald-600 dark:text-emerald-400' },
                  { label: 'PUT er_min',  val: p(draft[ER_KEY[mode].put]).toFixed(4),  saved: settings ? p(settings[ER_KEY[mode].put]).toFixed(4) : null,  color: 'text-rose-600 dark:text-rose-400' },
                  { label: 'z_max',       val: p(draft[Z_KEY[mode]]).toFixed(2),        saved: settings ? p(settings[Z_KEY[mode]]).toFixed(2) : null,        color: 'text-gray-700 dark:text-zinc-300' },
                  { label: 'ex_call',     val: (draft[EX_CALL_KEY[mode]] as number).toFixed(2), saved: settings ? (settings[EX_CALL_KEY[mode]] as number).toFixed(2) : null, color: 'text-emerald-600/70 dark:text-emerald-400/70' },
                  { label: 'ex_put',      val: (draft[EX_PUT_KEY[mode]] as number).toFixed(2),  saved: settings ? (settings[EX_PUT_KEY[mode]] as number).toFixed(2) : null,  color: 'text-rose-600/70 dark:text-rose-400/70' },
                  { label: 'votes',       val: String(draft[VOTES_KEY[mode]]),           saved: settings ? String(settings[VOTES_KEY[mode]]) : null,          color: 'text-violet-600 dark:text-violet-400' },
                ];
                return (
                  <div key={mode} className="space-y-0.5">
                    <p className={`text-[10px] font-bold uppercase tracking-widest mb-1.5 ${meta.color}`}>{meta.icon} {meta.label}</p>
                    {rows.map(r => (
                      <div key={r.label} className="flex items-center gap-2">
                        <span className="text-gray-400 dark:text-zinc-500 w-20">{r.label}</span>
                        <span className={`font-bold ${r.color}`}>{r.val}</span>
                        {r.saved && r.saved !== r.val && <span className="text-[10px] text-amber-500">(was {r.saved})</span>}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
            <div className="border-t border-violet-500/20 pt-3 space-y-1 font-mono text-[11px]">
              {[
                { label: 'debounce_s',          val: String(draft.globalDebounceSeconds),      saved: settings ? String(settings.globalDebounceSeconds) : null,      color: 'text-violet-600 dark:text-violet-400' },
                { label: 'auto_er_ranging',      val: draft.autoErRanging.toFixed(2),           saved: settings ? settings.autoErRanging.toFixed(2) : null,           color: 'text-violet-600 dark:text-violet-400' },
                { label: 'auto_er_trending',     val: draft.autoErTrending.toFixed(2),          saved: settings ? settings.autoErTrending.toFixed(2) : null,          color: 'text-amber-600 dark:text-amber-400' },
                { label: 'conf_er_floor',        val: draft.confidenceErFloor.toFixed(2),       saved: settings ? settings.confidenceErFloor.toFixed(2) : null,       color: 'text-violet-600 dark:text-violet-400' },
                { label: 'conf_er_ceil',         val: draft.confidenceErCeiling.toFixed(2),     saved: settings ? settings.confidenceErCeiling.toFixed(2) : null,     color: 'text-emerald-600 dark:text-emerald-400' },
                { label: 'conf_z_extreme',       val: draft.confidenceZExtreme.toFixed(2),      saved: settings ? settings.confidenceZExtreme.toFixed(2) : null,      color: 'text-amber-600 dark:text-amber-400' },
                { label: 'sniper_er_floor',      val: draft.sniperStrikeErFloor.toFixed(2),     saved: settings ? settings.sniperStrikeErFloor.toFixed(2) : null,     color: 'text-violet-600 dark:text-violet-400' },
                { label: 'sniper_accel_min',     val: draft.sniperStrikeAccelMin.toFixed(2),    saved: settings ? settings.sniperStrikeAccelMin.toFixed(2) : null,    color: 'text-amber-600 dark:text-amber-400' },
                { label: 'sniper_max_ticks',     val: String(draft.sniperStrikeMaxTicks),       saved: settings ? String(settings.sniperStrikeMaxTicks) : null,       color: 'text-rose-600 dark:text-rose-400' },
                { label: 'momentum_er_floor',    val: draft.momentumRideErFloor.toFixed(2),     saved: settings ? settings.momentumRideErFloor.toFixed(2) : null,     color: 'text-violet-600 dark:text-violet-400' },
                { label: 'momentum_er_medium',   val: draft.momentumRideErMedium.toFixed(2),    saved: settings ? settings.momentumRideErMedium.toFixed(2) : null,    color: 'text-blue-600 dark:text-blue-400' },
                { label: 'momentum_er_low',      val: draft.momentumRideErLow.toFixed(2),       saved: settings ? settings.momentumRideErLow.toFixed(2) : null,       color: 'text-amber-600 dark:text-amber-400' },
                { label: 'expiry_min_sample',    val: String(draft.expiryMinSample),            saved: settings ? String(settings.expiryMinSample) : null,            color: 'text-violet-600 dark:text-violet-400' },
              ].map(r => (
                <div key={r.label} className="flex items-center gap-2">
                  <span className="text-gray-400 dark:text-zinc-500 w-40">{r.label}</span>
                  <span className={`font-bold ${r.color}`}>{r.val}</span>
                  {r.saved && r.saved !== r.val && <span className="text-[10px] text-amber-500">(was {r.saved})</span>}
                </div>
              ))}
            </div>
          </div>

          {/* Save / Reset */}
          <div className="flex items-center gap-3 flex-wrap pb-6">
            <button onClick={handleSave} disabled={saving || !isDirty}
              className={`px-5 py-2.5 rounded-xl text-sm font-bold transition-all ${isDirty && !saving ? 'bg-violet-600 hover:bg-violet-700 text-white shadow-sm shadow-violet-500/30 cursor-pointer' : 'bg-gray-200 dark:bg-zinc-800 text-gray-400 dark:text-zinc-600 cursor-not-allowed'}`}>
              {saving ? 'Saving…' : 'Save & Apply'}
            </button>
            {saved && <span className="text-[12px] text-emerald-600 dark:text-emerald-400 font-semibold">✓ Saved — engine picks up on next tick refresh</span>}
            {error && <span className="text-[12px] text-rose-500 font-semibold">{error}</span>}
            {isDirty && !saving && (
              <button onClick={() => setDraft(settings)} className="text-[11px] text-gray-400 dark:text-zinc-600 hover:text-gray-600 dark:hover:text-zinc-400 underline">Reset</button>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
