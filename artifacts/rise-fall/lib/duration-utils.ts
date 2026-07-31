import type { ContractInfo } from '@deriv/core';
import { SNIPER_STRIKE, MOMENTUM_RIDE } from './trading-config';

export type DurationApiUnit = 't' | 's' | 'm' | 'd';
export type DurationSelectUnit = 't' | 's' | 'm' | 'h' | 'd' | 'end-time';

export interface DurationOption {
  unit: DurationSelectUnit;
  label: string;
  min: number;
  max: number;
}

export interface TradingEvent {
  dates: string;
  descrip: string;
}

export interface TradingSymbolData {
  underlying_symbol: string;
  name: string;
  times: {
    open: string[];
    close: string[];
  };
  trading_days: string[];
  events: TradingEvent[];
}

const DURATION_ORDER: DurationSelectUnit[] = ['t', 's', 'm', 'h', 'd', 'end-time'];

const DURATION_LABELS: Record<DurationSelectUnit, string> = {
  t: 'Ticks',
  s: 'Seconds',
  m: 'Minutes',
  h: 'Hours',
  d: 'Days',
  'end-time': 'End Time',
};

function parseDurationToSeconds(durationStr: string): number {
  const num = parseInt(durationStr, 10);
  const unit = durationStr.replace(/^\d+/, '');
  switch (unit) {
    case 's': return num;
    case 'm': return num * 60;
    case 'h': return num * 3600;
    case 'd': return num * 86400;
    default: return num;
  }
}

export function getDurationOptions(contracts: ContractInfo[]): DurationOption[] {
  const optMap = new Map<DurationSelectUnit, DurationOption>();

  for (const contract of contracts) {
    const minStr = contract.min_contract_duration;
    const maxStr = contract.max_contract_duration;
    const expiryType = contract.expiry_type;

    if (expiryType === 'tick') {
      if (!optMap.has('t')) {
        optMap.set('t', { unit: 't', label: DURATION_LABELS.t, min: parseInt(minStr, 10), max: parseInt(maxStr, 10) });
      }
    } else if (expiryType === 'intraday') {
      const minSec = parseDurationToSeconds(minStr);
      const maxSec = parseDurationToSeconds(maxStr);

      if (maxSec >= 1 && !optMap.has('s')) {
        const sMin = Math.max(1, minSec);
        const sMax = Math.min(59, maxSec);
        if (sMin <= sMax) optMap.set('s', { unit: 's', label: DURATION_LABELS.s, min: sMin, max: sMax });
      }

      if (maxSec >= 60 && !optMap.has('m')) {
        const mMin = Math.max(1, Math.ceil(minSec / 60));
        const mMax = Math.floor(maxSec / 60);
        if (mMin <= mMax) optMap.set('m', { unit: 'm', label: DURATION_LABELS.m, min: mMin, max: mMax });
      }

      if (maxSec >= 3600 && !optMap.has('h')) {
        const hMin = Math.max(1, Math.ceil(minSec / 3600));
        const hMax = Math.floor(maxSec / 3600);
        if (hMin <= hMax) optMap.set('h', { unit: 'h', label: DURATION_LABELS.h, min: hMin, max: hMax });
      }
    } else if (expiryType === 'daily') {
      const dMin = parseInt(minStr, 10);
      const dMax = parseInt(maxStr, 10);
      if (!optMap.has('d')) optMap.set('d', { unit: 'd', label: DURATION_LABELS.d, min: dMin, max: dMax });
      if (!optMap.has('end-time')) optMap.set('end-time', { unit: 'end-time', label: DURATION_LABELS['end-time'], min: dMin, max: dMax });
    }
  }

  return DURATION_ORDER.reduce<DurationOption[]>((acc, u) => {
    const opt = optMap.get(u);
    if (opt) acc.push(opt);
    return acc;
  }, []);
}

export function computeEndTimeEpoch(date: Date | undefined, timeStr: string): number | null {
  if (!date || !timeStr) return null;
  const parts = timeStr.split(':');
  if (parts.length < 2) return null;
  const hours = parseInt(parts[0], 10);
  const mins = parseInt(parts[1], 10);
  if (isNaN(hours) || isNaN(mins)) return null;
  // timeStr is GMT — use local date components (calendar dates are at local midnight)
  // combined with UTC hours/mins to get the correct UTC epoch
  const secs = parts.length >= 3 ? (parseInt(parts[2], 10) || 0) : 0;
  const epochMs = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), hours, mins, secs, 0);
  const epochSec = Math.floor(epochMs / 1000);
  if (epochSec <= Math.floor(Date.now() / 1000)) return null;
  return epochSec;
}

export function parseTradingDays(tradingDays: string[]): number[] {
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const tradingSet = new Set<number>();
  for (const d of tradingDays) {
    const idx = dayMap[d];
    if (idx !== undefined) tradingSet.add(idx);
  }
  return [0, 1, 2, 3, 4, 5, 6].filter(d => !tradingSet.has(d));
}

export function getEarlyCloseDates(events: TradingEvent[], month: Date): Date[] {
  const year = month.getFullYear();
  const monthNum = month.getMonth();
  const result: Date[] = [];
  for (const event of events) {
    if (!event.descrip.toLowerCase().includes('closes early')) continue;
    for (const dateStr of event.dates.split(',').map(d => d.trim())) {
      // Parse as local midnight to match how Calendar creates date objects
      const parts = dateStr.split('-');
      if (parts.length !== 3) continue;
      const y = parseInt(parts[0], 10);
      const mo = parseInt(parts[1], 10) - 1;
      const day = parseInt(parts[2], 10);
      if (isNaN(y) || isNaN(mo) || isNaN(day)) continue;
      if (y === year && mo === monthNum) {
        result.push(new Date(y, mo, day));
      }
    }
  }
  return result;
}

export function parseCloseTime(closeArr: string[]): string {
  if (!closeArr || closeArr.length === 0) return '';
  const parts = closeArr[closeArr.length - 1].split(':');
  if (parts.length < 2) return '';
  const hh = parts[0].padStart(2, '0');
  const mm = parts[1].padStart(2, '0');
  const ss = (parts[2] ?? '00').padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function getCloseTimeForDate(data: TradingSymbolData, date: Date): string {
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayNamePlural = `${dayNames[date.getDay()]}s`;
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const dateStr = `${y}-${mo}-${d}`;

  for (const event of data.events) {
    if (!event.descrip.toLowerCase().includes('closes early')) continue;
    const applies = event.dates.split(',').map(s => s.trim()).some(s => s === dayNamePlural || s === dateStr);
    if (!applies) continue;
    const match = event.descrip.match(/\(at (\d{1,2}):(\d{2})\)/);
    if (match) return `${match[1].padStart(2, '0')}:${match[2]}:00`;
  }

  return parseCloseTime(data.times.close);
}

// ==========================================
// DYNAMIC DURATION SIZER
// ==========================================

export interface DurationResult {
  duration: number;
  unit: string;
}

export interface SniperStrikeParams {
  erFloor: number;
  erCeiling: number;
  accelMin: number;
  maxTicks: number;
}

export interface MomentumRideParams {
  erFloor: number;
  erMedium: number;
  erLow: number;
}

export function pickAdaptiveDuration(
  availableOptions: DurationOption[], 
  metrics: { acceleration: number | null; efficiencyRatio: number },
  dynamicParams?: { sniperStrike?: SniperStrikeParams; momentumRide?: MomentumRideParams }
): DurationResult {

  const { acceleration, efficiencyRatio } = metrics;
  const ss = dynamicParams?.sniperStrike ?? SNIPER_STRIKE;
  const mr = dynamicParams?.momentumRide ?? MOMENTUM_RIDE;
  // Treat null (insufficient data) as zero acceleration — never qualifies for Sniper tier.
  const absAccel = Math.abs(acceleration ?? 0);

  const tickOpt = availableOptions.find(opt => opt.unit === 't');
  const secOpt = availableOptions.find(opt => opt.unit === 's');
  const minOpt = availableOptions.find(opt => opt.unit === 'm');

  // 1. Sniper Strike — Physics-Based Dynamic Tick Interpolation
  //
  //  The ER encodes market velocity. A grinding trend (ER ~erFloor) needs more
  //  ticks for momentum to carry past the spread. A parabolic free-fall
  //  (ER ~erCeiling) must exit before the inevitable snap-back — fewer ticks.
  //
  //  Formula:
  //    parabolicIntensity = (ER - erFloor) / (erCeiling - erFloor)   → 0.0–1.0
  //    dynamicTicks = maxSniperTicks - intensity × (maxSniperTicks - apiMin)
  if (tickOpt && efficiencyRatio > ss.erFloor && absAccel > ss.accelMin) {
    const apiMin = tickOpt.min;
    const apiMax = tickOpt.max;
    const { erFloor, erCeiling, maxTicks } = ss;

    // Clamp ER into the valid Sniper range to guard against out-of-bounds math
    const safeER = Math.min(Math.max(efficiencyRatio, erFloor), erCeiling);

    // 0.0 = grinding trend, 1.0 = parabolic free-fall
    const parabolicIntensity = (safeER - erFloor) / (erCeiling - erFloor);

    // Respect the API's real tick ceiling, but never exceed the configured max
    const maxSniperTicks = Math.min(maxTicks, apiMax);

    // Invert the scale — higher intensity means fewer ticks
    const rawTicks = maxSniperTicks - parabolicIntensity * (maxSniperTicks - apiMin);

    // Round and clamp strictly within the API's allowed range
    const dynamicTicks = Math.min(maxSniperTicks, Math.max(apiMin, Math.round(rawTicks)));

    return { duration: dynamicTicks, unit: 't' };
  }

  // 2. Momentum Ride (Seconds scaled inversely to noise)
  if (secOpt && efficiencyRatio > mr.erFloor) {
      let multiplier = 1;
      
      // Give the trade more room to breathe if the trend is slightly noisy
      if (efficiencyRatio < mr.erMedium) multiplier = 2;
      if (efficiencyRatio < mr.erLow)    multiplier = 3;

      const targetDuration = secOpt.min * multiplier;

      // Failsafe: Never exceed the API's maximum allowed duration limit
      const safeDuration = Math.min(targetDuration, secOpt.max);
      
      return { duration: safeDuration, unit: 's' };
  }

  // 3. Macro Hold (Minutes)
  if (minOpt) {
      return { duration: minOpt.min, unit: 'm' };
  }

  // 4. Strict Abort — if the API provides no usable options, refuse to trade.
  // Returning ABORT is caught in the tick loop, which sets dur = null and
  // exits before any order is sent. This is structurally safer than a
  // hardcoded blind guess that fires a live trade with fake parameters.
  return { duration: 0, unit: 'ABORT' };
}
