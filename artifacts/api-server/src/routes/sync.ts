/**
 * Inventory sync routes for the local Express api-server.
 * Delegates to root `api/_routes/sync*` handlers (Neon-backed scraper).
 */
import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const router: IRouter = Router();
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

type Handler = (req: Request, res: Response) => void | Promise<void>;

function loadHandler(rel: string): Handler {
  const candidates = [
    path.resolve(__dirname, `../../../../api/_routes/${rel}`),
    path.resolve(process.cwd(), `api/_routes/${rel}`),
    path.resolve(process.cwd(), `../api/_routes/${rel}`),
  ];
  for (const file of candidates) {
    try {
      return require(file) as Handler;
    } catch {
      /* try next */
    }
  }
  throw new Error(`Sync handler not found: ${rel}`);
}

function asExpress(handler: Handler) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res)).catch(next);
  };
}

const syncHandler = loadHandler("sync.js");
const statusHandler = loadHandler("sync/status.js");
const cancelHandler = loadHandler("scrape/cancel.js");

router.post(["/sync", "/scrape", "/v1/sync", "/v1/scrape"], asExpress(syncHandler));
router.get(["/sync", "/scrape", "/v1/sync", "/v1/scrape"], asExpress(syncHandler));
router.get(
  ["/sync/status", "/scrape/status", "/v1/sync/status", "/v1/scrape/status"],
  asExpress(statusHandler),
);
router.post(
  ["/scrape/cancel", "/sync/cancel", "/v1/scrape/cancel", "/v1/sync/cancel"],
  asExpress(cancelHandler),
);

export default router;
