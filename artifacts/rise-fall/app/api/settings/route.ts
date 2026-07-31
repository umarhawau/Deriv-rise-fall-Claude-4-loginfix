import { NextRequest, NextResponse } from 'next/server';
import { db } from '@workspace/db';
import { systemSettingsTable } from '@workspace/db/schema';
import { processSettingsBody, SETTINGS_DEFAULTS } from '@workspace/settings';

const NO_CACHE = { 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache' };

export async function GET() {
  try {
    const rows = await db.select().from(systemSettingsTable).limit(1);
    if (rows.length === 0) return NextResponse.json(SETTINGS_DEFAULTS, { headers: NO_CACHE });
    return NextResponse.json({ ...SETTINGS_DEFAULTS, ...rows[0] }, { headers: NO_CACHE });
  } catch {
    return NextResponse.json(SETTINGS_DEFAULTS, { headers: NO_CACHE });
  }
}

export async function PATCH(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: NO_CACHE });
  }

  const result = processSettingsBody(body);
  if (!result.ok)
    return NextResponse.json({ error: result.error }, { status: result.status, headers: NO_CACHE });

  const { updates } = result;

  try {
    await db
      .insert(systemSettingsTable)
      .values({ id: 1, ...updates } as typeof systemSettingsTable.$inferInsert)
      .onConflictDoUpdate({ target: systemSettingsTable.id, set: updates });

    const [row] = await db.select().from(systemSettingsTable).limit(1);
    return NextResponse.json({ ...SETTINGS_DEFAULTS, ...(row ?? {}), ...updates }, { headers: NO_CACHE });
  } catch {
    return NextResponse.json({ error: 'Failed to update settings' }, { status: 500, headers: NO_CACHE });
  }
}
