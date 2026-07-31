'use client';

import { useState, useEffect, useRef } from 'react';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  ChevronDown, Bot, TrendingUp, TrendingDown, Activity,
  ShieldCheck, Target, RefreshCw, Cpu, SlidersHorizontal,
  AlertTriangle, Zap, Sparkles, Bell, BellOff,
} from 'lucide-react';
import { usePushNotifications } from '@/hooks/use-push-notifications';
import type { UseAutotradeReturn, BotLogEntry, GateOverride, PnlPoint, ConsensusMode, RiskEngine, RoutingTier } from '@/hooks/use-autotrade';
import { SignalHistoryPanel } from '@/components/signal-history-panel';
import type { GateType, IndicatorVote } from '@/lib/asset-config';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Info } from 'lucide-react';
import type { OpenPosition } from '@/lib/types';
import { classifyMarket } from '@/lib/market-classifier';
import type { ActiveSymbol } from '@deriv/core';

// ─── NumberInput — clears cleanly, commits on blur ───────────────────────────

interface NumberInputProps {
  value: number | string;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  className?: string;
  suffix?: string;
}

function NumberInput({ value, onChange, min, max, step, disabled, className, suffix }: NumberInputProps) {
  const [raw, setRaw] = useState(String(value));

  // Keep in sync when parent changes (e.g. bot reset)
  useEffect(() => { setRaw(String(value)); }, [value]);

  const commit = (str: string) => {
    const n = parseFloat(str);
    if (!isNaN(n)) {
      const clamped = min !== undefined ? Math.max(min, n) : n;
      const clamped2 = max !== undefined ? Math.min(max, clamped) : clamped;
      onChange(clamped2);
      setRaw(String(clamped2));
    } else {
      setRaw(String(value)); // revert to last valid
    }
  };

  if (suffix) {
    return (
      <div className="relative">
        <Input
          type="number"
          min={min} max={max} step={step}
          value={raw}
          disabled={disabled}
          className={`pr-8 ${className ?? 'h-8 text-sm'}`}
          onChange={e => setRaw(e.target.value)}
          onBlur={e => commit(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') commit((e.target as HTMLInputElement).value); }}
        />
        <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">{suffix}</span>
      </div>
    );
  }

  return (
    <Input
      type="number"
      min={min} max={max} step={step}
      value={raw}
      disabled={disabled}
      className={className ?? 'h-8 text-sm'}
      onChange={e => setRaw(e.target.value)}
      onBlur={e => commit(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') commit((e.target as HTMLInputElement).value); }}
    />
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface AutotradePanelProps {
  autotrade: UseAutotradeReturn;
  isAuthenticated: boolean;
  isConnected: boolean;
  userToken?: string | null;
  activeSymbol?: ActiveSymbol | null;
}

const STATUS_LABELS: Record<string, string> = {
  idle: 'Idle', warming: 'Collecting data…', analyzing: 'Analyzing',
  trading: 'Placing trade…', paused: 'Paused',
};
const STATUS_COLORS: Record<string, string> = {
  idle: 'bg-muted text-muted-foreground',
  warming: 'bg-yellow-500/20 text-yellow-600 dark:text-yellow-400',
  analyzing: 'bg-blue-500/20 text-blue-600 dark:text-blue-400',
  trading: 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400',
  paused: 'bg-destructive/20 text-destructive',
};
const LOG_COLORS: Record<BotLogEntry['type'], string> = {
  signal: 'text-yellow-600 dark:text-yellow-400',
  trade: 'text-emerald-600 dark:text-emerald-400',
  result: 'text-primary',
  info: 'text-muted-foreground',
  warn: 'text-destructive',
  win: 'text-emerald-600 dark:text-emerald-400',
  loss: 'text-destructive',
};
const REGIME_COLORS: Record<string, string> = {
  tick: 'bg-violet-500/15 text-violet-700 dark:text-violet-400 border-violet-500/30',
  short: 'bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30',
  medium: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30',
  long: 'bg-orange-500/15 text-orange-700 dark:text-orange-400 border-orange-500/30',
};

function voteColor(v: IndicatorVote) {
  if (v === 'CALL') return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30';
  if (v === 'PUT') return 'bg-rose-500/15 text-rose-700 dark:text-rose-400 border-rose-500/30';
  return 'bg-muted/60 text-muted-foreground border-border/50';
}
function voteLabel(v: IndicatorVote) {
  if (v === 'CALL') return '▲ Rise';
  if (v === 'PUT') return '▼ Fall';
  return '— Neutral';
}

const RISK_ENGINE_TABS: { value: RiskEngine; label: string; activeClass: string }[] = [
  { value: 'OFF',            label: 'Off',       activeClass: 'bg-muted text-foreground' },
  { value: 'MARTINGALE',     label: 'Recovery',  activeClass: 'bg-rose-500/20 text-rose-700 dark:text-rose-400' },
  { value: 'ANTI_MARTINGALE',label: 'Streak',    activeClass: 'bg-amber-500/20 text-amber-700 dark:text-amber-400' },
  { value: 'CONFIDENCE',     label: 'Dynamic',   activeClass: 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-400' },
];

// ─── Live global settings (polls every 30 s) ─────────────────────────────────

interface GlobalSettings {
  sniperCallErMin: number; sniperPutErMin: number; sniperZMax: number;
  balancedCallErMin: number; balancedPutErMin: number; balancedZMax: number;
  aggressiveCallErMin: number; aggressivePutErMin: number; aggressiveZMax: number;
}

const DEFAULT_SETTINGS: GlobalSettings = {
  sniperCallErMin: 0.00, sniperPutErMin: 0.60, sniperZMax: 1.5,
  balancedCallErMin: 0.10, balancedPutErMin: 0.40, balancedZMax: 2.0,
  aggressiveCallErMin: 0.20, aggressivePutErMin: 0.30, aggressiveZMax: 2.5,
};

function useGlobalSettings(): GlobalSettings {
  const [settings, setSettings] = useState<GlobalSettings>(DEFAULT_SETTINGS);
  useEffect(() => {
    const n = (v: unknown, fb: number) => {
      if (v === undefined || v === null) return fb;
      const p = typeof v === 'string' ? parseFloat(v) : Number(v);
      return isNaN(p) ? fb : p;
    };
    const load = () => {
      fetch('/api/settings')
        .then(r => r.json())
        .then((d: Record<string, unknown>) => {
          setSettings({
            sniperCallErMin:     n(d.sniperCallErMin, 0.00),
            sniperPutErMin:      n(d.sniperPutErMin, 0.60),
            sniperZMax:          n(d.sniperZMax, 1.5),
            balancedCallErMin:   n(d.balancedCallErMin, 0.10),
            balancedPutErMin:    n(d.balancedPutErMin, 0.40),
            balancedZMax:        n(d.balancedZMax, 2.0),
            aggressiveCallErMin: n(d.aggressiveCallErMin, 0.20),
            aggressivePutErMin:  n(d.aggressivePutErMin, 0.30),
            aggressiveZMax:      n(d.aggressiveZMax, 2.5),
          });
        })
        .catch(() => { /* keep previous values */ });
    };
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);
  return settings;
}

// ─── Market profiles: per-market-type ER + Z overrides ───────────────────────

type MarketProfileEntry = {
  sniperCallErMin: number; sniperPutErMin: number; sniperZMax: number;
  balancedCallErMin: number; balancedPutErMin: number; balancedZMax: number;
  aggressiveCallErMin: number; aggressivePutErMin: number; aggressiveZMax: number;
};

function useMarketProfiles(): Map<string, MarketProfileEntry> {
  const [profiles, setProfiles] = useState<Map<string, MarketProfileEntry>>(new Map());
  useEffect(() => {
    const n = (v: unknown, fb: number) => {
      if (v === undefined || v === null) return fb;
      const p = typeof v === 'string' ? parseFloat(v) : Number(v);
      return isNaN(p) ? fb : p;
    };
    const load = () => {
      fetch('/api/market-profiles')
        .then(r => r.json())
        .then((rows: Record<string, unknown>[]) => {
          const map = new Map<string, MarketProfileEntry>();
          for (const row of rows) {
            const mt = row.marketType as string;
            map.set(mt, {
              sniperCallErMin:     n(row.sniperCallErMin, 0.05),
              sniperPutErMin:      n(row.sniperPutErMin, 0.05),
              sniperZMax:          n(row.sniperZMax, 1.5),
              balancedCallErMin:   n(row.balancedCallErMin, 0.03),
              balancedPutErMin:    n(row.balancedPutErMin, 0.03),
              balancedZMax:        n(row.balancedZMax, 1.8),
              aggressiveCallErMin: n(row.aggressiveCallErMin, 0.02),
              aggressivePutErMin:  n(row.aggressivePutErMin, 0.02),
              aggressiveZMax:      n(row.aggressiveZMax, 2.2),
            });
          }
          setProfiles(map);
        })
        .catch(() => { /* keep previous */ });
    };
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);
  return profiles;
}

const MARKET_TYPE_META: Record<string, { icon: string; label: string; color: string }> = {
  synthetic: { icon: '⚡', label: 'Synthetic',  color: 'text-violet-500 bg-violet-500/10 border-violet-500/30' },
  forex:     { icon: '💱', label: 'Forex',      color: 'text-blue-500 bg-blue-500/10 border-blue-500/30'       },
  metals:    { icon: '🥇', label: 'Metals',     color: 'text-amber-500 bg-amber-500/10 border-amber-500/30'    },
  bull_bear: { icon: '🐂', label: 'Bull/Bear',  color: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/30' },
  step:      { icon: '📶', label: 'Step',        color: 'text-rose-500 bg-rose-500/10 border-rose-500/30'      },
};

// ─── Consensus modes built from live admin settings ───────────────────────────

function fmt(n: number) { return n.toFixed(2).replace(/\.?0+$/, ''); }

function buildConsensusModes(s: GlobalSettings) {
  return [
    {
      value: 'SNIPER' as ConsensusMode,
      label: 'Sniper',
      gates: `↑${fmt(s.sniperCallErMin)} ↓${fmt(s.sniperPutErMin)} · Z<${s.sniperZMax}`,
      desc: `Maximum defense — Rise ER gate: ${fmt(s.sniperCallErMin)}, Fall ER gate: ${fmt(s.sniperPutErMin)}, Z-Score veto at ±${s.sniperZMax}. Fewest trades, highest precision.`,
      activeClass: 'bg-violet-500/20 text-violet-700 dark:text-violet-300 border border-violet-500/40',
    },
    {
      value: 'BALANCED' as ConsensusMode,
      label: 'Balanced',
      gates: `↑${fmt(s.balancedCallErMin)} ↓${fmt(s.balancedPutErMin)} · Z<${s.balancedZMax}`,
      desc: `Tightened baseline — Rise ER gate: ${fmt(s.balancedCallErMin)}, Fall ER gate: ${fmt(s.balancedPutErMin)}, Z-Score veto at ±${s.balancedZMax}. Fewer trades, higher-quality setups.`,
      activeClass: 'bg-blue-500/20 text-blue-700 dark:text-blue-300 border border-blue-500/40',
    },
    {
      value: 'AGGRESSIVE' as ConsensusMode,
      label: 'Aggressive',
      gates: `↑${fmt(s.aggressiveCallErMin)} ↓${fmt(s.aggressivePutErMin)} · Z<${s.aggressiveZMax}`,
      desc: `Loosest gates — Rise ER gate: ${fmt(s.aggressiveCallErMin)}, Fall ER gate: ${fmt(s.aggressivePutErMin)}, Z-Score veto at ±${s.aggressiveZMax}. Maximum frequency, higher risk.`,
      activeClass: 'bg-orange-500/20 text-orange-700 dark:text-orange-300 border border-orange-500/40',
    },
    {
      value: 'AUTO' as ConsensusMode,
      label: 'Auto',
      gates: 'Live ER',
      desc: `Gate strictness adapts in real-time — Choppy (ER<0.45) → Sniper gates (Z<${s.sniperZMax}). Ranging (ER 0.45–0.65) → Balanced gates (Z<${s.balancedZMax}). Trending (ER≥0.65) → Aggressive gates (Z<${s.aggressiveZMax}).`,
      activeClass: 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border border-emerald-500/40',
    },
  ];
}


// ─── LiveDuration — live countdown / tick progress for an open position ───────

function LiveDuration({ pos }: { pos: OpenPosition }) {
  const isTick = (pos.tick_count ?? 0) > 0;
  const [remaining, setRemaining] = useState<number | null>(() => {
    if (!isTick && pos.date_expiry) {
      return Math.max(0, pos.date_expiry - Math.floor(Date.now() / 1000));
    }
    return null;
  });

  useEffect(() => {
    if (isTick || !pos.date_expiry) return;
    const update = () => {
      setRemaining(Math.max(0, pos.date_expiry - Math.floor(Date.now() / 1000)));
    };
    update();
    const id = setInterval(update, 500);
    return () => clearInterval(id);
  }, [isTick, pos.date_expiry]);

  if (isTick) {
    const elapsed = pos.tick_stream?.length ?? 0;
    const total = pos.tick_count ?? 0;
    const pct = total > 0 ? Math.min(100, (elapsed / total) * 100) : 0;
    return (
      <div className="flex items-center gap-1.5 mt-1">
        <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-violet-500 rounded-full transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="text-[9px] tabular-nums text-muted-foreground shrink-0">{elapsed}/{total}t</span>
      </div>
    );
  }

  if (remaining === null) return null;
  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  const label = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  return (
    <div className="flex items-center gap-1 mt-0.5">
      <span className="text-[9px] text-muted-foreground">⏱</span>
      <span className={`text-[9px] tabular-nums font-medium ${remaining < 5 ? 'text-rose-500' : 'text-muted-foreground'}`}>
        {label} left
      </span>
    </div>
  );
}

// ─── VolTierSparkline — volatility tier badge + trimmed-mean vol sparkline ───

type VolTier = 'COLLECTING' | 'MILD' | 'ACTIVE' | 'ELEVATED' | 'HYPER';

function getVolTier(volPct: number | null): VolTier {
  if (volPct === null) return 'COLLECTING';
  if (volPct < 0.15)  return 'MILD';
  if (volPct < 0.35)  return 'ACTIVE';
  if (volPct <= 0.60) return 'ELEVATED';
  return 'HYPER';
}

const VOL_TIER_CFG: Record<VolTier, {
  label: string; multiplier: string; color: string;
  textClass: string; bgClass: string; tooltip: string;
}> = {
  COLLECTING: { label: 'COLLECTING', multiplier: '—',    color: '#94a3b8', textClass: 'text-slate-400',    bgClass: 'bg-slate-500/10 border-slate-500/20',   tooltip: 'Warming up tick buffer — no signal yet' },
  MILD:       { label: 'MILD',       multiplier: '×1',   color: '#38bdf8', textClass: 'text-sky-500',      bgClass: 'bg-sky-500/10 border-sky-500/30',       tooltip: '< 0.15% — standard entry at API_MIN duration' },
  ACTIVE:     { label: 'ACTIVE',     multiplier: '×2',   color: '#10b981', textClass: 'text-emerald-500',  bgClass: 'bg-emerald-500/10 border-emerald-500/30', tooltip: '0.15–0.35% — double API_MIN, trend needs room' },
  ELEVATED:   { label: 'ELEVATED',   multiplier: '×3',   color: '#f59e0b', textClass: 'text-amber-500',    bgClass: 'bg-amber-500/10 border-amber-500/30',   tooltip: '0.35–0.60% — triple API_MIN, capturing extended momentum' },
  HYPER:      { label: 'HYPER',      multiplier: '×1↩',  color: '#f43f5e', textClass: 'text-rose-500',     bgClass: 'bg-rose-500/10 border-rose-500/30',     tooltip: '> 0.60% — mean-reversion cap: back to API_MIN to exit before snap-back' },
};

// Threshold lines drawn on the sparkline at each tier boundary
const TIER_THRESHOLDS = [
  { val: 0.05, label: '.05' },
  { val: 0.15, label: '.15' },
  { val: 0.35, label: '.35' },
  { val: 0.60, label: '.60' },
];

function VolTierSparkline({ volPct, history }: { volPct: number | null; history: number[] }) {
  const tier    = getVolTier(volPct);
  const cfg     = VOL_TIER_CFG[tier];
  const W = 96, H = 32;

  // Y scale anchored at 0; ceiling is max(0.80, highest reading in window)
  const yMax  = Math.max(0.80, ...history);
  const toY   = (v: number) => H - Math.max(1, Math.min(H - 1, (v / yMax) * H));
  const toX   = (i: number) => history.length < 2 ? W : (i / (history.length - 1)) * W;
  const hasSpark = history.length >= 2;
  const linePath = hasSpark
    ? `M ${history.map((v, i) => `${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' L ')}`
    : '';
  const lastY = hasSpark ? toY(history[history.length - 1]) : null;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className={`rounded border px-2.5 py-2 flex items-center gap-2 cursor-default ${cfg.bgClass}`}>
            {/* Left: label + multiplier + live value */}
            <div className="shrink-0 w-[76px]">
              <p className="text-[8px] font-semibold text-muted-foreground uppercase tracking-widest mb-0.5">Vol Tier</p>
              <div className="flex items-baseline gap-1">
                <span className={`text-[11px] font-bold leading-none ${cfg.textClass}`}>{cfg.label}</span>
                <span className={`text-[9px] font-medium ${cfg.textClass} opacity-80`}>{cfg.multiplier}</span>
              </div>
              {volPct !== null
                ? <p className="text-[9px] font-mono text-muted-foreground mt-0.5">{volPct.toFixed(3)}%</p>
                : <p className="text-[9px] text-muted-foreground mt-0.5 opacity-50">—</p>
              }
            </div>

            {/* Right: sparkline with tier threshold lines */}
            <div className="flex-1 flex items-center justify-end">
              <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="overflow-visible">
                {/* Tier boundary lines */}
                {TIER_THRESHOLDS.map(({ val, label: lbl }) => {
                  const y = toY(val);
                  if (y < 0 || y > H + 2) return null;
                  return (
                    <g key={val}>
                      <line x1="0" y1={y.toFixed(1)} x2={W} y2={y.toFixed(1)}
                        stroke="currentColor" strokeWidth="0.5" strokeOpacity="0.18" strokeDasharray="2 3" />
                      <text x="1" y={(y - 1).toFixed(1)} fontSize="5.5"
                        fill="currentColor" opacity="0.30" dominantBaseline="auto">{lbl}</text>
                    </g>
                  );
                })}
                {/* Vol line */}
                {hasSpark && (
                  <path d={linePath} fill="none" stroke={cfg.color} strokeWidth="1.5"
                    strokeLinecap="round" strokeLinejoin="round" opacity="0.85" />
                )}
                {/* Current-value dot */}
                {hasSpark && lastY !== null && (
                  <circle cx={W} cy={lastY.toFixed(1)} r="2.5" fill={cfg.color} />
                )}
                {!hasSpark && (
                  <text x={W / 2} y={H / 2 + 3} textAnchor="middle"
                    fontSize="7" fill="currentColor" opacity="0.25">collecting…</text>
                )}
              </svg>
            </div>
          </div>
        </TooltipTrigger>
        <TooltipContent side="left" className="max-w-[200px] text-xs">
          {cfg.tooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// ─── PnlSparkline — SVG profit curve ─────────────────────────────────────────

function PnlSparkline({ history }: { history: PnlPoint[] }) {
  if (history.length < 2) return null;
  const W = 140, H = 40;
  const values = history.map(p => p.cumPnl);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const range = max - min || 1;
  const toY = (v: number) => H - ((v - min) / range) * (H - 2) - 1;
  const toX = (i: number) => (i / (values.length - 1)) * W;
  const pathPts = values.map((v, i) => `${toX(i).toFixed(1)},${toY(v).toFixed(1)}`);
  const linePath = `M ${pathPts.join(' L ')}`;
  const zeroY = toY(0).toFixed(1);
  const areaPath = `${linePath} L ${W.toFixed(1)},${zeroY} L 0,${zeroY} Z`;
  const last = values[values.length - 1];
  const color = last >= 0 ? '#10b981' : '#f43f5e';
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="overflow-visible shrink-0">
      <path d={areaPath} fill={color} fillOpacity="0.12" />
      <path d={linePath} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="0" y1={zeroY} x2={W} y2={zeroY} stroke="currentColor" strokeWidth="0.5" strokeOpacity="0.25" strokeDasharray="3 3" />
    </svg>
  );
}

// ─── Panel ────────────────────────────────────────────────────────────────────

export function AutotradePanel({ autotrade, isAuthenticated, isConnected, userToken, activeSymbol }: AutotradePanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const {
    isEnabled, enable, disable, status, signal,
    adaptiveDuration, volatility, volHistory, indicators,
    assetClass, assetConfig, activeRegime, activeBucket,
    botPositions, currentStake,
    log, stats, config, setConfig,
    sessionPnl, pnlHistory,
    efficiencyRatio, activeVotes, marketRegime,
    gateStates, effectiveMode,
    signalHistory,
    routingTier, dynamicLookback,
    durationOptions,
  } = autotrade;

  const { permission, isSubscribed, isLoading: pushLoading, subscribe, unsubscribe, sendTradeNotification } = usePushNotifications(userToken ?? null);
  const prevPnlLengthRef = useRef(pnlHistory.length);

  const globalSettings = useGlobalSettings();
  const marketProfiles = useMarketProfiles();

  // Determine active market type from the current symbol — updates when user switches asset
  const activeMarketType = activeSymbol?.underlying_symbol
    ? classifyMarket(activeSymbol.underlying_symbol)
    : null;
  const activeMarketMeta = activeMarketType ? MARKET_TYPE_META[activeMarketType] : null;
  const activeMarketProfile = activeMarketType ? marketProfiles.get(activeMarketType) : undefined;

  // Effective settings = market profile thresholds (if loaded) falling back to global settings
  const effectiveSettings: GlobalSettings = activeMarketProfile
    ? {
        sniperCallErMin:     activeMarketProfile.sniperCallErMin,
        sniperPutErMin:      activeMarketProfile.sniperPutErMin,
        sniperZMax:          activeMarketProfile.sniperZMax,
        balancedCallErMin:   activeMarketProfile.balancedCallErMin,
        balancedPutErMin:    activeMarketProfile.balancedPutErMin,
        balancedZMax:        activeMarketProfile.balancedZMax,
        aggressiveCallErMin: activeMarketProfile.aggressiveCallErMin,
        aggressivePutErMin:  activeMarketProfile.aggressivePutErMin,
        aggressiveZMax:      activeMarketProfile.aggressiveZMax,
      }
    : globalSettings;

  const consensusModes = buildConsensusModes(effectiveSettings);

  useEffect(() => {
    if (!isSubscribed) return;
    if (pnlHistory.length <= prevPnlLengthRef.current) {
      prevPnlLengthRef.current = pnlHistory.length;
      return;
    }
    prevPnlLengthRef.current = pnlHistory.length;
    const last = pnlHistory[pnlHistory.length - 1];
    if (!last) return;
    const won = last.pnl >= 0;
    const sign = won ? '+' : '';
    sendTradeNotification({
      title: won ? '✅ PulseEdge — Win' : '❌ PulseEdge — Loss',
      body: `Trade #${last.tradeNum} settled ${sign}$${Math.abs(last.pnl).toFixed(2)} · Session: ${last.cumPnl >= 0 ? '+' : ''}$${Math.abs(last.cumPnl).toFixed(2)}`,
    });
  }, [pnlHistory, isSubscribed, sendTradeNotification]);

  const canActivate = isAuthenticated && isConnected;
  const isRiskEngineActive = config.riskEngine !== 'OFF';
  const baseStake = parseFloat(config.stake) || 1;
  const liveStake = parseFloat(currentStake) || baseStake;
  const stakeMultiplied = isRiskEngineActive && isEnabled && Math.abs(liveStake - baseStake) > 0.001;

  // Compute dollar equivalents for TP/SL display (based on current stake + typical 95% payout)
  const estPayout = baseStake * 1.95; // ~95% payout typical on Deriv Rise/Fall
  const estPotentialProfit = estPayout - baseStake;
  const estTPDollar = (estPotentialProfit * config.takeProfitPct / 100).toFixed(2);
  const estSLDollar = (baseStake * config.stopLossPct / 100).toFixed(2);

  // Indicators are live regardless of bot state (once ticks arrive)
  const hasLiveData = indicators !== null;

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger asChild>
        <button className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg border border-border/60 hover:bg-muted/50 transition-colors text-sm font-medium" type="button">
          <div className="flex items-center gap-2 flex-wrap">
            <Bot className="h-4 w-4 text-primary shrink-0" />
            <span>Auto Trade Bot</span>
            {isEnabled && (
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
              </span>
            )}
            {/* Regime badge — shows even when bot is off, once ticks flowing */}
            {activeRegime && (
              <Badge variant="outline" className={`text-[9px] px-1.5 py-0 h-4 border ${REGIME_COLORS[activeRegime]}`}>
                {activeRegime.toUpperCase()}
              </Badge>
            )}
            {assetConfig && (
              <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 border-muted text-muted-foreground">
                {assetConfig.displayName}
              </Badge>
            )}
            {marketRegime && (
              <Badge variant="outline" className={`text-[9px] px-1.5 py-0 h-4 font-semibold ${
                marketRegime === 'TRENDING'
                  ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
                  : marketRegime === 'VOLATILE'
                  ? 'border-rose-500/40 text-rose-500'
                  : 'border-amber-500/40 text-amber-600 dark:text-amber-400'
              }`}>
                {marketRegime === 'TRENDING' ? '⚡ Trending' : marketRegime === 'VOLATILE' ? '⚠ Volatile' : '↔ Ranging'}
              </Badge>
            )}
            {config.autoSell && (
              <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 border-emerald-500/40 text-emerald-600 dark:text-emerald-400">
                TP {config.takeProfitPct}% / SL {config.stopLossPct}%
              </Badge>
            )}
            {isRiskEngineActive && isEnabled && (
              <Badge variant="outline" className={`text-[9px] px-1.5 py-0 h-4 ${stakeMultiplied ? 'border-orange-500/50 text-orange-600 dark:text-orange-400' : 'border-blue-500/40 text-blue-600 dark:text-blue-400'}`}>
                {config.riskEngine === 'MARTINGALE' ? 'MG' : config.riskEngine === 'ANTI_MARTINGALE' ? 'AMG' : 'DYN'} ${liveStake.toFixed(2)}
              </Badge>
            )}
          </div>
          <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform duration-200 shrink-0 ${isOpen ? 'rotate-180' : ''}`} />
        </button>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="mt-2 space-y-3">

          {/* Enable toggle + status */}
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-2">
              <Switch id="autotrade-toggle" checked={isEnabled}
                onCheckedChange={c => c ? enable() : disable()} disabled={!canActivate} />
              <Label htmlFor="autotrade-toggle" className="cursor-pointer text-sm">
                {isEnabled ? 'Bot Active' : 'Enable Bot'}
              </Label>
            </div>
            <div className="flex items-center gap-2">
              {permission !== 'unsupported' && userToken && (
                <button
                  type="button"
                  onClick={() => isSubscribed ? unsubscribe() : subscribe()}
                  disabled={pushLoading || permission === 'denied'}
                  title={
                    permission === 'denied' ? 'Notifications blocked in browser settings'
                    : isSubscribed ? 'Disable trade notifications'
                    : 'Enable push notifications for trade results'
                  }
                  className={`flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
                    isSubscribed
                      ? 'border-emerald-500/50 text-emerald-600 dark:text-emerald-400 bg-emerald-500/10'
                      : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground'
                  } disabled:opacity-40 disabled:cursor-not-allowed`}
                >
                  {isSubscribed ? <Bell className="h-3 w-3" /> : <BellOff className="h-3 w-3" />}
                  {isSubscribed ? 'Notifs on' : 'Notifs off'}
                </button>
              )}
              <Badge variant="outline" className={`text-xs px-2 py-0.5 border-0 font-medium ${STATUS_COLORS[status]}`}>
                {STATUS_LABELS[status]}
              </Badge>
            </div>
          </div>

          {!canActivate && (
            <p className="text-xs text-muted-foreground px-1">
              {!isAuthenticated ? 'Log in to use the bot.' : 'Waiting for connection…'}
            </p>
          )}

          {/* Live dynamic config engine — shows as soon as ticks arrive, bot on or off */}
          {activeRegime && activeBucket && (
            <div className={`rounded-md border px-3 py-2 space-y-1.5 ${REGIME_COLORS[activeRegime]}`}>
              <div className="flex items-center gap-1.5">
                <Cpu className="h-3 w-3 shrink-0" />
                <span className="text-[10px] font-semibold uppercase tracking-wide">
                  {activeRegime} Regime — {assetConfig?.displayName ?? assetClass}
                </span>
                {marketRegime && (
                  <span className={`ml-1 text-[9px] font-bold px-1.5 py-0.5 rounded ${
                    marketRegime === 'TRENDING'
                      ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400'
                      : marketRegime === 'VOLATILE'
                      ? 'bg-rose-500/20 text-rose-500'
                      : 'bg-amber-500/20 text-amber-600 dark:text-amber-400'
                  }`}>
                    {marketRegime === 'TRENDING' ? '⚡ TRENDING' : marketRegime === 'VOLATILE' ? '⚠ VOLATILE' : '↔ RANGING'}
                  </span>
                )}
                <div className="ml-auto flex items-center gap-1.5">
                  {(() => {
                    const t = getVolTier(volatility);
                    const c = VOL_TIER_CFG[t];
                    return (
                      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${c.bgClass} ${c.textClass}`}>
                        {c.label} {c.multiplier !== '—' && c.multiplier !== 'NULL' ? c.multiplier : ''}
                      </span>
                    );
                  })()}
                  {adaptiveDuration && (
                    <span className="text-[9px] opacity-60 font-mono">{adaptiveDuration.label}</span>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                {activeBucket.indicatorStack.primary.map((n) => (
                  <span key={n} className="text-[9px] bg-background/40 rounded px-1.5 py-0.5 font-mono">{n}</span>
                ))}
                {activeBucket.indicatorStack.secondary.map((n) => (
                  <span key={n} className="text-[9px] bg-background/20 rounded px-1.5 py-0.5 font-mono opacity-70">{n}</span>
                ))}
              </div>
              <p className="text-[9px] opacity-70">
                Rule: <span className="font-medium">{activeBucket.indicatorStack.alignmentRule.replace(/_/g, ' ')}</span>
                {' · '}Risk ×{activeBucket.riskMultiplier}
              </p>
            </div>
          )}

          {/* Live indicator tiles — always shown when data arrives */}
          {hasLiveData && indicators && (
            <>
              <div className="grid grid-cols-3 gap-1.5">
                <IndicatorTile label="ER"
                  value={indicators.erValue !== null ? indicators.erValue.toFixed(2) : '—'}
                  sub={indicators.erValue !== null ? (indicators.erValue >= 0.65 ? 'Trending' : indicators.erValue < 0.45 ? 'Choppy' : 'Moderate') : 'collecting…'}
                  highlight={indicators.erValue !== null && indicators.erValue >= 0.65} />
                <IndicatorTile label="R-Tick"
                  value={indicators.rTickValue !== null ? `${(indicators.rTickValue * 100).toFixed(0)}%` : '—'}
                  sub={indicators.rTickValue !== null ? (indicators.rTickValue > 0.75 ? 'Bull exhaust' : indicators.rTickValue < 0.25 ? 'Bear exhaust' : 'Balanced') : 'collecting…'}
                  highlight={indicators.rTickValue !== null && (indicators.rTickValue > 0.75 || indicators.rTickValue < 0.25)} />
                <IndicatorTile label="Z-Score"
                  value={indicators.zScoreValue !== null ? indicators.zScoreValue.toFixed(2) : '—'}
                  sub={indicators.zScoreValue !== null ? (Math.abs(indicators.zScoreValue) > 2.0 ? 'Extreme' : Math.abs(indicators.zScoreValue) > 1.5 ? 'Stretched' : 'Normal') : 'collecting…'}
                  highlight={indicators.zScoreValue !== null && Math.abs(indicators.zScoreValue) > 2.0} />
              </div>
              {/* Vol Tier indicator — full-width row with sparkline */}
              <VolTierSparkline volPct={volatility} history={volHistory} />
            </>
          )}

          {/* Asymmetric signal display — Entry Engine + Suppression Gates */}
          {hasLiveData && indicators && (() => {
            const { macroVote, microVote, accelVote } = indicators;
            const allVotes  = [macroVote, microVote, accelVote];
            const callCount = allVotes.filter(v => v === 'CALL').length;
            const putCount  = allVotes.filter(v => v === 'PUT').length;
            const aligned   = callCount === 3 || putCount === 3;
            const direction = callCount === 3 ? 'CALL' : putCount === 3 ? 'PUT' : null;
            const anyVeto   = gateStates && (gateStates.noise === 'VETO' || gateStates.exhaustion === 'VETO' || gateStates.volatility === 'VETO');
            const signalReady = aligned && !anyVeto;

            return (
              <div className="space-y-2">
                {/* Mode badge */}
                <div className="flex items-center justify-between px-1">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Signal Engine</p>
                  <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded ${
                    consensusModes.find(m => m.value === effectiveMode)?.activeClass ?? ''
                  }`}>
                    {config.consensusMode === 'AUTO'
                      ? `AUTO → ${effectiveMode}${efficiencyRatio !== null ? ` (ER ${efficiencyRatio.toFixed(2)})` : ''}`
                      : config.consensusMode} · {activeVotes}/3
                  </span>
                </div>

                {/* ── Routing Telemetry Badge ── */}
                {routingTier && adaptiveDuration && (() => {
                  const TIER_META: Record<RoutingTier, { label: string; icon: string; bg: string; text: string; desc: string }> = {
                    SNIPER:   { label: 'Sniper Strike',  icon: '🎯', bg: 'bg-cyan-500/15',   text: 'text-cyan-400',   desc: 'ER>0.70 · Accel spike · Tick contract' },
                    MOMENTUM: { label: 'Momentum Ride',  icon: '⚡', bg: 'bg-emerald-500/15', text: 'text-emerald-400', desc: 'ER>0.50 · Inverse-ER seconds' },
                    MACRO:    { label: 'Macro Hold',     icon: '📊', bg: 'bg-amber-500/15',   text: 'text-amber-400',  desc: 'ER≤0.50 · Grinding market · Minutes' },
                    FAILSAFE: { label: 'Failsafe',       icon: '🛡', bg: 'bg-muted/40',       text: 'text-muted-foreground', desc: 'Below all thresholds · Base seconds' },
                    MANUAL:   { label: 'Manual',         icon: '🎛', bg: 'bg-violet-500/15',  text: 'text-violet-400', desc: 'User-fixed duration · Adaptive sizer bypassed' },
                  };
                  const meta = TIER_META[routingTier];
                  return (
                    <div className={`rounded-md border border-border/40 px-2.5 py-1.5 ${meta.bg}`}>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[11px]">{meta.icon}</span>
                          <span className={`text-[10px] font-bold tracking-wide ${meta.text}`}>{meta.label}</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className={`text-[11px] font-mono font-bold ${meta.text}`}>{adaptiveDuration.label}</span>
                          <span className="text-[9px] text-muted-foreground">·</span>
                          <span className="text-[9px] text-muted-foreground font-mono">{dynamicLookback}t window</span>
                        </div>
                      </div>
                      <p className="text-[8.5px] text-muted-foreground mt-0.5 leading-none">{meta.desc}</p>
                    </div>
                  );
                })()}

                {/* Zone 1: Entry Engine */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between px-0.5">
                    <p className="text-[9px] font-semibold text-muted-foreground uppercase tracking-widest">Entry Engine</p>
                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                      aligned
                        ? direction === 'CALL' ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400'
                                                : 'bg-rose-500/20 text-rose-500'
                        : 'bg-muted text-muted-foreground'
                    }`}>
                      {callCount}/3 RISE · {putCount}/3 FALL
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-1">
                    {([
                      { label: 'MACRO', vote: macroVote },
                      { label: 'MICRO', vote: microVote },
                      { label: 'ACCEL', vote: accelVote },
                    ] as const).map(({ label, vote }) => (
                      <div key={label} className={`rounded border px-2 py-2 text-center ${voteColor(vote)}`}>
                        <p className="text-[9px] font-medium uppercase tracking-wider opacity-70 mb-0.5">{label}</p>
                        <p className="text-[11px] font-bold">{voteLabel(vote)}</p>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Zone 2: Suppression Gates */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between px-0.5">
                    <p className="text-[9px] font-semibold text-muted-foreground uppercase tracking-widest">Suppression Gates</p>
                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                      anyVeto ? 'bg-amber-500/20 text-amber-600 dark:text-amber-400' : 'bg-muted/60 text-muted-foreground'
                    }`}>
                      {anyVeto ? 'VETO ACTIVE' : 'ALL CLEAR'}
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-1">
                    {gateStates ? ([
                      {
                        label: 'R-TICK',
                        state: gateStates.exhaustion,
                        value: indicators.rTickValue !== null ? indicators.rTickValue.toFixed(2) : null,
                        hint: 'exhaustion',
                      },
                      {
                        label: 'Z-SCORE',
                        state: gateStates.volatility,
                        value: indicators.zScoreValue !== null ? indicators.zScoreValue.toFixed(2) : null,
                        hint: 'extremes',
                      },
                      {
                        label: 'NOISE',
                        state: gateStates.noise,
                        value: indicators.erValue !== null ? indicators.erValue.toFixed(2) : null,
                        hint: 'ER chop',
                      },
                    ] as const).map(({ label, state, value, hint }) => (
                      <div key={label} className={`rounded border px-2 py-1.5 text-center ${
                        state === 'VETO'
                          ? 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                          : 'border-border/40 bg-muted/30 text-muted-foreground'
                      }`}>
                        <p className="text-[9px] font-medium uppercase tracking-wider opacity-70">{label}</p>
                        {value !== null && <p className="text-[10px] font-bold tabular-nums leading-tight">{value}</p>}
                        <p className={`text-[8px] font-semibold leading-tight ${state === 'VETO' ? 'opacity-100' : 'opacity-50'}`}>{state}</p>
                      </div>
                    )) : null}
                  </div>
                </div>

                {/* Signal outcome */}
                <div className={`rounded-md px-2.5 py-1.5 flex items-center justify-between ${
                  signalReady && direction === 'CALL' ? 'bg-emerald-500/10 border border-emerald-500/20'
                  : signalReady && direction === 'PUT' ? 'bg-rose-500/10 border border-rose-500/20'
                  : 'bg-muted/30 border border-border/40'
                }`}>
                  <span className="text-[10px] text-muted-foreground font-medium">Signal Status</span>
                  <span className={`text-[10px] font-bold ${
                    signalReady
                      ? direction === 'CALL' ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500'
                      : anyVeto && aligned ? 'text-amber-600 dark:text-amber-400'
                      : 'text-muted-foreground'
                  }`}>
                    {signalReady
                      ? `▶ EXECUTE ${direction}`
                      : anyVeto && aligned ? '⊘ SUPPRESSED'
                      : aligned ? '⊘ GATE VETO'
                      : `${Math.max(callCount, putCount)}/3 ALIGNED`}
                  </span>
                </div>

                {!isEnabled && (
                  <p className="text-[9px] text-muted-foreground px-0.5">
                    Enable the bot above to place trades on these signals.
                  </p>
                )}
              </div>
            );
          })()}

          {/* Last signal */}
          {isEnabled && signal && (
            <div className="flex items-center gap-2 px-1">
              <span className="text-xs text-muted-foreground">Last signal:</span>
              <Badge variant="outline" className={`text-xs font-semibold border-0 ${signal === 'CALL' ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-rose-500/15 text-rose-600 dark:text-rose-400'}`}>
                {signal === 'CALL' ? <TrendingUp className="h-3 w-3 mr-1" /> : <TrendingDown className="h-3 w-3 mr-1" />}
                {signal}
              </Badge>
            </div>
          )}

          {/* Live bot positions */}
          {botPositions.length > 0 && (
            <>
              <Separator />
              <div className="space-y-1.5">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide px-1">Open Bot Positions</p>
                <div className="space-y-1">
                  {botPositions.map(pos => {
                    const profit = parseFloat(pos.profit);
                    const isProfit = profit >= 0;
                    const payout = parseFloat(pos.payout);
                    const buyPrice = parseFloat(pos.buy_price);
                    const potProfit = payout - buyPrice;
                    const tpAt = (potProfit * config.takeProfitPct / 100).toFixed(2);
                    const slAt = (buyPrice * config.stopLossPct / 100).toFixed(2);
                    return (
                      <div key={pos.contract_id} className="rounded-md border border-border/50 bg-muted/20 px-2.5 py-2 flex items-center justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className={`text-[10px] font-bold px-1 py-0.5 rounded ${pos.contract_type.startsWith('CALL') ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' : 'bg-rose-500/15 text-rose-600 dark:text-rose-400'}`}>
                              {pos.contract_type.startsWith('CALL') ? '▲ RISE' : '▼ FALL'}
                            </span>
                            <span className="text-[10px] text-muted-foreground">#{pos.contract_id}</span>
                          </div>
                          {config.autoSell && (
                            <div className="text-[10px] text-muted-foreground mt-0.5 flex gap-2">
                              <span>Stake ${pos.buy_price}</span>
                              <span className="text-emerald-600">TP +${tpAt} ({config.takeProfitPct}%)</span>
                              <span className="text-rose-500">SL -${slAt} ({config.stopLossPct}%)</span>
                            </div>
                          )}
                          <LiveDuration pos={pos} />
                        </div>
                        <div className="text-right shrink-0">
                          <p className={`text-sm font-bold tabular-nums ${isProfit ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500'}`}>
                            {isProfit ? '+' : ''}{isNaN(profit) ? '—' : `$${profit.toFixed(2)}`}
                          </p>
                          <p className={`text-[9px] tabular-nums ${isProfit ? 'text-emerald-600/70' : 'text-rose-500/70'}`}>
                            {!isNaN(pos.profit_percentage) ? `${pos.profit_percentage >= 0 ? '+' : ''}${pos.profit_percentage.toFixed(1)}%` : ''}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          <Separator />

          {/* Signal engine config */}
          <div className="space-y-2.5">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide px-1">Signal Engine</p>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Base Stake ($)</Label>
                <NumberInput
                  value={config.stake}
                  onChange={v => setConfig({ stake: String(v) })}
                  min={0.35} step={0.5} disabled={isEnabled} className="h-8 text-sm"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Max Trades</Label>
                <NumberInput
                  value={config.maxTrades}
                  onChange={v => setConfig({ maxTrades: Math.floor(v) })}
                  min={1} max={200} step={1} disabled={isEnabled} className="h-8 text-sm"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Max Losses</Label>
                <NumberInput
                  value={config.maxConsecutiveLosses}
                  onChange={v => setConfig({ maxConsecutiveLosses: Math.floor(v) })}
                  min={1} max={20} step={1} disabled={isEnabled} className="h-8 text-sm"
                />
              </div>
              <div className="col-span-2 flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">Allow Equals (Rise≥ / Fall≤)</Label>
                <Switch checked={config.allowEquals} onCheckedChange={v => setConfig({ allowEquals: v })} disabled={isEnabled} />
              </div>
            </div>
          </div>

          <Separator />

          {/* Risk Engine — Strategy Pattern */}
          <div className="space-y-2.5">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide px-1 flex items-center gap-1.5">
              <RefreshCw className="h-3.5 w-3.5 text-primary" /> Risk Engine
            </p>

            {/* 4-tab selector */}
            <div className="flex rounded-md border border-border/60 overflow-hidden">
              {RISK_ENGINE_TABS.map(tab => (
                <button key={tab.value} type="button" disabled={isEnabled}
                  onClick={() => setConfig({ riskEngine: tab.value })}
                  className={`flex-1 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed
                    ${config.riskEngine === tab.value ? tab.activeClass : 'text-muted-foreground hover:bg-muted/50'}`}>
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Live stake indicator — shown when bot active and engine is on */}
            {isRiskEngineActive && isEnabled && (
              <div className={`rounded-md px-3 py-2 border flex items-center justify-between ${stakeMultiplied ? 'border-orange-500/40 bg-orange-500/5' : 'border-border/50 bg-muted/20'}`}>
                <div>
                  <p className="text-[10px] text-muted-foreground">Current Stake</p>
                  <p className={`text-sm font-bold tabular-nums ${stakeMultiplied ? 'text-orange-600 dark:text-orange-400' : ''}`}>${liveStake.toFixed(2)}</p>
                </div>
                <div className="text-right">
                  <p className="text-[10px] text-muted-foreground">Base</p>
                  <p className="text-xs text-muted-foreground tabular-nums">${baseStake.toFixed(2)}</p>
                </div>
              </div>
            )}

            {/* ── Engine 1: Martingale ─────────────────────────────────────── */}
            {config.riskEngine === 'MARTINGALE' && (
              <div className="rounded-md border border-rose-500/40 bg-rose-500/5 px-3 py-2.5 space-y-2.5">
                <div className="flex items-center gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5 text-rose-500 shrink-0" />
                  <p className="text-[10px] font-bold text-rose-500 uppercase tracking-wide">Recovery Mode — High Risk</p>
                </div>
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  Doubles down after every loss. Recovers quickly in trending markets but is <span className="font-semibold text-rose-400">mathematically guaranteed to liquidate your account</span> during extended ranging conditions.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Multiplier (×)</Label>
                    <NumberInput value={config.stakeMultiplier} onChange={v => setConfig({ stakeMultiplier: v })}
                      min={1.1} max={5} step={0.1} disabled={isEnabled} className="h-8 text-sm" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Max Stake ($)</Label>
                    <NumberInput value={config.maxStakeAmount} onChange={v => setConfig({ maxStakeAmount: v })}
                      min={1} step={1} disabled={isEnabled} className="h-8 text-sm" />
                  </div>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Loss → stake ×{config.stakeMultiplier} · Win → reset to ${config.stake}
                </p>
              </div>
            )}

            {/* ── Engine 2: Anti-Martingale ────────────────────────────────── */}
            {config.riskEngine === 'ANTI_MARTINGALE' && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2.5 space-y-2.5">
                <div className="flex items-center gap-1.5">
                  <Zap className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                  <p className="text-[10px] font-bold text-amber-600 dark:text-amber-400 uppercase tracking-wide">Streak Compounding — Moderate Risk</p>
                </div>
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  Compounds profits during winning streaks. One loss resets stake to base. <span className="font-semibold text-amber-500">Max Stake cap is your only protection</span> against giving back streak gains.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Multiplier (×)</Label>
                    <NumberInput value={config.stakeMultiplier} onChange={v => setConfig({ stakeMultiplier: v })}
                      min={1.1} max={5} step={0.1} disabled={isEnabled} className="h-8 text-sm" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Max Stake ($)</Label>
                    <NumberInput value={config.maxStakeAmount} onChange={v => setConfig({ maxStakeAmount: v })}
                      min={1} step={1} disabled={isEnabled} className="h-8 text-sm" />
                  </div>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Win → stake ×{config.stakeMultiplier} · Loss → reset to ${config.stake}
                </p>
                {isEnabled && (
                  <div className="flex items-center gap-2 text-[10px]">
                    <span className="text-muted-foreground">Win streak:</span>
                    <span className={`font-bold tabular-nums ${stats.consecutiveWins > 0 ? 'text-amber-500' : 'text-muted-foreground'}`}>
                      {stats.consecutiveWins}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* ── Engine 3: Confidence-Weighted Dynamic Sizing ─────────────── */}
            {config.riskEngine === 'CONFIDENCE' && (
              <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 px-3 py-2.5 space-y-2.5">
                <div className="flex items-center gap-1.5">
                  <Sparkles className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                  <p className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-wide">Dynamic Sizing</p>
                  <span className="ml-auto text-[9px] bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 px-1.5 py-0.5 rounded font-bold">✦ Recommended</span>
                </div>
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  Sizes risk dynamically from Base→Max using live market microstructure. Scales up during clean breakouts (high ER), pulls back near mean-reversion extremes (high |Z-Score|).
                </p>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Max Stake ($)</Label>
                  <NumberInput value={config.maxStakeAmount} onChange={v => setConfig({ maxStakeAmount: v })}
                    min={baseStake} step={1} disabled={isEnabled} className="h-8 text-sm" />
                </div>
                <div className="rounded-md bg-muted/30 px-2.5 py-2 space-y-1 text-[10px] text-muted-foreground">
                  <div className="flex justify-between">
                    <span>ER ≥ 0.80 + Z = 0.0</span>
                    <span className="font-medium text-emerald-600 dark:text-emerald-400">→ ${config.maxStakeAmount} (full cap)</span>
                  </div>
                  <div className="flex justify-between">
                    <span>ER &lt; 0.40 or |Z| ≥ 2.5</span>
                    <span className="font-medium">→ ${config.stake} (base only)</span>
                  </div>
                  {isEnabled && efficiencyRatio !== null && (
                    <div className="flex justify-between pt-1 border-t border-border/40">
                      <span>Live ER {efficiencyRatio.toFixed(2)}</span>
                      <span className="font-bold tabular-nums text-emerald-600 dark:text-emerald-400">${liveStake.toFixed(2)} active</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          <Separator />

          {/* Auto-Sell — percentage based */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between px-1">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                <ShieldCheck className="h-3.5 w-3.5 text-primary" /> Auto-Sell
              </p>
              <Switch checked={config.autoSell} onCheckedChange={v => setConfig({ autoSell: v })} disabled={isEnabled} />
            </div>

            {config.autoSell && (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground flex items-center gap-1">
                      <Target className="h-3 w-3 text-emerald-600" /> Take Profit
                    </Label>
                    <NumberInput
                      value={config.takeProfitPct}
                      onChange={v => setConfig({ takeProfitPct: v })}
                      min={1} max={99} step={5}
                      disabled={isEnabled}
                      className="h-8 text-sm border-emerald-500/30"
                      suffix="%"
                    />
                    <p className="text-[9px] text-muted-foreground">
                      ≈ +${estTPDollar} on ${baseStake.toFixed(2)} stake
                    </p>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground flex items-center gap-1">
                      <ShieldCheck className="h-3 w-3 text-rose-500" /> Stop Loss
                    </Label>
                    <NumberInput
                      value={config.stopLossPct}
                      onChange={v => setConfig({ stopLossPct: v })}
                      min={1} max={100} step={5}
                      disabled={isEnabled}
                      className="h-8 text-sm border-rose-500/30"
                      suffix="%"
                    />
                    <p className="text-[9px] text-muted-foreground">
                      ≈ -${estSLDollar} on ${baseStake.toFixed(2)} stake
                    </p>
                  </div>
                </div>
                <div className="rounded-md bg-muted/30 px-2.5 py-2 text-[10px] text-muted-foreground space-y-0.5">
                  <p className="font-medium text-foreground/70">Dynamic — scales with your stake</p>
                  <p>TP: sell when profit ≥ <span className="text-emerald-600">{config.takeProfitPct}%</span> of potential gain</p>
                  <p>SL: sell when loss ≥ <span className="text-rose-500">{config.stopLossPct}%</span> of stake paid</p>
                </div>
              </>
            )}
            {!config.autoSell && (
              <p className="text-[10px] text-muted-foreground px-0.5">Contracts will expire naturally at market close.</p>
            )}
          </div>

          <Separator />

          {/* Signal Gates */}
          <Collapsible>
            <CollapsibleTrigger asChild>
              <button className="flex w-full items-center justify-between px-1 group">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                  <SlidersHorizontal className="h-3.5 w-3.5 text-primary" /> Signal Gates
                </p>
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-3 pt-2">

              {/* Consensus Mode selector */}
              <div className="space-y-2 px-1">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <p className="text-xs font-medium">Consensus Mode</p>
                      {activeMarketMeta && (
                        <span className={`inline-flex items-center gap-0.5 text-[9px] font-semibold px-1.5 py-0.5 rounded border ${activeMarketMeta.color}`}>
                          {activeMarketMeta.icon} {activeMarketMeta.label}
                          {activeMarketProfile && <span className="opacity-60 ml-0.5">· Profile</span>}
                        </span>
                      )}
                    </div>
                    <p className="text-[10px] text-muted-foreground">
                      Trade quality vs frequency
                      {efficiencyRatio !== null && (
                        <span className="ml-1">
                          · <span className={`font-semibold ${efficiencyRatio >= 0.65 ? 'text-emerald-600 dark:text-emerald-400' : efficiencyRatio < 0.45 ? 'text-rose-500' : 'text-blue-500'}`}>
                            ER {efficiencyRatio.toFixed(2)}
                          </span>
                        </span>
                      )}
                    </p>
                  </div>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${consensusModes.find(m => m.value === effectiveMode)?.activeClass ?? ''}`}>
                    {activeVotes}/3 Entry Engine
                  </span>
                </div>
                <div className="grid grid-cols-4 gap-1">
                  {consensusModes.map(m => (
                    <button key={m.value} type="button" disabled={isEnabled}
                      onClick={() => setConfig({ consensusMode: m.value })}
                      className={`py-2 rounded text-[11px] font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex flex-col items-center gap-0.5
                        ${config.consensusMode === m.value ? m.activeClass : 'border border-border/50 text-muted-foreground hover:bg-muted/50'}`}>
                      <span>{m.label}</span>
                      <span className="text-[9px] opacity-70 font-normal">{m.gates}</span>
                    </button>
                  ))}
                </div>
                <p className="text-[9px] text-muted-foreground">
                  {consensusModes.find(m => m.value === config.consensusMode)?.desc}
                </p>
              </div>

              {/* ── Duration Chooser ── */}
              <div className="space-y-2 px-1">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs font-medium">Duration Mode</p>
                    <p className="text-[10px] text-muted-foreground">Auto = adaptive sizer · Manual = fixed</p>
                  </div>
                  <div className="flex rounded-md overflow-hidden border border-border/50">
                    {(['AUTO', 'MANUAL'] as const).map(m => (
                      <button key={m} type="button" disabled={isEnabled}
                        onClick={() => setConfig({ durationMode: m })}
                        className={`px-3 py-1 text-[11px] font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed
                          ${config.durationMode === m
                            ? m === 'AUTO'
                              ? 'bg-emerald-500/20 text-emerald-400 border-r border-border/50'
                              : 'bg-violet-500/20 text-violet-400'
                            : 'text-muted-foreground hover:bg-muted/50 border-r border-border/50 last:border-r-0'
                          }`}>
                        {m}
                      </button>
                    ))}
                  </div>
                </div>

                {config.durationMode === 'MANUAL' && (() => {
                  const UNIT_LABELS: Record<'t' | 's' | 'm', string> = { t: 'Ticks', s: 'Seconds', m: 'Minutes' };
                  const activeOpt = durationOptions.find(o => o.unit === config.manualDurationUnit);
                  const availableUnits = durationOptions
                    .filter(o => o.unit === 't' || o.unit === 's' || o.unit === 'm')
                    .map(o => o.unit as 't' | 's' | 'm');
                  return (
                    <div className="space-y-2 rounded-md border border-violet-500/20 bg-violet-500/5 px-2.5 py-2">
                      {/* Unit selector */}
                      <div className="space-y-1">
                        <p className="text-[9px] font-semibold text-muted-foreground uppercase tracking-widest">Unit</p>
                        <div className="flex gap-1">
                          {(['t', 's', 'm'] as const).map(u => {
                            const available = availableUnits.includes(u);
                            return (
                              <button key={u} type="button"
                                disabled={isEnabled || !available}
                                onClick={() => setConfig({ manualDurationUnit: u, manualDurationValue: durationOptions.find(o => o.unit === u)?.min ?? 5 })}
                                className={`flex-1 py-1.5 rounded text-[11px] font-semibold transition-colors
                                  disabled:opacity-40 disabled:cursor-not-allowed
                                  ${config.manualDurationUnit === u && available
                                    ? 'bg-violet-500/25 text-violet-300 border border-violet-500/40'
                                    : 'border border-border/50 text-muted-foreground hover:bg-muted/50'
                                  }`}>
                                {UNIT_LABELS[u]}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {/* Value input */}
                      <div className="space-y-1">
                        <div className="flex items-center justify-between">
                          <p className="text-[9px] font-semibold text-muted-foreground uppercase tracking-widest">Value</p>
                          {activeOpt && (
                            <p className="text-[9px] text-muted-foreground font-mono">
                              min {activeOpt.min} · max {activeOpt.max}
                            </p>
                          )}
                        </div>
                        <NumberInput
                          value={config.manualDurationValue}
                          onChange={v => setConfig({ manualDurationValue: v })}
                          min={activeOpt?.min ?? 1}
                          max={activeOpt?.max ?? 60}
                          step={1}
                          disabled={isEnabled}
                          className="h-8 text-sm w-full"
                          suffix={config.manualDurationUnit}
                        />
                      </div>

                      <p className="text-[9px] text-violet-400/70 leading-tight">
                        4× gate lookback still scales with this duration. Adaptive sizer is paused.
                      </p>
                    </div>
                  );
                })()}
              </div>

              {/* Suppression log rate */}
              <div className="flex items-center justify-between gap-2 px-1">
                <div>
                  <p className="text-xs font-medium">Log Suppressed Signals</p>
                  <p className="text-[10px] text-muted-foreground">% of suppression events to show in log</p>
                </div>
                <NumberInput
                  value={config.suppressionLogRate}
                  onChange={v => setConfig({ suppressionLogRate: v })}
                  min={0} max={100} step={10}
                  disabled={isEnabled}
                  className="h-7 w-20 text-sm"
                  suffix="%"
                />
              </div>

              {/* Mode-controlled gates (read-only — set by Consensus Mode) */}
              <div className="space-y-1.5 px-1">
                <p className="text-[10px] font-medium text-muted-foreground">Mode-Controlled Gates</p>
                <div className="rounded-md border border-border/50 divide-y divide-border/40">
                  {([
                    { key: 'NOISE'            as GateType, label: 'Noise Gate',    desc: 'Min Efficiency Ratio required to trade'       },
                    { key: 'EXHAUSTION'       as GateType, label: 'Exhaustion',    desc: 'Block entry when R-Tick signals directional exhaustion' },
                    { key: 'VOLATILITY_ZSCORE' as GateType, label: 'Z-Score Cap', desc: 'Block entry when price is too far from mean' },
                  ]).map(({ key, label, desc }) => {
                    const gate: GateOverride = config.gates[key] ?? { enabled: true, threshold: 0 };
                    return (
                      <div key={key} className="flex items-center gap-2 px-2.5 py-1.5">
                        <div className={`w-1.5 h-1.5 rounded-full ${gate.enabled ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`} />
                        <div className="flex-1 min-w-0">
                          <p className="text-[11px] font-medium leading-tight">{label}</p>
                          <p className="text-[9px] text-muted-foreground leading-tight truncate">{desc}</p>
                        </div>
                        <span className={`text-[9px] px-1 py-0.5 rounded font-mono ${
                          gateStates?.[key === 'NOISE' ? 'noise' : key === 'EXHAUSTION' ? 'exhaustion' : 'volatility'] === 'VETO'
                            ? 'bg-amber-500/20 text-amber-600'
                            : 'bg-muted/60 text-muted-foreground'
                        }`}>
                          {gateStates?.[key === 'NOISE' ? 'noise' : key === 'EXHAUSTION' ? 'exhaustion' : 'volatility'] ?? '—'}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <p className="text-[9px] text-muted-foreground">Thresholds set automatically by Consensus Mode.</p>
              </div>

              {/* User-toggleable gates */}
              <div className="space-y-1.5 px-1">
                <p className="text-[10px] font-medium text-muted-foreground">Manual Gates</p>
                <div className="rounded-md border border-border/50 divide-y divide-border/40">
                  {([
                    { key: 'MARTINGALE' as GateType, label: 'Loss Streak', desc: 'Block after N consecutive losses', showT: true, step: 1, min: 1, max: 20 },
                  ] as Array<{ key: GateType; label: string; desc: string; showT: boolean; step: number; min: number; max: number; }>
                  ).map(({ key, label, desc, showT, step, min, max }) => {
                    const gate: GateOverride = config.gates[key] ?? { enabled: false, threshold: 0 };
                    return (
                      <div key={key} className="flex items-center gap-2 px-2.5 py-1.5">
                        <Switch
                          checked={gate.enabled}
                          disabled={isEnabled}
                          onCheckedChange={v =>
                            setConfig({ gates: { ...config.gates, [key]: { ...gate, enabled: v } } })
                          }
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-[11px] font-medium leading-tight">{label}</p>
                          <p className="text-[9px] text-muted-foreground leading-tight truncate">{desc}</p>
                        </div>
                        {showT && (
                          <NumberInput
                            value={gate.threshold}
                            onChange={v =>
                              setConfig({ gates: { ...config.gates, [key]: { ...gate, threshold: v } } })
                            }
                            min={min} max={max} step={step}
                            disabled={isEnabled || !gate.enabled}
                            className="h-6 w-20 text-[11px]"
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              <p className="text-[9px] text-muted-foreground px-1">
                Settings persist across sessions. Disabled gates are skipped entirely.
              </p>
            </CollapsibleContent>
          </Collapsible>

          <Separator />

          {/* Session P&L tracker */}
          {(pnlHistory.length > 0 || isEnabled) && (
            <div className="space-y-1.5">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide px-1">Session P&amp;L</p>
              <div className="rounded-md border border-border/50 bg-muted/20 px-3 py-2 flex items-center justify-between gap-3">
                <div>
                  <p className={`text-xl font-bold tabular-nums leading-tight ${sessionPnl > 0 ? 'text-emerald-600 dark:text-emerald-400' : sessionPnl < 0 ? 'text-rose-500' : 'text-muted-foreground'}`}>
                    {sessionPnl > 0 ? '+' : ''}{sessionPnl === 0 ? '$0.00' : `$${Math.abs(sessionPnl).toFixed(2)}`}
                    {sessionPnl < 0 && <span className="text-rose-500"> loss</span>}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {pnlHistory.length} trade{pnlHistory.length !== 1 ? 's' : ''} closed
                    {pnlHistory.length > 0 && ` · last ${pnlHistory[pnlHistory.length - 1].pnl >= 0 ? '+' : ''}$${pnlHistory[pnlHistory.length - 1].pnl.toFixed(2)}`}
                  </p>
                </div>
                {pnlHistory.length >= 2 && <PnlSparkline history={pnlHistory} />}
                {pnlHistory.length < 2 && (
                  <span className="text-[9px] text-muted-foreground italic">chart after 2 trades</span>
                )}
              </div>
            </div>
          )}

          {(pnlHistory.length > 0 || isEnabled) && <Separator />}

          {/* Stats */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide px-1">Session Stats</p>
            <div className="grid grid-cols-4 gap-1 text-center">
              <StatTile label="Trades" value={String(stats.totalTrades)} />
              <StatTile label="Wins" value={String(stats.wins)} color="text-emerald-600 dark:text-emerald-400" />
              <StatTile label="Losses" value={String(stats.losses)} color="text-rose-500" />
              <StatTile label="Auto-Sell" value={String(stats.autoSells)} color="text-blue-500 dark:text-blue-400" />
            </div>
            <div className="flex justify-between px-1 text-xs text-muted-foreground">
              <span>Consecutive losses</span>
              <span className={stats.consecutiveLosses >= config.maxConsecutiveLosses - 1 ? 'text-destructive font-semibold' : ''}>
                {stats.consecutiveLosses} / {config.maxConsecutiveLosses}
              </span>
            </div>
            <div className="flex justify-between px-1 text-xs text-muted-foreground">
              <span>Trades used</span>
              <span>{stats.totalTrades} / {config.maxTrades}</span>
            </div>
          </div>

          <Separator />

          {/* Signal Telemetry */}
          {(signalHistory.length > 0 || isEnabled) && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide px-1 flex items-center gap-1.5">
                <Activity className="h-3.5 w-3.5 text-primary" /> Signal Telemetry
                {signalHistory.length > 0 && (
                  <span className="ml-auto text-[9px] bg-muted px-1.5 py-0.5 rounded tabular-nums">
                    {signalHistory.length} signal{signalHistory.length !== 1 ? 's' : ''}
                  </span>
                )}
              </p>
              <SignalHistoryPanel records={signalHistory} />
            </div>
          )}

          {(signalHistory.length > 0 || isEnabled) && <Separator />}

          {/* Activity log */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between px-1">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                <Activity className="h-3 w-3" /> Activity Log
              </p>
              {log.length > 0 && (
                <Button variant="ghost" size="sm" className="h-5 text-[10px] px-1.5 text-muted-foreground"
                  onClick={() => autotrade.setConfig({})}>
                  Clear
                </Button>
              )}
            </div>
            <ScrollArea className="h-36 rounded-md border border-border/50 bg-muted/20 p-2">
              {log.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-4">
                  {isConnected ? (hasLiveData ? 'Enable the bot to place trades.' : 'Collecting tick data…') : 'Connect to see live signals.'}
                </p>
              ) : (
                <div className="space-y-0.5">
                  {log.map(entry => (
                    <div key={entry.id} className="flex gap-1.5 text-[11px] leading-5 items-baseline">
                      <span className="text-muted-foreground/60 shrink-0 tabular-nums">{entry.time}</span>
                      {(entry.type === 'win' || entry.type === 'loss') ? (
                        <span className="flex items-baseline gap-1.5 min-w-0">
                          <span className={`shrink-0 inline-flex items-center rounded px-1.5 py-px text-[10px] font-bold tracking-wide leading-none
                            ${entry.type === 'win'
                              ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400'
                              : 'bg-destructive/15 text-destructive'}`}>
                            {entry.type === 'win' ? '✓ WIN' : '✗ LOSS'}
                          </span>
                          <span className={`truncate ${LOG_COLORS[entry.type]}`}>{entry.message}</span>
                        </span>
                      ) : (
                        <span className={`${LOG_COLORS[entry.type]} min-w-0 break-words`}>{entry.message}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </div>

        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function VoteBadge({ label, vote }: { label: string; vote: IndicatorVote }) {
  return (
    <div className={`flex items-center justify-between rounded border px-2 py-1 text-[11px] font-medium ${voteColor(vote)}`}>
      <span className="text-muted-foreground font-normal">{label}</span>
      <span>{voteLabel(vote)}</span>
    </div>
  );
}
function IndicatorTile({ label, value, sub, highlight }: { label: string; value: string; sub?: string; highlight?: boolean }) {
  return (
    <div className="rounded-md border border-border/50 bg-muted/30 px-2 py-1.5 text-center">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className={`text-sm font-semibold tabular-nums ${highlight ? 'text-yellow-600 dark:text-yellow-400' : ''}`}>{value}</p>
      {sub && <p className="text-[9px] text-muted-foreground">{sub}</p>}
    </div>
  );
}
function StatTile({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-md border border-border/50 bg-muted/30 px-2 py-1.5 text-center">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className={`text-sm font-bold tabular-nums ${color ?? ''}`}>{value}</p>
    </div>
  );
}