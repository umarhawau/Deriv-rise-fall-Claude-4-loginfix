import { NextRequest, NextResponse } from 'next/server';
import { db } from '@workspace/db';
import { tradeLogsTable } from '@workspace/db/schema';
import { eq, and, ne } from 'drizzle-orm';
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit';

const NO_CACHE = { 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache' };

// Rate limits: trading endpoints are called frequently by the live UI but should
// still be bounded to prevent runaway loops or external abuse.
const GET_LIMIT  = { limit: 200, windowMs: 60 * 1000 }; // 200 reads/min per IP
const POST_LIMIT = { limit: 120, windowMs: 60 * 1000 }; // 120 writes/min per IP

// GET /api/trade-logs?accountId=&executionType=LIVE|GHOST
export async function GET(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`trade-logs-get:${ip}`, GET_LIMIT);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get('accountId');
  const executionType = searchParams.get('executionType');

  if (!accountId) {
    return NextResponse.json({ error: 'accountId query param is required' }, { status: 400, headers: NO_CACHE });
  }

  try {
    const conditions = [
      eq(tradeLogsTable.accountId, accountId),
      ne(tradeLogsTable.status, 'PENDING'),
    ];

    if (executionType === 'LIVE' || executionType === 'GHOST') {
      conditions.push(eq(tradeLogsTable.executionType, executionType));
    }

    const trades = await db
      .select()
      .from(tradeLogsTable)
      .where(and(...conditions))
      .orderBy(tradeLogsTable.createdAt);

    return NextResponse.json({ trades }, { headers: NO_CACHE });
  } catch {
    return NextResponse.json({ error: 'Failed to fetch trade logs' }, { status: 500, headers: NO_CACHE });
  }
}

// POST /api/trade-logs
export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`trade-logs-post:${ip}`, POST_LIMIT);
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  let body: {
    executionType?: string;
    direction?: string;
    symbol?: string;
    effectiveMode?: string;
    durationTarget?: number;
    durationUnit?: string;
    entryPrice?: string;
    noiseAtEntry?: string;
    zScoreAtEntry?: string;
    accountId?: string;
    erAtEntry?: string;
    accelerationAtEntry?: string;
    stake?: string;
  };

  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: NO_CACHE });
  }

  if (
    !body.executionType ||
    !body.direction ||
    !body.symbol ||
    !body.effectiveMode ||
    !body.durationTarget ||
    !body.durationUnit ||
    !body.entryPrice ||
    !body.noiseAtEntry ||
    !body.zScoreAtEntry
  ) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400, headers: NO_CACHE });
  }

  try {
    const [row] = await db
      .insert(tradeLogsTable)
      .values({
        accountId: body.accountId ?? 'unknown',
        executionType: body.executionType as 'LIVE' | 'GHOST',
        status: 'PENDING',
        direction: body.direction as 'CALL' | 'PUT',
        symbol: body.symbol,
        effectiveMode: body.effectiveMode as 'SNIPER' | 'BALANCED' | 'AGGRESSIVE',
        durationTarget: body.durationTarget,
        durationUnit: body.durationUnit as 't' | 's' | 'm',
        entryPrice: body.entryPrice,
        noiseAtEntry: body.noiseAtEntry,
        zScoreAtEntry: body.zScoreAtEntry,
        erAtEntry: body.erAtEntry ?? '0',
        accelerationAtEntry: body.accelerationAtEntry ?? '0',
        stake: body.stake ?? null,
      })
      .returning({ id: tradeLogsTable.id });

    return NextResponse.json({ ok: true, id: row!.id }, { headers: NO_CACHE });
  } catch {
    return NextResponse.json({ error: 'Failed to insert trade log' }, { status: 500, headers: NO_CACHE });
  }
}
