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

function loadScraperSettings(): {
  getScraperSettings: () => Promise<Record<string, unknown>>;
  saveScraperSettings: (p: Record<string, unknown>) => Promise<Record<string, unknown>>;
} {
  const candidates = [
    path.resolve(__dirname, "../../../../api/_lib/scraper-settings.js"),
    path.resolve(process.cwd(), "api/_lib/scraper-settings.js"),
    path.resolve(process.cwd(), "../api/_lib/scraper-settings.js"),
  ];
  for (const file of candidates) {
    try {
      return require(file) as ReturnType<typeof loadScraperSettings>;
    } catch {
      /* try next */
    }
  }
  throw new Error("scraper-settings.js not found");
}

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
router.get("/marketplace/queue", async (req, res) => {
  try {
    const lib = loadMarketplaceLib();
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const payload = await lib.getPublisherQueue(status);
    res.status(200).json(payload ?? emptyQueue());
  } catch (err) {
    console.error("[marketplace/queue]", err);
    res.status(200).json(emptyQueue());
  }
});

/** GET /api/marketplace/inventory */
router.get("/marketplace/inventory", async (req, res) => {
  try {
    const lib = loadMarketplaceLib();
    const payload = await lib.listInventory(req.query as Record<string, string>);
    res.status(200).json(payload ?? emptyInventory());
  } catch (err) {
    console.error("[marketplace/inventory]", err);
    res.status(200).json(emptyInventory());
  }
});

/** POST /api/marketplace/schedule */
router.post("/marketplace/schedule", async (req, res) => {
  try {
    const lib = loadMarketplaceLib();
    const body = (req.body || {}) as Record<string, unknown>;
    const payload = await lib.scheduleVehicle({
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

function loadCjsHandler(relCandidates: string[]): (req: Request, res: Response) => Promise<void> | void {
  for (const file of relCandidates) {
    try {
      return require(file) as (req: Request, res: Response) => Promise<void> | void;
    } catch {
      /* try next */
    }
  }
  throw new Error(`handler not found among: ${relCandidates.join(", ")}`);
}

function asExpress(
  handler: (req: Request, res: Response) => Promise<void> | void,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res)).catch(next);
  };
}

const feedStatusHandler = loadCjsHandler([
  path.resolve(__dirname, "../../../../api/_routes/inventory/feed-status.js"),
  path.resolve(process.cwd(), "api/_routes/inventory/feed-status.js"),
  path.resolve(process.cwd(), "../api/_routes/inventory/feed-status.js"),
]);

const generateDescriptionHandler = loadCjsHandler([
  path.resolve(__dirname, "../../../../api/_routes/generate-description.js"),
  path.resolve(process.cwd(), "api/_routes/generate-description.js"),
  path.resolve(process.cwd(), "../api/_routes/generate-description.js"),
]);

const saveDescriptionHandler = loadCjsHandler([
  path.resolve(__dirname, "../../../../api/_routes/marketplace/save-description.js"),
  path.resolve(process.cwd(), "api/_routes/marketplace/save-description.js"),
  path.resolve(process.cwd(), "../api/_routes/marketplace/save-description.js"),
]);

/** POST /api/v1/marketplace/posting + /api/inventory/feed-status */
router.post(
  ["/v1/marketplace/posting", "/inventory/feed-status", "/marketplace/feed-status"],
  asExpress(feedStatusHandler),
);

/** POST AI description (internal OpenAI / template — never external Meta AI) */
router.post(
  [
    "/marketplace/generate-description",
    "/generate-description",
    "/v1/generate-description",
    "/v1/marketplace/generate-description",
  ],
  asExpress(generateDescriptionHandler),
);

router.post(
  ["/marketplace/save-description", "/save-description", "/v1/marketplace/save-description"],
  asExpress(saveDescriptionHandler),
);

/** GET|POST /api/marketplace/settings */
router.get("/marketplace/settings", async (_req, res) => {
  try {
    const lib = loadScraperSettings();
    res.status(200).json({ success: true, ...(await lib.getScraperSettings()) });
  } catch (err) {
    console.error("[marketplace/settings GET]", err);
    res.status(200).json({
      success: true,
      inventory_url_used: "",
      inventory_url_new: "",
      inventory_locations: [],
      dealer_name: "",
    });
  }
});

router.post("/marketplace/settings", async (req, res) => {
  try {
    const lib = loadScraperSettings();
    const saved = await lib.saveScraperSettings((req.body || {}) as Record<string, unknown>);
    res.status(200).json({ success: true, ...saved, message: "Settings saved." });
  } catch (err: unknown) {
    const e = err as { message?: string };
    console.error("[marketplace/settings POST]", err);
    res.status(500).json({
      success: false,
      error: e?.message || "Failed to save settings.",
    });
  }
});

/** GET|POST /api/marketplace/toggle-auto */
router.get("/marketplace/toggle-auto", async (_req, res) => {
  try {
    const lib = loadMarketplaceLib();
    res.status(200).json(await lib.getAutoPublish());
  } catch (err) {
    console.error("[marketplace/toggle-auto GET]", err);
    res.status(200).json({ success: true, auto_publish: true, status: "active" });
  }
});

router.post("/marketplace/toggle-auto", async (req, res) => {
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
      const current = (await lib.getAutoPublish()) as { auto_publish?: boolean };
      enabled = !Boolean(current?.auto_publish);
    }
    const payload = await lib.setAutoPublish(enabled);
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
