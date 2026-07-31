import { db } from '@workspace/db';
import { tradeLogsTable, systemSettingsTable } from '@workspace/db/schema';
import { desc, ne } from 'drizzle-orm';
import { AdminLoginForm } from '../quant/login-form';
import { isAdminAuthorized } from '../quant/admin-auth';
import { AdminNav } from '../admin-nav';
import { AutoRefresh } from '../auto-refresh';
import { SignalClient, type SignalRow, type ModeThresholds } from './signal-client';

export const dynamic = 'force-dynamic';

const FALLBACK_SETTINGS = {
  sniperCallErMin: 0, sniperPutErMin: 0.6,
  balancedCallErMin: 0.1, balancedPutErMin: 0.4,
  aggressiveCallErMin: 0.2, aggressivePutErMin: 0.3,
  sniperZMax: 1.5, balancedZMax: 2.0, aggressiveZMax: 2.5,
  sniperExhaustionCall: 0.75, sniperExhaustionPut: 0.25,
  balancedExhaustionCall: 0.80, balancedExhaustionPut: 0.20,
  aggressiveExhaustionCall: 0.90, aggressiveExhaustionPut: 0.10,
};

function n(v: string | number | null | undefined, fb = 0): number {
  if (v === null || v === undefined) return fb;
  const p = typeof v === 'number' ? v : parseFloat(v);
  return isNaN(p) ? fb : p;
}

export default async function SignalPage() {
  if (!await isAdminAuthorized()) return <AdminLoginForm />;

  // ── Load settings ──────────────────────────────────────────────────────────
  let s = FALLBACK_SETTINGS;
  try {
    const rows = await db.select().from(systemSettingsTable).limit(1);
    if (rows.length > 0) {
      const r = rows[0];
      s = {
        sniperCallErMin:          n(r.sniperCallErMin),
        sniperPutErMin:           n(r.sniperPutErMin),
        balancedCallErMin:        n(r.balancedCallErMin),
        balancedPutErMin:         n(r.balancedPutErMin),
        aggressiveCallErMin:      n(r.aggressiveCallErMin),
        aggressivePutErMin:       n(r.aggressivePutErMin),
        sniperZMax:               n(r.sniperZMax),
        balancedZMax:             n(r.balancedZMax),
        aggressiveZMax:           n(r.aggressiveZMax),
        sniperExhaustionCall:     n(r.sniperExhaustionCall),
        sniperExhaustionPut:      n(r.sniperExhaustionPut),
        balancedExhaustionCall:   n(r.balancedExhaustionCall),
        balancedExhaustionPut:    n(r.balancedExhaustionPut),
        aggressiveExhaustionCall: n(r.aggressiveExhaustionCall),
        aggressiveExhaustionPut:  n(r.aggressiveExhaustionPut),
      };
    }
  } catch { /* fallback */ }

  // Build mode threshold objects passed to client
  const thresholds: Record<string, ModeThresholds> = {
    SNIPER:     { erCall: s.sniperCallErMin,     erPut: s.sniperPutErMin,     zMax: s.sniperZMax,     exCall: s.sniperExhaustionCall,     exPut: s.sniperExhaustionPut     },
    BALANCED:   { erCall: s.balancedCallErMin,   erPut: s.balancedPutErMin,   zMax: s.balancedZMax,   exCall: s.balancedExhaustionCall,   exPut: s.balancedExhaustionPut   },
    AGGRESSIVE: { erCall: s.aggressiveCallErMin, erPut: s.aggressivePutErMin, zMax: s.aggressiveZMax, exCall: s.aggressiveExhaustionCall, exPut: s.aggressiveExhaustionPut },
  };

  // ── Load recent trades ─────────────────────────────────────────────────────
  let signals: SignalRow[] = [];
  try {
    const rows = await db
      .select({
        id:               tradeLogsTable.id,
        symbol:           tradeLogsTable.symbol,
        direction:        tradeLogsTable.direction,
        executionType:    tradeLogsTable.executionType,
        effectiveMode:    tradeLogsTable.effectiveMode,
        status:           tradeLogsTable.status,
        erAtEntry:        tradeLogsTable.erAtEntry,
        zScoreAtEntry:    tradeLogsTable.zScoreAtEntry,
        noiseAtEntry:     tradeLogsTable.noiseAtEntry,
        accelAtEntry:     tradeLogsTable.accelerationAtEntry,
        createdAt:        tradeLogsTable.createdAt,
      })
      .from(tradeLogsTable)
      .where(ne(tradeLogsTable.status, 'PENDING'))
      .orderBy(desc(tradeLogsTable.createdAt))
      .limit(300);

    signals = rows.map(r => {
      const mode = r.effectiveMode as 'SNIPER' | 'BALANCED' | 'AGGRESSIVE';
      const dir  = r.direction as 'CALL' | 'PUT';
      const t    = thresholds[mode];

      const er    = n(r.erAtEntry);
      const z     = Math.abs(n(r.zScoreAtEntry));
      const noise = n(r.noiseAtEntry);
      const accel = n(r.accelAtEntry);

      const erThresh = dir === 'CALL' ? t.erCall : t.erPut;
      const erPass   = er >= erThresh;
      const zPass    = z <= t.zMax;
      // Exhaustion: CALL passes if noise <= exCall; PUT passes if noise >= exPut
      const exThresh = dir === 'CALL' ? t.exCall : t.exPut;
      const exPass   = dir === 'CALL' ? noise <= t.exCall : noise >= t.exPut;

      return {
        id:            r.id,
        symbol:        r.symbol,
        direction:     dir,
        executionType: r.executionType as 'LIVE' | 'GHOST',
        effectiveMode: mode,
        status:        r.status as 'WIN' | 'LOSS' | 'PENDING',
        er, z, noise, accel,
        erThresh, erPass,
        zThresh: t.zMax, zPass,
        exThresh, exPass,
        createdAt: r.createdAt.toISOString(),
      };
    });
  } catch { /* signals stays empty */ }

  const totalTrades = signals.length;
  const passing3 = signals.filter(s => s.erPass && s.zPass && s.exPass).length;
  const erFails   = signals.filter(s => !s.erPass).length;
  const zFails    = signals.filter(s => !s.zPass).length;
  const exFails   = signals.filter(s => !s.exPass).length;

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white">
      <AutoRefresh intervalSeconds={30} />
      <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">

        <AdminNav />

        <div>
          <h1 className="text-lg font-bold text-white flex items-center gap-2">
            <span>🔬</span> Signal Gate Breakdown
          </h1>
          <p className="text-xs text-zinc-500 mt-0.5">
            Every resolved trade — ER gate · Z gate · Exhaustion gate · Signal strength vs live thresholds
          </p>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Trades Analysed',  value: totalTrades.toLocaleString(),  color: 'text-white' },
            { label: 'All 3 Gates Pass', value: passing3.toLocaleString(),      color: 'text-emerald-400' },
            { label: 'ER Gate Fails',    value: erFails.toLocaleString(),        color: 'text-rose-400',   sub: 'vs current thresholds' },
            { label: 'Z Gate Fails',     value: zFails.toLocaleString(),         color: 'text-amber-400',  sub: 'vs current thresholds' },
          ].map(c => (
            <div key={c.label} className="rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-3">
              <div className={`text-xl font-bold ${c.color}`}>{c.value}</div>
              <div className="text-[10px] text-zinc-500 mt-0.5">{c.label}</div>
              {c.sub && <div className="text-[9px] text-zinc-600 uppercase tracking-wide">{c.sub}</div>}
            </div>
          ))}
        </div>

        <SignalClient
          signals={signals}
          thresholds={thresholds}
          exFails={exFails}
        />

      </div>
    </div>
  );
}
