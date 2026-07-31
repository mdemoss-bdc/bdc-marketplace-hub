/**
 * TikTok URL Property Verification — signature file routes at site root.
 *
 * Serves all common TikTok developer-portal filename variants with the
 * exact verification body TikTok expects.
 */
import { Router, type IRouter, type Request, type Response } from "express";

const router: IRouter = Router();

export const TIKTOK_SITE_VERIFICATION_TOKEN = "kuNRyNnbQ1VmMSCYfvKT7kqGHbLlaTX7";

export const TIKTOK_SITE_VERIFICATION_BODY =
  `tiktok-developers-site-verification=${TIKTOK_SITE_VERIFICATION_TOKEN}`;

/** Canonical verification paths TikTok may probe. */
export const TIKTOK_VERIFICATION_PATHS = [
  "/tiktok-developers-site-verification.html",
  "/tiktok-developers-site-verification.txt",
  `/tiktok-developers-site-verification-${TIKTOK_SITE_VERIFICATION_TOKEN}.txt`,
  "/tiktok-developers-site-verification",
] as const;

function contentTypeForPath(pathname: string): "text/html" | "text/plain" {
  return pathname.toLowerCase().endsWith(".html") ? "text/html" : "text/plain";
}

function sendVerification(req: Request, res: Response) {
  const pathname = (req.path || req.url || "").split("?")[0] || "";
  const body = TIKTOK_SITE_VERIFICATION_BODY;
  res.statusCode = 200;
  res.setHeader("Content-Type", contentTypeForPath(pathname));
  res.setHeader("Cache-Control", "public, max-age=300");
  res.setHeader("Content-Length", Buffer.byteLength(body, "utf8"));
  res.end(body);
}

const routePaths = TIKTOK_VERIFICATION_PATHS.flatMap((p) => [p, `${p}/`]);

router.get(routePaths, sendVerification);
router.head(routePaths, sendVerification);

export default router;
