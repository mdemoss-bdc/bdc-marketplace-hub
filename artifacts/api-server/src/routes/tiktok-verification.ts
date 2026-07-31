/**
 * TikTok Developers domain verification — plain text endpoint.
 * TikTok fetches GET /tiktok-developers-site-verification and expects an
 * exact text/plain body match.
 */
import { Router, type IRouter } from "express";

const router: IRouter = Router();

export const TIKTOK_SITE_VERIFICATION_BODY =
  "tiktok-developers-site-verification=kuNRyNnbQ1VmMSCYfvKT7kqGHbLlaTX7";

router.get(
  ["/tiktok-developers-site-verification", "/tiktok-developers-site-verification/"],
  (_req, res) => {
    const body = TIKTOK_SITE_VERIFICATION_BODY;
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.setHeader("Content-Length", Buffer.byteLength(body, "utf8"));
    res.end(body);
  },
);

export default router;
