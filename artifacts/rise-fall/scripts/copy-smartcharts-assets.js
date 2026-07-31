/**
 * Copies SmartCharts runtime assets from `node_modules/@deriv-com/smartcharts-champion/dist`
 * into the calling template's `public/` directory.
 *
 * Why: SmartCharts lazy-loads chunks, the Flutter chart engine, fonts, and sprite sheets
 * via `setSmartChartsPublicPath()`. Those files must be served at known URL paths, but
 * Next.js's `public/` only serves files physically located there — it can't reach into
 * `node_modules`. Copying keeps the package as the single source of truth (version-bump
 * the npm dep → rerun, no stale committed binaries).
 *
 * Usage: Called from template package.json scripts with the template directory as CWD.
 * E.g. "copy-smartcharts-assets": "node ../../scripts/copy-smartcharts-assets.js"
 */
const fs = require('node:fs');
const path = require('node:path');

const TEMPLATE_ROOT = process.cwd();
const SOURCE = path.resolve(
  TEMPLATE_ROOT,
  './node_modules/@deriv-com/smartcharts-champion/dist'
);
const DEST = path.join(TEMPLATE_ROOT, 'public');

if (!fs.existsSync(SOURCE)) {
  console.warn(
    `[copy-smartcharts-assets] skip: source not found at ${SOURCE}. ` +
      `Run \`npm install\` at the repo root first.`
  );
  process.exit(0);
}

fs.mkdirSync(DEST, { recursive: true });
// recursive copy, preserving existing files like `logo.png` in public/
fs.cpSync(SOURCE, DEST, { recursive: true, force: true });

console.log(`[copy-smartcharts-assets] copied ${SOURCE} → ${DEST}`);
