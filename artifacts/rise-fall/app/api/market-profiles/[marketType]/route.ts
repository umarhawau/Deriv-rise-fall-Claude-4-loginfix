import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@workspace/db';

const NO_CACHE = { 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache' };

type MarketType = 'synthetic' | 'forex' | 'metals' | 'bull_bear' | 'step';
const MARKET_TYPES: MarketType[] = ['synthetic', 'forex', 'metals', 'bull_bear', 'step'];

const PROFILE_DEFAULTS: Record<MarketType, {
  sniperCallErMin: string; sniperPutErMin: string; sniperZMax: string;
  balancedCallErMin: string; balancedPutErMin: string; balancedZMax: string;
  aggressiveCallErMin: string; aggressivePutErMin: string; aggressiveZMax: string;
}> = {
  synthetic: { sniperCallErMin: '0.0500', sniperPutErMin: '0.0500', sniperZMax: '1.50', balancedCallErMin: '0.0300', balancedPutErMin: '0.0300', balancedZMax: '1.80', aggressiveCallErMin: '0.0200', aggressivePutErMin: '0.0200', aggressiveZMax: '2.20' },
  forex:     { sniperCallErMin: '0.1000', sniperPutErMin: '0.1000', sniperZMax: '2.00', balancedCallErMin: '0.0700', balancedPutErMin: '0.0700', balancedZMax: '2.30', aggressiveCallErMin: '0.0500', aggressivePutErMin: '0.0500', aggressiveZMax: '2.70' },
  metals:    { sniperCallErMin: '0.1500', sniperPutErMin: '0.1500', sniperZMax: '2.20', balancedCallErMin: '0.1000', balancedPutErMin: '0.1000', balancedZMax: '2.50', aggressiveCallErMin: '0.0700', aggressivePutErMin: '0.0700', aggressiveZMax: '3.00' },
  bull_bear: { sniperCallErMin: '0.0500', sniperPutErMin: '0.2000', sniperZMax: '1.80', balancedCallErMin: '0.0300', balancedPutErMin: '0.1500', balancedZMax: '2.00', aggressiveCallErMin: '0.0200', aggressivePutErMin: '0.1000', aggressiveZMax: '2.30' },
  step:      { sniperCallErMin: '0.1500', sniperPutErMin: '0.2500', sniperZMax: '2.00', balancedCallErMin: '0.1000', balancedPutErMin: '0.1800', balancedZMax: '2.30', aggressiveCallErMin: '0.0700', aggressivePutErMin: '0.1200', aggressiveZMax: '2.70' },
};

const SELECT_COLS = `
  market_type           AS "marketType",
  sniper_call_er_min    AS "sniperCallErMin",
  sniper_put_er_min     AS "sniperPutErMin",
  sniper_z_max          AS "sniperZMax",
  balanced_call_er_min  AS "balancedCallErMin",
  balanced_put_er_min   AS "balancedPutErMin",
  balanced_z_max        AS "balancedZMax",
  aggressive_call_er_min AS "aggressiveCallErMin",
  aggressive_put_er_min  AS "aggressivePutErMin",
  aggressive_z_max       AS "aggressiveZMax",
  updated_at            AS "updatedAt"
`;

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ marketType: string }> }
) {
  const { marketType } = await params;

  if (!MARKET_TYPES.includes(marketType as MarketType)) {
    return NextResponse.json(
      { error: `Invalid market type. Must be one of: ${MARKET_TYPES.join(', ')}` },
      { status: 400, headers: NO_CACHE }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: NO_CACHE });
  }

  const setClauses: string[] = [];
  const values: (string | number)[] = [];

  const erFields: Array<[string, string]> = [
    ['sniperCallErMin', 'sniper_call_er_min'],
    ['sniperPutErMin', 'sniper_put_er_min'],
    ['balancedCallErMin', 'balanced_call_er_min'],
    ['balancedPutErMin', 'balanced_put_er_min'],
    ['aggressiveCallErMin', 'aggressive_call_er_min'],
    ['aggressivePutErMin', 'aggressive_put_er_min'],
  ];

  const zFields: Array<[string, string]> = [
    ['sniperZMax', 'sniper_z_max'],
    ['balancedZMax', 'balanced_z_max'],
    ['aggressiveZMax', 'aggressive_z_max'],
  ];

  for (const [camel, snake] of erFields) {
    if (body[camel] === undefined) continue;
    const n = Number(body[camel]);
    if (isNaN(n) || n < 0 || n > 1)
      return NextResponse.json({ error: `${camel} must be between 0 and 1` }, { status: 400, headers: NO_CACHE });
    values.push(n.toFixed(4));
    setClauses.push(`${snake} = $${values.length}`);
  }

  for (const [camel, snake] of zFields) {
    if (body[camel] === undefined) continue;
    const n = Number(body[camel]);
    if (isNaN(n) || n < 0.5 || n > 5)
      return NextResponse.json({ error: `${camel} must be between 0.5 and 5` }, { status: 400, headers: NO_CACHE });
    values.push(n.toFixed(2));
    setClauses.push(`${snake} = $${values.length}`);
  }

  if (setClauses.length === 0)
    return NextResponse.json({ error: 'No valid fields provided' }, { status: 400, headers: NO_CACHE });

  try {
    const mt = marketType as MarketType;
    const d = PROFILE_DEFAULTS[mt];

    await pool.query(
      `INSERT INTO market_profiles
         (market_type, sniper_call_er_min, sniper_put_er_min, sniper_z_max,
          balanced_call_er_min, balanced_put_er_min, balanced_z_max,
          aggressive_call_er_min, aggressive_put_er_min, aggressive_z_max)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT DO NOTHING`,
      [mt,
       d.sniperCallErMin, d.sniperPutErMin, d.sniperZMax,
       d.balancedCallErMin, d.balancedPutErMin, d.balancedZMax,
       d.aggressiveCallErMin, d.aggressivePutErMin, d.aggressiveZMax]
    );

    values.push(new Date().toISOString());
    setClauses.push(`updated_at = $${values.length}`);
    values.push(mt);
    const whereIdx = values.length;

    await pool.query(
      `UPDATE market_profiles SET ${setClauses.join(', ')} WHERE market_type = $${whereIdx}`,
      values
    );

    const result = await pool.query(
      `SELECT ${SELECT_COLS} FROM market_profiles WHERE market_type = $1`,
      [mt]
    );
    return NextResponse.json(result.rows[0] ?? { marketType: mt, ...d }, { headers: NO_CACHE });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to update market profile: ${msg}` }, { status: 500, headers: NO_CACHE });
  }
}
