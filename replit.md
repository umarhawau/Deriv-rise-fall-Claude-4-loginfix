# PulseEdge Rise Fall

A Deriv Rise/Fall algorithmic trading assistant — monitors ticks via the Deriv WebSocket API, computes noise/z-score/ER signals, and auto-executes CALL/PUT contracts across multiple symbols with configurable risk modes (Sniper, Balanced, Aggressive). Includes an admin panel for live calibration, trade analytics, symbol management, and AI-assisted parameter tuning.

## Run & Operate

- `pnpm --filter @workspace/rise-fall run dev` — run the Next.js app (port 23700)
- `pnpm --filter @workspace/api-server run dev` — run the Express health-check server (port 8080)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/db run push` — push DB schema changes to Neon (requires NEON_DATABASE_URL)
- `pnpm --filter @workspace/scripts run migrate-neon` — run raw SQL migration against Neon DB

## Required Secrets

Set these in Replit Secrets (the lock icon in the sidebar):

| Secret | Purpose |
|---|---|
| `NEON_DATABASE_URL` | Neon PostgreSQL connection string (postgresql://...) |
| `SESSION_SECRET` | ✅ Already set — used by NextAuth for JWT signing |
| `ADMIN_SECRET` | Password for the `/admin` panel login |
| `OPENAI_API_KEY` | Used by AI-tune and loss-pattern analysis routes |

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5
- Frontend/Backend: Next.js 15 (App Router, SSR)
- DB: Neon PostgreSQL + Drizzle ORM
- Auth: NextAuth v5 (JWT, admin credentials)
- Charts: @deriv-com/smartcharts-champion (Flutter-based)
- Trading: Deriv WebSocket API via @deriv/core
- AI: OpenAI (gpt-4o) for signal calibration hints

## Where things live

- `artifacts/rise-fall/app/` — Next.js App Router pages and API routes
- `artifacts/rise-fall/app/api/` — All server-side API endpoints
- `artifacts/rise-fall/components/` — Shared UI components
- `artifacts/rise-fall/packages/core/` — Deriv WS client, auth, trading hooks
- `artifacts/rise-fall/hooks/` — React hooks for trading engine
- `lib/db/src/schema/` — Drizzle schema (source of truth for all tables)
- `lib/settings/src/` — Dynamic settings validation library

## Database Tables

- `system_settings` — Global signal thresholds and risk-mode parameters
- `trade_logs` — Full record of every LIVE/GHOST trade
- `symbol_config` — Per-symbol enable/disable and direction control
- `suppression_logs` — Log of direction-suppression events
- `market_profiles` — Per-market-type ER/Z thresholds

## Architecture decisions

- Next.js handles all API routes (`/api/*`) — the Express api-server only serves `/api/healthz`
- DB connection uses `NEON_DATABASE_URL` or falls back to `DATABASE_URL`
- Admin panel at `/admin/*` is protected by NextAuth JWT middleware
- Flutter-based SmartCharts are served as static assets from `/public/`
- `lib/settings` dynamically discovers DB columns for settings validation — no manual sync needed

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Always run `pnpm --filter @workspace/scripts run migrate-neon` when schema changes are deployed to Neon
- The api-server's path is `/api/healthz` only — do NOT expand it to `/api` or Next.js API routes will be shadowed
- `pnpm verify-builds` is needed for `sharp` if image processing is added
- SmartCharts assets are copied from `node_modules` to `public/` via postinstall script
