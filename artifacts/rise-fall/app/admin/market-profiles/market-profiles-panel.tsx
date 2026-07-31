'use client';

import { useState, useTransition } from 'react';

type MT = 'synthetic' | 'forex' | 'metals' | 'bull_bear' | 'step';

interface Profile {
  marketType: MT | string;
  sniperCallErMin: string | number;
  sniperPutErMin: string | number;
  sniperZMax: string | number;
  balancedCallErMin: string | number;
  balancedPutErMin: string | number;
  balancedZMax: string | number;
  aggressiveCallErMin: string | number;
  aggressivePutErMin: string | number;
  aggressiveZMax: string | number;
}

const MARKET_META: Record<MT, { icon: string; label: string; desc: string; accent: string; ring: string }> = {
  synthetic: { icon: '⚡', label: 'Synthetic Indices',   desc: 'Vol 10/25/50/75/100 · 1s Variants · Jump Indices', accent: 'text-violet-400', ring: 'border-violet-500/30 bg-violet-500/5' },
  forex:     { icon: '💱', label: 'Forex Pairs',         desc: 'EUR/USD · AUD/JPY · GBP/USD · OTC Pairs',          accent: 'text-blue-400',   ring: 'border-blue-500/30 bg-blue-500/5'   },
  metals:    { icon: '🥇', label: 'Metals',              desc: 'Gold (XAU/USD) · Silver (XAG/USD)',                 accent: 'text-amber-400',  ring: 'border-amber-500/30 bg-amber-500/5' },
  bull_bear: { icon: '🐂', label: 'Bull / Bear Indices', desc: 'Boom 300/500/1000 · Crash 300/500/1000',           accent: 'text-emerald-400',ring: 'border-emerald-500/30 bg-emerald-500/5' },
  step:      { icon: '📶', label: 'Step Indices',        desc: 'Step Index 10/25/50/100/200',                      accent: 'text-rose-400',   ring: 'border-rose-500/30 bg-rose-500/5'   },
};

const MODES = ['SNIPER', 'BALANCED', 'AGGRESSIVE'] as const;
type Mode = typeof MODES[number];

const MODE_META: Record<Mode, { icon: string; color: string; border: string; bg: string }> = {
  SNIPER:     { icon: '🎯', color: 'text-violet-400', border: 'border-violet-500/30', bg: 'bg-violet-500/5'  },
  BALANCED:   { icon: '⚖️', color: 'text-blue-400',   border: 'border-blue-500/30',   bg: 'bg-blue-500/5'    },
  AGGRESSIVE: { icon: '⚡', color: 'text-amber-400',  border: 'border-amber-500/30',  bg: 'bg-amber-500/5'   },
};

const MODE_KEYS: Record<Mode, { call: keyof Profile; put: keyof Profile; z: keyof Profile }> = {
  SNIPER:     { call: 'sniperCallErMin',     put: 'sniperPutErMin',     z: 'sniperZMax'     },
  BALANCED:   { call: 'balancedCallErMin',   put: 'balancedPutErMin',   z: 'balancedZMax'   },
  AGGRESSIVE: { call: 'aggressiveCallErMin', put: 'aggressivePutErMin', z: 'aggressiveZMax' },
};

function toNum(v: string | number | undefined, fb = 0) {
  if (v === undefined) return fb;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return isNaN(n) ? fb : n;
}

function Slider({
  label, sublabel, value, min, max, step, color, onChange,
}: {
  label: string; sublabel?: string; value: number; min: number; max: number;
  step: number; color: string; onChange: (v: number) => void;
}) {
  const decimals = step < 0.1 ? 2 : 1;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-1">
        <div>
          <span className="text-[10px] text-zinc-400 font-medium">{label}</span>
          {sublabel && <span className="ml-1 text-[9px] text-zinc-600">{sublabel}</span>}
        </div>
        <span className={`text-lg font-bold font-mono tabular-nums ${color}`}>
          {value.toFixed(decimals)}
        </span>
      </div>
      <input
        type="range"
        min={min} max={max} step={step}
        value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-violet-500 bg-zinc-700"
      />
      <div className="flex justify-between text-[9px] text-zinc-600">
        <span>{min.toFixed(decimals)}</span>
        <span>{max.toFixed(decimals)}</span>
      </div>
    </div>
  );
}

function ProfileCard({ profile, onSaved }: { profile: Profile; onSaved: (updated: Profile) => void }) {
  const mt = profile.marketType as MT;
  const meta = MARKET_META[mt];

  const [draft, setDraft] = useState({
    sniperCallErMin:     toNum(profile.sniperCallErMin, 0.05),
    sniperPutErMin:      toNum(profile.sniperPutErMin,  0.05),
    sniperZMax:          toNum(profile.sniperZMax,       1.5),
    balancedCallErMin:   toNum(profile.balancedCallErMin, 0.03),
    balancedPutErMin:    toNum(profile.balancedPutErMin,  0.03),
    balancedZMax:        toNum(profile.balancedZMax,      1.8),
    aggressiveCallErMin: toNum(profile.aggressiveCallErMin, 0.02),
    aggressivePutErMin:  toNum(profile.aggressivePutErMin,  0.02),
    aggressiveZMax:      toNum(profile.aggressiveZMax,       2.2),
  });

  const [isPending, startTransition] = useTransition();
  const [saveState, setSaveState] = useState<'idle' | 'ok' | 'err'>('idle');
  const [errMsg, setErrMsg] = useState('');

  const set = (key: string, v: number) => setDraft(d => ({ ...d, [key]: v }));

  const handleSave = () => {
    startTransition(async () => {
      setSaveState('idle');
      try {
        const res = await fetch(`/api/market-profiles/${mt}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(draft),
        });
        if (!res.ok) {
          const j = await res.json() as { error: string };
          setErrMsg(j.error ?? 'Save failed');
          setSaveState('err');
        } else {
          const updated = await res.json() as Profile;
          onSaved(updated);
          setSaveState('ok');
          setTimeout(() => setSaveState('idle'), 2500);
        }
      } catch {
        setErrMsg('Network error — check API connection');
        setSaveState('err');
      }
    });
  };

  return (
    <div className={`rounded-2xl border ${meta.ring} p-5 space-y-5`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xl">{meta.icon}</span>
            <h2 className={`text-sm font-bold ${meta.accent}`}>{meta.label}</h2>
          </div>
          <p className="text-[10px] text-zinc-500 mt-0.5">{meta.desc}</p>
        </div>
        <button
          onClick={handleSave}
          disabled={isPending}
          className={`shrink-0 px-3 py-1.5 text-xs font-bold rounded-lg transition-all disabled:opacity-50
            ${saveState === 'ok'
              ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
              : 'bg-violet-600 hover:bg-violet-700 text-white'}`}
        >
          {isPending ? 'Saving…' : saveState === 'ok' ? '✓ Saved' : 'Save'}
        </button>
      </div>

      {saveState === 'err' && (
        <div className="rounded-lg bg-rose-500/10 border border-rose-500/30 px-3 py-2 text-[11px] text-rose-400">
          {errMsg}
        </div>
      )}

      {/* Column headers */}
      <div className="grid grid-cols-3 gap-1 text-center">
        <span className="text-[9px] font-bold tracking-widest text-emerald-400 uppercase">● CALL ↑ ER MIN</span>
        <span className="text-[9px] font-bold tracking-widest text-rose-400 uppercase">● PUT ↓ ER MIN</span>
        <span className="text-[9px] font-bold tracking-widest text-zinc-400 uppercase">Z-SCORE MAX</span>
      </div>

      {/* Mode rows */}
      <div className="space-y-4">
        {MODES.map(mode => {
          const { icon, color, border, bg } = MODE_META[mode];
          const keys = MODE_KEYS[mode];
          return (
            <div key={mode} className={`rounded-xl border ${border} ${bg} p-4`}>
              <div className="flex items-center gap-2 mb-4">
                <span className="text-sm">{icon}</span>
                <span className={`text-sm font-bold ${color}`}>{mode.charAt(0) + mode.slice(1).toLowerCase()}</span>
                <span className={`text-[9px] font-bold tracking-widest px-1.5 py-0.5 rounded border ${border} ${color}`}>
                  {mode}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <Slider
                  label="CALL ER ≥"
                  value={draft[keys.call as keyof typeof draft]}
                  min={0} max={1} step={0.01}
                  color="text-emerald-400"
                  onChange={v => set(keys.call as string, v)}
                />
                <Slider
                  label="PUT ER ≥"
                  value={draft[keys.put as keyof typeof draft]}
                  min={0} max={1} step={0.01}
                  color="text-rose-400"
                  onChange={v => set(keys.put as string, v)}
                />
                <Slider
                  label="Z-Max"
                  value={draft[keys.z as keyof typeof draft]}
                  min={0.5} max={5} step={0.1}
                  color="text-zinc-100"
                  onChange={v => set(keys.z as string, v)}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Validity check */}
      {(() => {
        const callOk = draft.sniperCallErMin <= draft.balancedCallErMin && draft.balancedCallErMin <= draft.aggressiveCallErMin;
        const putOk  = draft.sniperPutErMin  <= draft.balancedPutErMin  && draft.balancedPutErMin  <= draft.aggressivePutErMin;
        const zOk    = draft.sniperZMax <= draft.balancedZMax && draft.balancedZMax <= draft.aggressiveZMax;
        const valid  = callOk && putOk && zOk;
        return (
          <p className={`text-[10px] font-medium ${valid ? 'text-emerald-400' : 'text-amber-400'}`}>
            {valid ? '✓ Matrix is structurally valid.' : '⚠ Check ordering: Sniper ≤ Balanced ≤ Aggressive for ER · Sniper ≤ Balanced ≤ Aggressive for Z'}
          </p>
        );
      })()}
    </div>
  );
}

export function MarketProfilesPanel({ profiles }: { profiles: Profile[] }) {
  const [list, setList] = useState(profiles);

  const handleSaved = (updated: Profile) => {
    setList(prev => prev.map(p => p.marketType === updated.marketType ? { ...p, ...updated } : p));
  };

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 px-4 py-3">
        <p className="text-[11px] text-amber-300 font-medium">
          <span className="font-bold">How it works:</span> The bot auto-detects the active symbol&apos;s market type and applies these thresholds.
          Global Settings act as fallback if a profile row is missing.
        </p>
      </div>
      {list.map(p => (
        <ProfileCard key={p.marketType} profile={p} onSaved={handleSaved} />
      ))}
    </div>
  );
}
