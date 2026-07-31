/**
 * Dynamic settings validation — driven by the DB schema.
 *
 * How to add a new setting:
 *   1. Add the column to systemSettingsTable in lib/db/src/schema/index.ts
 *   2. Run `pnpm --filter @workspace/db run push` (or the psql ALTER TABLE)
 *   3. Done. The API automatically discovers and accepts the new field.
 *
 * Optional: add an entry to RANGE_CONSTRAINTS below for min/max bounds.
 * Optional: add a default to SETTINGS_DEFAULTS below for the GET fallback.
 * The UI (settings-panel.tsx) still needs a slider/control added manually.
 */

import { getTableColumns } from 'drizzle-orm';
import { systemSettingsTable } from '@workspace/db/schema';

/**
 * Optional per-field range constraints (min / max).
 * Fields NOT listed here are still accepted — only type validation applies.
 * Add or tighten ranges here without touching any API route.
 */
export const RANGE_CONSTRAINTS: Partial<Record<string, { min?: number; max?: number }>> = {
  globalDebounceSeconds:    { min: 1,   max: 300  },
  sniperStrikeMaxTicks:     { min: 1,   max: 50   },
  sniperRequiredVotes:      { min: 1,   max: 3    },
  balancedRequiredVotes:    { min: 1,   max: 3    },
  aggressiveRequiredVotes:  { min: 1,   max: 3    },
  expiryMinSample:          { min: 5,   max: 500  },
  sniperZMax:               { min: 0.5, max: 5    },
  balancedZMax:             { min: 0.5, max: 5    },
  aggressiveZMax:           { min: 0.5, max: 5    },
  confidenceZExtreme:       { min: 0.5, max: 10   },
  sniperStrikeAccelMin:     { min: 0.1, max: 10   },
};

/** Default values returned when the DB has no row yet. */
export const SETTINGS_DEFAULTS: Record<string, string | number> = {
  globalDebounceSeconds:    15,
  autoErTrending:           '0.65',
  autoErRanging:            '0.45',
  sniperCallErMin:          '0.00',
  sniperPutErMin:           '0.60',
  balancedCallErMin:        '0.10',
  balancedPutErMin:         '0.40',
  aggressiveCallErMin:      '0.20',
  aggressivePutErMin:       '0.30',
  sniperZMax:               '1.50',
  balancedZMax:             '2.00',
  aggressiveZMax:           '2.50',
  sniperExhaustionCall:     '0.75',
  sniperExhaustionPut:      '0.25',
  balancedExhaustionCall:   '0.80',
  balancedExhaustionPut:    '0.20',
  aggressiveExhaustionCall: '0.90',
  aggressiveExhaustionPut:  '0.10',
  sniperRequiredVotes:      3,
  balancedRequiredVotes:    3,
  aggressiveRequiredVotes:  2,
  confidenceErFloor:        '0.40',
  confidenceErCeiling:      '0.80',
  confidenceZExtreme:       '2.50',
  sniperStrikeErFloor:      '0.70',
  sniperStrikeErCeiling:    '1.00',
  sniperStrikeAccelMin:     '1.50',
  sniperStrikeMaxTicks:     10,
  momentumRideErFloor:      '0.50',
  momentumRideErMedium:     '0.65',
  momentumRideErLow:        '0.55',
  expiryMinSample:          30,
};

type ColumnKind = 'integer' | 'numeric' | 'other';

/** Build a field-type map by inspecting the live Drizzle schema. Cached after first call. */
let _fieldTypes: Record<string, ColumnKind> | null = null;

function getFieldTypes(): Record<string, ColumnKind> {
  if (_fieldTypes) return _fieldTypes;
  const columns = getTableColumns(systemSettingsTable);
  const result: Record<string, ColumnKind> = {};
  for (const [name, col] of Object.entries(columns)) {
    if (name === 'id') continue;
    const sqlType = col.getSQLType();
    result[name] =
      sqlType === 'integer' ? 'integer' :
      sqlType === 'numeric' ? 'numeric' :
      'other';
  }
  _fieldTypes = result;
  return result;
}

export type ProcessResult =
  | { ok: true; updates: Record<string, string | number> }
  | { ok: false; error: string; status: number };

/**
 * Validates and coerces a settings PATCH body against the live DB schema.
 * - Unknown fields are silently ignored.
 * - integer columns → stored as a rounded integer.
 * - numeric columns → stored as a 4-decimal-place string.
 * - Range constraints from RANGE_CONSTRAINTS are applied when present.
 *
 * New DB column = automatically accepted here. No edits required.
 */
export function processSettingsBody(body: Record<string, unknown>): ProcessResult {
  const fieldTypes = getFieldTypes();
  const updates: Record<string, string | number> = {};

  for (const [field, raw] of Object.entries(body)) {
    const kind = fieldTypes[field];
    if (!kind || kind === 'other') continue; // unknown or non-numeric column — skip
    if (raw === null || raw === undefined) continue;

    const n = Number(raw);
    if (isNaN(n))
      return { ok: false, error: `${field} must be a number`, status: 400 };

    const range = RANGE_CONSTRAINTS[field];
    if (range?.min !== undefined && n < range.min)
      return { ok: false, error: `${field} must be ≥ ${range.min}`, status: 400 };
    if (range?.max !== undefined && n > range.max)
      return { ok: false, error: `${field} must be ≤ ${range.max}`, status: 400 };

    updates[field] = kind === 'integer' ? Math.round(n) : n.toFixed(4);
  }

  if (Object.keys(updates).length === 0)
    return { ok: false, error: 'No valid fields provided', status: 400 };

  return { ok: true, updates };
}
