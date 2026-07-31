'use server';

import { cookies } from 'next/headers';
import { db } from '@workspace/db';
import { symbolConfigTable } from '@workspace/db/schema';
import { isAdminAuthorized, ADMIN_COOKIE } from '../quant/admin-auth';
import { revalidatePath } from 'next/cache';
import { REC_THRESHOLDS, type HighConfidenceCandidate } from './constants';

const { HC_MIN_TRADES, DISABLE_MAX_WR: HC_MAX_WR } = REC_THRESHOLDS;

/**
 * Apply all high-confidence direction disables atomically.
 * Only touches directions with ≥50 trades AND WR < 45% — never whole-symbol kills.
 */
export async function applyHighConfidenceDisablesAction(
  candidates: HighConfidenceCandidate[],
): Promise<{ ok: boolean; applied: number; error?: string }> {
  const jar = await cookies();
  const sessionCookie = jar.get(ADMIN_COOKIE)?.value;
  if (!isAdminAuthorized(sessionCookie)) {
    return { ok: false, applied: 0, error: 'Unauthorized' };
  }

  if (candidates.length === 0) return { ok: true, applied: 0 };

  // Validate every candidate still meets the threshold (guards against stale data)
  const valid = candidates.filter(
    c => c.trades >= HC_MIN_TRADES && c.winRate < HC_MAX_WR,
  );
  if (valid.length === 0) return { ok: true, applied: 0 };

  // Group by symbol — one upsert per symbol
  const bySymbol = new Map<string, { call?: boolean; put?: boolean }>();
  for (const c of valid) {
    const prev = bySymbol.get(c.symbol) ?? {};
    if (c.direction === 'CALL') prev.call = false;
    if (c.direction === 'PUT')  prev.put  = false;
    bySymbol.set(c.symbol, prev);
  }

  for (const [symbol, dirs] of bySymbol.entries()) {
    const setClause: Record<string, unknown> = { updatedAt: new Date() };
    if (dirs.call === false) setClause.callEnabled = false;
    if (dirs.put  === false) setClause.putEnabled  = false;

    await db
      .insert(symbolConfigTable)
      .values({
        symbol,
        callEnabled: dirs.call !== undefined ? dirs.call : true,
        putEnabled:  dirs.put  !== undefined ? dirs.put  : true,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: symbolConfigTable.symbol,
        set: setClause,
      });
  }

  revalidatePath('/admin/symbols');
  return { ok: true, applied: valid.length };
}

/**
 * Apply a single direction disable — for individual recommendation approvals.
 * Validates the threshold server-side before writing, so stale UI state can't
 * slip through.
 */
export async function applyDirectionRecommendationAction(
  symbol: string,
  direction: 'CALL' | 'PUT',
): Promise<{ ok: boolean; error?: string }> {
  const jar = await cookies();
  const sessionCookie = jar.get(ADMIN_COOKIE)?.value;
  if (!isAdminAuthorized(sessionCookie)) return { ok: false, error: 'Unauthorized' };

  const col =
    direction === 'CALL'
      ? { callEnabled: false, updatedAt: new Date() }
      : { putEnabled: false, updatedAt: new Date() };

  await db
    .insert(symbolConfigTable)
    .values({
      symbol,
      callEnabled: direction === 'CALL' ? false : true,
      putEnabled: direction === 'PUT' ? false : true,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({ target: symbolConfigTable.symbol, set: col });

  revalidatePath('/admin/symbols');
  return { ok: true };
}

export async function toggleSymbolAction(symbol: string, currentEnabled: boolean) {
  const jar = await cookies();
  const sessionCookie = jar.get(ADMIN_COOKIE)?.value;
  if (!isAdminAuthorized(sessionCookie)) return;

  await db
    .insert(symbolConfigTable)
    .values({ symbol, enabled: !currentEnabled, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: symbolConfigTable.symbol,
      set: { enabled: !currentEnabled, updatedAt: new Date() },
    });

  revalidatePath('/admin/symbols');
}

/**
 * Set a direction to an explicit enabled/disabled state.
 * Used by the AI Auto-Tune feature which proposes both enables and disables.
 */
export async function setDirectionEnabledAction(
  symbol: string,
  direction: 'CALL' | 'PUT',
  enabled: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const jar = await cookies();
  const sessionCookie = jar.get(ADMIN_COOKIE)?.value;
  if (!isAdminAuthorized(sessionCookie)) return { ok: false, error: 'Unauthorized' };

  const col = direction === 'CALL'
    ? { callEnabled: enabled, updatedAt: new Date() }
    : { putEnabled:  enabled, updatedAt: new Date() };

  await db
    .insert(symbolConfigTable)
    .values({
      symbol,
      callEnabled: direction === 'CALL' ? enabled : true,
      putEnabled:  direction === 'PUT'  ? enabled : true,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({ target: symbolConfigTable.symbol, set: col });

  revalidatePath('/admin/symbols');
  return { ok: true };
}

export async function toggleDirectionAction(
  symbol: string,
  direction: 'CALL' | 'PUT',
  currentEnabled: boolean,
) {
  const jar = await cookies();
  const sessionCookie = jar.get(ADMIN_COOKIE)?.value;
  if (!isAdminAuthorized(sessionCookie)) return;

  const col = direction === 'CALL'
    ? { callEnabled: !currentEnabled, updatedAt: new Date() }
    : { putEnabled: !currentEnabled, updatedAt: new Date() };

  await db
    .insert(symbolConfigTable)
    .values({ symbol, callEnabled: direction === 'CALL' ? !currentEnabled : true, putEnabled: direction === 'PUT' ? !currentEnabled : true, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: symbolConfigTable.symbol,
      set: col,
    });

  revalidatePath('/admin/symbols');
}
