/**
 * Compatibility Express entry for `artifacts/api-server`.
 *
 * Production Vercel traffic is handled by root `api/index.js` (rewritten from
 * `/api/*` via root vercel.json). This module mounts the same auth paths with
 * and without the `/api` prefix for local Node runs of the TS api-server.
 */
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import healthRouter from "../src/routes/health";
import inventoryRouter from "../src/routes/inventory";
import authRouter from "../src/routes/auth";
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

/** Accept both `/api/auth/login` and `/auth/login`. */
app.use((req: Request, _res: Response, next: NextFunction) => {
  if (!req.url.startsWith("/api") && req.url !== "/") {
    const q = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const p = req.url.split("?")[0] || "/";
    if (p.startsWith("/auth") || p.startsWith("/inventory") || p.startsWith("/health")) {
      req.url = `/api${p}${q}`;
    }
  }
  next();
});

app.use("/api", healthRouter);
app.use("/api", authRouter);
app.use("/api", inventoryRouter);
// Bare mounts (no /api prefix) for rewrite edge cases
app.use(healthRouter);
app.use(authRouter);
app.use(inventoryRouter);

app.get(["/api/healthz", "/healthz"], (_req, res) => {
  res.status(200).json({ status: "UP", router: "artifacts/api-server/api/index", success: true });
});

export default app;
