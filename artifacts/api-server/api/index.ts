/**
 * Compatibility Express entry for `artifacts/api-server`.
 *
 * Production Vercel traffic is handled by root `api/index.js` (rewritten from
 * `/api/*` via root vercel.json). Auth credentials (including jdemoss / jdmoss
 * alias → password Jdemoss123!) are resolved case-insensitively in api/_lib/db.js.
 *
 * Phase 3: Marketplace Hub command-center routes are mounted here so local
 * Express mirrors production JSON contracts for queue / inventory / schedule /
 * toggle-auto.
 */
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import healthRouter from "../src/routes/health";
import inventoryRouter from "../src/routes/inventory";
import authRouter from "../src/routes/auth";
import marketplaceRouter from "../src/routes/marketplace";
import { logger } from "../src/lib/logger";

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
      p.startsWith("/marketplace")
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

app.use("/api", healthRouter);
app.use("/api", authRouter);
app.use("/api", inventoryRouter);
app.use("/api", marketplaceRouter);
// Bare mounts (no /api prefix) for rewrite edge cases
app.use(healthRouter);
app.use(authRouter);
app.use(inventoryRouter);
app.use(marketplaceRouter);

app.get(["/api/healthz", "/healthz"], (_req, res) => {
  res.status(200).json({ status: "UP", router: "artifacts/api-server/api/index", success: true });
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
    ],
  });
});

export default app;
