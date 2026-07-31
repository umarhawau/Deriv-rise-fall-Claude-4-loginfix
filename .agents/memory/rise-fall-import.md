---
name: Rise-Fall import quirks
description: Key decisions made when importing the PulseEdge Rise Fall repo into this Replit workspace.
---

The rise-fall artifact is a Next.js 15 (App Router, SSR) app, NOT a Vite/React SPA. It was imported from GitHub and registered as a react-vite artifact (the only available web type), then the artifact.toml was patched to use Next.js dev/build/start commands.

**Why:** The workspace's artifact system only has react-vite as a web type, but the real app is Next.js. The toml swap is the canonical fix.

**How to apply:** If artifact.toml ever gets regenerated/reset, re-apply the Next.js production run block (args: next start, not static serve) and remove the Vite rewrite rule.

The Express api-server's artifact.toml paths must stay as `["/api/healthz"]` — if it's ever changed back to `["/api"]`, all Next.js API routes (trades, settings, admin, auth, etc.) will be silently intercepted by Express and return 404.

DB migration: run `pnpm --filter @workspace/scripts run migrate-neon` (requires NEON_DATABASE_URL in env). The migration script at scripts/src/migrate-neon.ts uses raw SQL (CREATE TABLE IF NOT EXISTS) so it is idempotent.

Required secrets: NEON_DATABASE_URL, ADMIN_SECRET, OPENAI_API_KEY, SESSION_SECRET (last one already set by Replit).

lib/settings is a workspace lib that dynamically reflects the Drizzle schema for settings validation — no manual sync needed when adding DB columns.
