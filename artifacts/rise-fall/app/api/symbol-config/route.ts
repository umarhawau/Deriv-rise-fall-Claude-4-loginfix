import { NextResponse } from 'next/server';
import { db } from '@workspace/db';
import { symbolConfigTable } from '@workspace/db/schema';

const NO_CACHE = { 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache' };

export async function GET() {
  try {
    const rows = await db.select().from(symbolConfigTable);
    return NextResponse.json(rows, { headers: NO_CACHE });
  } catch {
    return NextResponse.json([], { headers: NO_CACHE });
  }
}
