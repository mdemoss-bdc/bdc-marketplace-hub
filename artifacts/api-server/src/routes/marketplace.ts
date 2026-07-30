/**
 * Marketplace Hub command-center routes for the artifacts Express app.
 *
 * Contracts match root `api/_routes/marketplace/*` so the Hub always receives
 * explicit `application/json` bodies (never HTML 404 pages).
 */
import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const router: IRouter = Router();
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Resolve root `api/_lib/marketplace.js` from artifacts/api-server/src/routes. */
function loadMarketplaceLib(): Record<string, (...args: unknown[]) => unknown> {
  const candidates = [
    path.resolve(__dirname, "../../../../api/_lib/marketplace.js"),
    path.resolve(process.cwd(), "api/_lib/marketplace.js"),
    path.resolve(process.cwd(), "../api/_lib/marketplace.js"),
  ];
  for (const file of candidates) {
    try {
      return require(file) as Record<string, (...args: unknown[]) => unknown>;
    } catch {
      /* try next */
    }
  }
  throw new Error("marketplace.js helper not found");
}

function jsonHeaders(_req: Request, res: Response, next: NextFunction) {
  res.type("application/json");
  res.setHeader("Cache-Control", "no-store");
  next();
}

router.use(jsonHeaders);

function emptyQueue() {
  return {
    success: true,
    items: [],
    total: 0,
    counts: { scheduled: 0, posted: 0, failed: 0, paused: 0 },
    quota: {
      posts_today: 0,
      daily_cap: 10,
      remaining: 10,
      cap_reached: false,
      label: "0 / 10 posts today",
      window: "08:00–21:00",
    },
    queue: [],
    auto_publish: true,
  };
}

function emptyInventory() {
  return {
    success: true,
    inventory: [],
    makes: [],
    models: [],
    years: [],
    locations: [],
    counts: { ACTIVE: 0, SOLD: 0, total: 0, posted: 0 },
    last_sync: "",
  };
}

/** GET /api/marketplace/queue */
router.get("/marketplace/queue", (req, res) => {
  try {
    const lib = loadMarketplaceLib();
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const payload = lib.getPublisherQueue(status);
    res.status(200).json(payload ?? emptyQueue());
  } catch (err) {
    console.error("[marketplace/queue]", err);
    res.status(200).json(emptyQueue());
  }
});

/** GET /api/marketplace/inventory */
router.get("/marketplace/inventory", (req, res) => {
  try {
    const lib = loadMarketplaceLib();
    const payload = lib.listInventory(req.query as Record<string, string>);
    res.status(200).json(payload ?? emptyInventory());
  } catch (err) {
    console.error("[marketplace/inventory]", err);
    res.status(200).json(emptyInventory());
  }
});

/** POST /api/marketplace/schedule */
router.post("/marketplace/schedule", (req, res) => {
  try {
    const lib = loadMarketplaceLib();
    const body = (req.body || {}) as Record<string, unknown>;
    const payload = lib.scheduleVehicle({
      vin: body.vin,
      ai_description: body.ai_description,
      publish_now: Boolean(body.publish_now || body.post_now || body.instant),
      scheduled_time: body.scheduled_time || null,
    });
    res.status(200).json(payload);
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string; quota?: unknown };
    const status = Number(e?.status) || 500;
    console.error("[marketplace/schedule]", err);
    if (status === 429) {
      res.status(429).json({
        success: false,
        error: e.message || "Daily cap reached.",
        quota: e.quota || emptyQueue().quota,
      });
      return;
    }
    res.status(status >= 400 && status < 600 ? status : 500).json({
      success: false,
      error: e?.message || "Scheduling failed.",
    });
  }
});

/** GET|POST /api/marketplace/toggle-auto */
router.get("/marketplace/toggle-auto", (_req, res) => {
  try {
    const lib = loadMarketplaceLib();
    res.status(200).json(lib.getAutoPublish());
  } catch (err) {
    console.error("[marketplace/toggle-auto GET]", err);
    res.status(200).json({ success: true, auto_publish: true, status: "active" });
  }
});

router.post("/marketplace/toggle-auto", (req, res) => {
  try {
    const lib = loadMarketplaceLib();
    const body = (req.body || {}) as Record<string, unknown>;
    let enabled: boolean;
    if (typeof body.enabled === "boolean") {
      enabled = body.enabled;
    } else if (typeof body.auto_publish === "boolean") {
      enabled = body.auto_publish;
    } else if (typeof body.on === "boolean") {
      enabled = body.on;
    } else {
      const current = lib.getAutoPublish() as { auto_publish?: boolean };
      enabled = !Boolean(current?.auto_publish);
    }
    const payload = lib.setAutoPublish(enabled);
    res.status(200).json(payload);
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    console.error("[marketplace/toggle-auto POST]", err);
    res.status(Number(e?.status) || 500).json({
      success: false,
      error: e?.message || "Failed to toggle auto-publish.",
    });
  }
});

export default router;
