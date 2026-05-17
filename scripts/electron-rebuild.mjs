/**
 * Rebuild native modules (better-sqlite3) against Electron's ABI.
 *
 * We invoke @electron/rebuild's programmatic API rather than its `electron-rebuild`
 * CLI: the CLI's bundled yargs throws under Node >= 23 ("require is not defined
 * in ES module scope"). The programmatic API is unaffected. Run via `npm run
 * rebuild` and automatically on `postinstall`.
 */

import { createRequire } from 'node:module';
import { rebuild } from '@electron/rebuild';

const require = createRequire(import.meta.url);
const electronVersion = require('electron/package.json').version;

console.log(`[electron-rebuild] better-sqlite3 -> Electron ${electronVersion}`);

rebuild({
  buildPath: process.cwd(),
  electronVersion,
  onlyModules: ['better-sqlite3'],
  force: true,
})
  .then(() => console.log('[electron-rebuild] done'))
  .catch((err) => {
    console.error('[electron-rebuild] failed:', err?.message ?? err);
    process.exitCode = 1;
  });
