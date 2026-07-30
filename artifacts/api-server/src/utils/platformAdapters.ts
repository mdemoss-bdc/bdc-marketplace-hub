/**
 * Multi-platform inventory adapters (Dealer.com, DealerOn, DealerSpike, Sincro).
 * Re-exports the shared CommonJS implementation used by Vercel `POST /api/sync`.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadAdapters(): Record<string, unknown> {
  const candidates = [
    path.resolve(__dirname, "../../../../api/_lib/platform-adapters.js"),
    path.resolve(process.cwd(), "api/_lib/platform-adapters.js"),
    path.resolve(process.cwd(), "../api/_lib/platform-adapters.js"),
  ];
  for (const file of candidates) {
    try {
      return require(file) as Record<string, unknown>;
    } catch {
      /* try next */
    }
  }
  throw new Error("platform-adapters.js not found");
}

const adapters = loadAdapters();

export const detectPlatform = adapters.detectPlatform as (
  html: string,
  url?: string,
) => string;
export const normalizeVehicle = adapters.normalizeVehicle as (
  raw: Record<string, unknown>,
  conditionFallback?: string,
  pageUrl?: string,
) => Record<string, unknown> | null;
export const parseDealerCom = adapters.parseDealerCom as (
  html: string,
  pageUrl: string,
  condition: string,
) => Record<string, unknown>[];
export const parseDealerOn = adapters.parseDealerOn as (
  html: string,
  pageUrl: string,
  condition: string,
) => Record<string, unknown>[];
export const parseDealerSpike = adapters.parseDealerSpike as (
  html: string,
  pageUrl: string,
  condition: string,
) => Record<string, unknown>[];
export const parseSincro = adapters.parseSincro as (
  html: string,
  pageUrl: string,
  condition: string,
) => Record<string, unknown>[];
export const parseJsonLd = adapters.parseJsonLd as (
  html: string,
  pageUrl: string,
  condition: string,
) => Record<string, unknown>[];
export const parseInventoryPage = adapters.parseInventoryPage as (
  html: string,
  pageUrl: string,
  condition?: string,
) => Promise<{ platform: string; vehicles: Record<string, unknown>[]; count: number }>;

export default adapters;
