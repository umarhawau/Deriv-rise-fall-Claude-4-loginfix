import { NextRequest, NextResponse } from 'next/server';
import { db } from '@workspace/db';
import { tradeLogsTable } from '@workspace/db/schema';
import { eq } from 'drizzle-orm';

// PATCH /api/trade-logs/:id
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: idStr } = await params;
  const id = parseInt(idStr, 10);

  if (isNaN(id)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  let body: {
    exitPrice?: string;
    status?: string;
    pnl?: string;
    resolvedAt?: string;
  };

  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.exitPrice || !body.status) {
    return NextResponse.json({ error: 'exitPrice and status are required' }, { status: 400 });
  }

  try {
    await db
      .update(tradeLogsTable)
      .set({
        exitPrice: body.exitPrice,
        status: body.status as 'WIN' | 'LOSS',
        pnl: body.pnl ?? null,
        resolvedAt: body.resolvedAt ? new Date(body.resolvedAt) : new Date(),
      })
      .where(eq(tradeLogsTable.id, id));

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Failed to update trade log' }, { status: 500 });
  }
}
