import { defineConfig } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve the Chromium binary at config-load time so the path survives Nix
// store hash changes after system updates.  Priority order:
//   1. CHROMIUM_PATH env var (CI / manual override)
//   2. `which chromium` on the PATH (NixOS wrapper script)
//   3. `which chromium-browser` (Debian/Ubuntu name)
// Throws clearly if no binary can be found rather than silently using a
// stale hardcoded path.
function resolveChromium(): string {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  for (const name of ['chromium', 'chromium-browser']) {
    try {
      return execSync(`which ${name}`, { encoding: 'utf8' }).trim();
    } catch {
      // not on PATH under this name, try next
    }
  }
  throw new Error(
    'Chromium binary not found. Set CHROMIUM_PATH or install chromium on your PATH.',
  );
}

const SYSTEM_CHROMIUM = resolveChromium();

// Fixed port used for the Playwright test server.
const TEST_PORT = 5174;

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  retries: 0,
  reporter: 'list',

  // Playwright starts the Vite dev server before the first test and shuts it
  // down after the last one.  No need for a separate background process.
  webServer: {
    command: `PORT=${TEST_PORT} BASE_PATH=/ pnpm --filter @workspace/bdc-dashboard run dev`,
    cwd: path.resolve(__dirname, '../../../../'),  // monorepo root
    url: `http://127.0.0.1:${TEST_PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },

  use: {
    baseURL: `http://127.0.0.1:${TEST_PORT}`,
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        launchOptions: {
          executablePath: SYSTEM_CHROMIUM,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        },
      },
    },
  ],
});
