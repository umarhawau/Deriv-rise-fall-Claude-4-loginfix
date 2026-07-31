import { db } from '@workspace/db';
import { marketProfilesTable } from '@workspace/db/schema';
import { isAdminAuthorized } from '../quant/admin-auth';
import { AdminLoginForm } from '../quant/login-form';
import { AdminNav } from '../admin-nav';
import { MarketProfilesPanel } from './market-profiles-panel';

export const dynamic = 'force-dynamic';

const PROFILE_DEFAULTS = {
  synthetic: { sniperCallErMin: '0.0500', sniperPutErMin: '0.0500', sniperZMax: '1.50', balancedCallErMin: '0.0300', balancedPutErMin: '0.0300', balancedZMax: '1.80', aggressiveCallErMin: '0.0200', aggressivePutErMin: '0.0200', aggressiveZMax: '2.20' },
  forex:     { sniperCallErMin: '0.1000', sniperPutErMin: '0.1000', sniperZMax: '2.00', balancedCallErMin: '0.0700', balancedPutErMin: '0.0700', balancedZMax: '2.30', aggressiveCallErMin: '0.0500', aggressivePutErMin: '0.0500', aggressiveZMax: '2.70' },
  metals:    { sniperCallErMin: '0.1500', sniperPutErMin: '0.1500', sniperZMax: '2.20', balancedCallErMin: '0.1000', balancedPutErMin: '0.1000', balancedZMax: '2.50', aggressiveCallErMin: '0.0700', aggressivePutErMin: '0.0700', aggressiveZMax: '3.00' },
  bull_bear: { sniperCallErMin: '0.0500', sniperPutErMin: '0.2000', sniperZMax: '1.80', balancedCallErMin: '0.0300', balancedPutErMin: '0.1500', balancedZMax: '2.00', aggressiveCallErMin: '0.0200', aggressivePutErMin: '0.1000', aggressiveZMax: '2.30' },
  step:      { sniperCallErMin: '0.1500', sniperPutErMin: '0.2500', sniperZMax: '2.00', balancedCallErMin: '0.1000', balancedPutErMin: '0.1800', balancedZMax: '2.30', aggressiveCallErMin: '0.0700', aggressivePutErMin: '0.1200', aggressiveZMax: '2.70' },
} as const;

const MARKET_TYPES = ['synthetic', 'forex', 'metals', 'bull_bear', 'step'] as const;
type MT = typeof MARKET_TYPES[number];

export default async function MarketProfilesPage() {
  if (!await isAdminAuthorized()) return <AdminLoginForm />;

  let profiles: typeof marketProfilesTable.$inferSelect[] = [];
  try {
    profiles = await db.select().from(marketProfilesTable);
  } catch {
    profiles = [];
  }

  const profileMap = Object.fromEntries(profiles.map(p => [p.marketType, p])) as Partial<Record<MT, typeof profiles[number]>>;
  const merged = MARKET_TYPES.map(mt => ({ marketType: mt, ...(PROFILE_DEFAULTS[mt]), ...(profileMap[mt] ?? {}) }));

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-[#0a0a0f] text-gray-900 dark:text-zinc-100 p-4 sm:p-6 space-y-6">
      <div>
        <h1 className="text-lg sm:text-xl font-bold tracking-tight text-gray-900 dark:text-white">
          🗂 Market Profiles
        </h1>
        <p className="text-xs text-gray-500 dark:text-zinc-500 mt-0.5">
          Per-market ER + Z-Max thresholds — applied automatically based on the active symbol. Global settings are used as fallback.
        </p>
      </div>
      <AdminNav />
      <MarketProfilesPanel profiles={merged} />
    </div>
  );
}
