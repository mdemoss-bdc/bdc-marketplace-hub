/**
 * TikTok URL Property Verification — plain text file / endpoint at site root.
 * Serves both:
 *   GET /tiktok-developers-site-verification.txt
 *   GET /tiktok-developers-site-verification
 */
import { Router, type IRouter } from "express";

const router: IRouter = Router();

export const TIKTOK_SITE_VERIFICATION_BODY =
  "tiktok-developers-site-verification=kuNRyNnbQ1VmMSCYfvKT7kqGHbLlaTX7";

const PATHS = [
  "/tiktok-developers-site-verification.txt",
  "/tiktok-developers-site-verification.txt/",
  "/tiktok-developers-site-verification",
  "/tiktok-developers-site-verification/",
];

router.get(PATHS, (_req, res) => {
  const body = TIKTOK_SITE_VERIFICATION_BODY;
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.setHeader("Content-Length", Buffer.byteLength(body, "utf8"));
  res.end(body);
});

export default router;
