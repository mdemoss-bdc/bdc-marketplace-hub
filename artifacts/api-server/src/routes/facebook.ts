/**
 * Facebook / Meta OAuth routes for the local Express api-server.
 * Delegates to the shared Vercel handlers in root `api/_routes/auth/facebook*`.
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
    path.resolve(__dirname, `../../../../api/_routes/auth/${rel}`),
    path.resolve(process.cwd(), `api/_routes/auth/${rel}`),
    path.resolve(process.cwd(), `../api/_routes/auth/${rel}`),
  ];
  for (const file of candidates) {
    try {
      return require(file) as Handler;
    } catch {
      /* try next */
    }
  }
  throw new Error(`Facebook auth handler not found: ${rel}`);
}

const startHandler = loadHandler("facebook.js");
const callbackHandler = loadHandler("facebook/callback.js");

function asExpress(handler: Handler) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res)).catch(next);
  };
}

router.get("/auth/facebook/callback", asExpress(callbackHandler));
router.get("/auth/facebook", asExpress(startHandler));
router.delete("/auth/facebook", asExpress(startHandler));

export default router;
