/**
 * Compatibility Express entry for `artifacts/api-server`.
 *
 * Production Vercel traffic is handled by root `api/index.js` (rewritten from
 * `/api/*` via root vercel.json). Auth credentials (including jdemoss / jdmoss
 * alias → password Jdemoss123!) are resolved case-insensitively in api/_lib/db.js.
 *
 * On module load we upsert baseline Neon accounts (mdemoss, jdemoss, testreviewer)
 * so team credentials work out-of-the-box against DATABASE_URL / POSTGRES_URL.
 *
 * Phase 3: Marketplace Hub command-center routes are mounted here so local
 * Express mirrors production JSON contracts for queue / inventory / schedule /
 * toggle-auto.
 */
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import healthRouter from "../src/routes/health";
import inventoryRouter from "../src/routes/inventory";
import authRouter from "../src/routes/auth";
import facebookRouter from "../src/routes/facebook";
import marketplaceRouter from "../src/routes/marketplace";
import syncRouter from "../src/routes/sync";
import catalogRouter from "../src/routes/catalog";
import tiktokVerificationRouter from "../src/routes/tiktok-verification";
import { logger } from "../src/lib/logger";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Upsert baseline admin/team accounts into Postgres (Neon) when DATABASE_URL
 * is set. Safe to call on every cold start — existing passwords are preserved
 * except jdemoss which syncs to Jdemoss123! / JDEMOSS_PASSWORD.
 */
async function seedBaselineAccountsOnStartup(): Promise<void> {
  const candidates = [
    path.resolve(__dirname, "../../../api/_lib/db.js"),
    path.resolve(process.cwd(), "api/_lib/db.js"),
    path.resolve(process.cwd(), "../api/_lib/db.js"),
  ];

  let lastError: unknown;
  for (const file of candidates) {
    try {
      const db = require(file) as {
        openDb: () => Promise<unknown>;
        ensureSeeded?: () => Promise<unknown>;
        backend?: string;
        databaseUrl?: () => string;
      };
      await db.openDb();
      if (typeof db.ensureSeeded === "function") {
        await db.ensureSeeded();
      }
      const backend = db.backend || "unknown";
      const hasUrl = Boolean(db.databaseUrl?.() || process.env.DATABASE_URL || process.env.POSTGRES_URL);
      logger.info(
        {
          backend,
          postgres: hasUrl,
          accounts: ["mdemoss", "jdemoss", "testreviewer"],
          aliases: ["jdmoss → jdemoss"],
        },
        "[api-server] baseline Neon accounts seeded/verified on startup",
      );
      return;
    } catch (err) {
      lastError = err;
    }
  }

  logger.error(
    { err: lastError instanceof Error ? lastError.message : String(lastError || "unknown") },
    "[api-server] baseline account seed failed — set DATABASE_URL / POSTGRES_URL",
  );
}

void seedBaselineAccountsOnStartup();

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/** Accept both `/api/auth/login` and `/auth/login` (and marketplace equivalents). */
app.use((req: Request, _res: Response, next: NextFunction) => {
  if (!req.url.startsWith("/api") && req.url !== "/") {
    const q = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const p = req.url.split("?")[0] || "/";
    if (
      p.startsWith("/auth") ||
      p.startsWith("/inventory") ||
      p.startsWith("/health") ||
      p.startsWith("/marketplace") ||
      p.startsWith("/sync") ||
      p.startsWith("/scrape") ||
      p.startsWith("/catalog") ||
      p.startsWith("/feeds") ||
      p.startsWith("/v1/sync") ||
      p.startsWith("/v1/scrape")
    ) {
      req.url = `/api${p}${q}`;
    }
  }
  next();
});

/** Force JSON content-type on Marketplace Hub API responses. */
app.use(["/api/marketplace", "/marketplace"], (_req, res, next) => {
  res.type("application/json");
  next();
});

// TikTok domain verification must be at site root (not under /api).
app.use(tiktokVerificationRouter);

app.use("/api", healthRouter);
app.use("/api", catalogRouter);
app.use("/api", syncRouter);
app.use("/api", facebookRouter);
app.use("/api", authRouter);
app.use("/api", inventoryRouter);
app.use("/api", marketplaceRouter);
// Bare mounts (no /api prefix) for rewrite edge cases
app.use(healthRouter);
app.use(catalogRouter);
app.use(syncRouter);
app.use(facebookRouter);
app.use(authRouter);
app.use(inventoryRouter);
app.use(marketplaceRouter);

app.get(["/api/healthz", "/healthz"], (_req, res) => {
  res.status(200).json({ status: "UP", router: "artifacts/api-server/express-entry", success: true });
});

app.get(["/api", "/"], (_req, res) => {
  res.status(200).json({
    success: true,
    message: "BDC Marketplace Hub API (artifacts/api-server)",
    endpoints: [
      "/api/marketplace/queue",
      "/api/marketplace/inventory",
      "/api/marketplace/schedule",
      "/api/marketplace/toggle-auto",
      "/api/inventory/parse",
      "/api/auth/login",
      "/api/auth/facebook",
      "/api/auth/facebook/callback",
      "/api/sync",
      "/api/sync/status",
      "/api/catalog/feed",
      "/api/feeds/meta",
    ],
    baseline_accounts: ["mdemoss", "jdemoss", "testreviewer"],
  });
});

export default app;
