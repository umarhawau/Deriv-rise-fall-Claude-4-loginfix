import { NextRequest, NextResponse } from 'next/server';
import { db } from '@workspace/db';
import { suppressionLogsTable } from '@workspace/db/schema';
import { sql, gte, and, eq } from 'drizzle-orm';

const NO_CACHE = { 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache' };

// POST — record one suppression event
export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { symbol?: string; direction?: string };
    const { symbol, direction } = body;
    if (!symbol || !direction) {
      return NextResponse.json({ error: 'symbol and direction required' }, { status: 400, headers: NO_CACHE });
    }
    if (!['CALL', 'PUT', 'ALL'].includes(direction)) {
      return NextResponse.json({ error: 'direction must be CALL, PUT, or ALL' }, { status: 400, headers: NO_CACHE });
    }
    await db.insert(suppressionLogsTable).values({
      symbol,
      direction: direction as 'CALL' | 'PUT' | 'ALL',
      suppressedAt: new Date(),
    });
    return NextResponse.json({ ok: true }, { headers: NO_CACHE });
  } catch {
    return NextResponse.json({ error: 'Failed to log suppression' }, { status: 500, headers: NO_CACHE });
  }
}

// GET — return today's suppression counts per symbol + direction
export async function GET() {
  try {
    const todayUtc = new Date();
    todayUtc.setUTCHours(0, 0, 0, 0);

    const rows = await db
      .select({
        symbol:    suppressionLogsTable.symbol,
        direction: suppressionLogsTable.direction,
        count:     sql<number>`COUNT(*)`.mapWith(Number),
      })
      .from(suppressionLogsTable)
      .where(gte(suppressionLogsTable.suppressedAt, todayUtc))
      .groupBy(suppressionLogsTable.symbol, suppressionLogsTable.direction);

    return NextResponse.json(rows, { headers: NO_CACHE });
  } catch {
    return NextResponse.json([], { headers: NO_CACHE });
  }
}
