/**
 * Meta catalog feed routes for the local Express api-server.
 * Delegates to root `api/_routes/catalog/feed.js` (Neon-backed, public).
 */
import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const router: IRouter = Router();
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

type Handler = (req: Request, res: Response) => void | Promise<void>;

function loadHandler(): Handler {
  const candidates = [
    path.resolve(__dirname, "../../../../api/_routes/catalog/feed.js"),
    path.resolve(process.cwd(), "api/_routes/catalog/feed.js"),
    path.resolve(process.cwd(), "../api/_routes/catalog/feed.js"),
  ];
  for (const file of candidates) {
    try {
      return require(file) as Handler;
    } catch {
      /* try next */
    }
  }
  throw new Error("catalog/feed.js handler not found");
}

const feedHandler = loadHandler();

function asExpress(handler: Handler) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res)).catch(next);
  };
}

router.get(["/catalog/feed", "/feeds/meta", "/feeds/catalog"], asExpress(feedHandler));
router.head(["/catalog/feed", "/feeds/meta", "/feeds/catalog"], asExpress(feedHandler));

export default router;
